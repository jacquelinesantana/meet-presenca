/**
 * @file content/tracker.js
 * @description Módulo de rastreamento de tempo de permanência de participantes.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * MODELO DE ACUMULAÇÃO
 * ════════════════════════════════════════════════════════════════════════════
 *
 * O conteúdo do Meet é escaneado a cada HEARTBEAT_MS (5 s) por content.js.
 * A cada tick, este módulo recebe uma lista de participantes "vistos" e
 * atualiza o estado da reunião:
 *
 *   Participante VISTO no tick:
 *     • Se present=true  → acumula delta = now − _lastAccrualMs (clamped).
 *     • Se present=false → voltou: sessions++, present=true.
 *     • missCount = 0.
 *
 *   Participante NÃO VISTO no tick:
 *     • missCount++ (tolerância = graceTicks, padrão 2 ticks ≈ 10 s).
 *     • Se missCount > graceTicks → present=false (cronômetro para).
 *
 * graceTicks existe para absorver flicker do DOM do Meet (o painel de
 * participantes pode fechar momentaneamente).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * PROTEÇÃO CONTRA SUPERCONTAGEM
 * ════════════════════════════════════════════════════════════════════════════
 *
 * O delta de cada tick é limitado a maxDeltaSec (padrão 30 s).
 * Isso previne supercontagem quando a aba fica suspensa (laptop fecha,
 * computador dorme) e o próximo tick tem delta muito grande.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SESSÕES
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `sessions` conta quantas vezes o participante entrou/voltou.
 * `accumulatedSec` é a soma contínua de todas as sessões.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * FUNÇÕES EXPORTADAS
 * ════════════════════════════════════════════════════════════════════════════
 *
 *   createMeetingState(input)            Cria estado vazio de uma reunião.
 *   applyTick(state, seen, now, opts)    Processa um tick de observação.
 *   finalizeMeeting(state, now)          Fecha cronômetros ao encerrar.
 *   getLiveRecord(record, now)           Clone com liveSeconds ao vivo.
 *
 * Expõe global.MP_Tracker e module.exports (Node.js para testes).
 */

(function (global) {
  'use strict';

  // ─── Utilitários internos ─────────────────────────────────────────────────

  /**
   * Converte timestamp ms para string ISO 8601.
   * @param {number} ms
   * @returns {string}
   */
  function toIso(ms) {
    return new Date(ms).toISOString();
  }

  /**
   * Converte um delta em ms para segundos, aplicando o teto maxDeltaSec.
   * Retorna 0 para valores inválidos, zero ou negativos.
   *
   * @param {number} deltaMs    Diferença em ms desde o último accrual.
   * @param {number} maxDeltaSec  Teto máximo (ex.: 30 s para anti-supercontagem).
   * @returns {number}  Segundos a acumular (≥ 0).
   */
  function clampDeltaSec(deltaMs, maxDeltaSec) {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 0;
    const raw = deltaMs / 1000;
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.min(raw, maxDeltaSec);
  }

  /**
   * Valida e retorna `nowMs` como número finito ≥ 0.
   * Fallback para Date.now() se o valor for inválido.
   *
   * @param {number} nowMs
   * @returns {number}
   */
  function safeNowMs(nowMs) {
    const n = Number(nowMs);
    if (!Number.isFinite(n) || n < 0) return Date.now();
    return n;
  }

  // ─── API pública ──────────────────────────────────────────────────────────

  /**
   * Cria um estado de reunião vazio (sem participantes).
   *
   * Estrutura do objeto estado:
   * ```js
   * {
   *   code: string,           // código "abc-defg-hij"
   *   startedAt: string,      // ISO da primeira entrada
   *   updatedAt: string,      // ISO da última modificação
   *   tickCount: number,      // total de ticks processados
   *   participants: {         // mapa key → Record
   *     [key: string]: Record
   *   },
   *   _lastTickAtMs: number   // timestamp do último tick
   * }
   * ```
   *
   * Estrutura de um Record (criado em ensureRecord):
   * ```js
   * {
   *   key: string,            // data-participant-id ou "name:nomeNormalizado"
   *   name: string,
   *   email: string|null,
   *   firstSeenAt: string,    // ISO da primeira aparição
   *   lastSeenAt: string,     // ISO da última aparição
   *   accumulatedSec: number, // segundos acumulados (todas as sessões)
   *   sessions: number,       // número de entradas/retornos
   *   missCount: number,      // ticks consecutivos sem aparecer (reset ao aparecer)
   *   present: boolean,       // true = cronômetro ativo
   *   _openSinceMs: number|null,
   *   _lastAccrualMs: number  // base do próximo cálculo de delta
   * }
   * ```
   *
   * @param {{code?:string, startedAt?:string}} input
   * @returns {object}  Estado inicial da reunião.
   */
  function createMeetingState(input) {
    const code = input && input.code ? String(input.code) : '';
    const startedMs = input && input.startedAt ? new Date(input.startedAt).getTime() : Date.now();
    const started = Number.isFinite(startedMs) ? startedMs : Date.now();

    return {
      code,
      startedAt: toIso(started),
      updatedAt: toIso(started),
      tickCount: 0,
      participants: {},
      _lastTickAtMs: started
    };
  }

  /**
   * Garante que o estado contém um Record para `participant.key`.
   * • Se o Record já existe: atualiza nome/email se fornecidos.
   * • Se não existe: cria com todos os campos inicializados.
   *
   * @param {object} state          Estado da reunião (mutado in-place).
   * @param {{key:string, name?:string, email?:string}} participant
   * @param {number} nowMs
   * @returns {object|null}  O Record criado/existente, ou null se key inválida.
   */
  function ensureRecord(state, participant, nowMs) {
    const key = String(participant.key || '').trim();
    if (!key) return null;

    const maybeExisting = state.participants[key];
    const nextName = String(participant.name || '').trim();
    const nextEmail = participant.email ? String(participant.email).trim() : '';

    if (maybeExisting) {
      // Atualiza nome/email se o Meet revelar informação mais recente
      if (nextName) maybeExisting.name = nextName;
      if (nextEmail) maybeExisting.email = nextEmail;
      return maybeExisting;
    }

    const nowIso = toIso(nowMs);
    const record = {
      key,
      name: nextName,
      email: nextEmail || null,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      accumulatedSec: 0,
      sessions: 1,       // primeira entrada já conta como 1 sessão
      missCount: 0,
      present: true,
      _openSinceMs: nowMs,
      _lastAccrualMs: nowMs
    };

    state.participants[key] = record;
    return record;
  }

  /**
   * Processa um tick de observação: atualiza tempos, sessões e flags de presença.
   *
   * PARA MODIFICAR COMPORTAMENTO:
   * • graceTicks: número de ticks de tolerância antes de marcar ausente (padrão 2).
   * • maxDeltaSec: teto de acumulação por tick para prevenir supercontagem (padrão 30 s).
   * Ambos podem ser passados via `options`.
   *
   * @param {object} state
   *   Estado atual da reunião. Mutado in-place E retornado.
   * @param {Array<{key:string, name?:string, email?:string}>} seenParticipants
   *   Lista de participantes vistos neste tick (de selectors.collectParticipants).
   * @param {number} nowMs   Timestamp do tick (Date.now()).
   * @param {{graceTicks?:number, maxDeltaSec?:number}} [options]
   * @returns {object}  O estado atualizado.
   */
  function applyTick(state, seenParticipants, nowMs, options) {
    const nextState = state || createMeetingState({ code: '', startedAt: new Date().toISOString() });
    const now = safeNowMs(nowMs);

    const config = Object.assign({ graceTicks: 2, maxDeltaSec: 30 }, options || {});
    const graceTicks = Number.isFinite(config.graceTicks) ? Math.max(0, Math.floor(config.graceTicks)) : 2;
    const maxDeltaSec = Number.isFinite(config.maxDeltaSec) ? Math.max(1, config.maxDeltaSec) : 30;

    const input = Array.isArray(seenParticipants) ? seenParticipants : [];
    const seenKeys = new Set();

    nextState.tickCount = (nextState.tickCount || 0) + 1;

    // ── Participantes vistos neste tick ──────────────────────────────────
    for (const p of input) {
      if (!p || !p.key) continue;
      const record = ensureRecord(nextState, p, now);
      if (!record) continue;

      seenKeys.add(record.key);

      if (record.present) {
        // Acumula o delta desde o último accrual (limitado por maxDeltaSec)
        const lastAccrualMs = record._lastAccrualMs == null ? now : Number(record._lastAccrualMs);
        const deltaMs = now - lastAccrualMs;
        const deltaSec = clampDeltaSec(deltaMs, maxDeltaSec);
        if (deltaSec > 0) {
          record.accumulatedSec += deltaSec;
        }
      } else {
        // Participante havia saído e voltou: abre nova sessão
        record.sessions += 1;
        record.present = true;
        record._openSinceMs = now;
      }

      record.missCount = 0;
      record.lastSeenAt = toIso(now);
      record._lastAccrualMs = now;

      // Atualiza nome/email se o Meet fornecer dados mais recentes
      if (p.name && String(p.name).trim()) {
        record.name = String(p.name).trim();
      }
      if (p.email && String(p.email).trim()) {
        record.email = String(p.email).trim();
      }
    }

    // ── Participantes NÃO vistos neste tick ──────────────────────────────
    for (const key of Object.keys(nextState.participants)) {
      if (seenKeys.has(key)) continue;

      const record = nextState.participants[key];
      record.missCount = (record.missCount || 0) + 1;

      if (record.present && record.missCount > graceTicks) {
        // Tolerância esgotada: marca ausente e para o cronômetro
        record.present = false;
        record._openSinceMs = null;
        record._lastAccrualMs = new Date(record.lastSeenAt).getTime();
      }
    }

    nextState._lastTickAtMs = now;
    nextState.updatedAt = toIso(now);

    return nextState;
  }

  /**
   * Fecha todos os cronômetros abertos (present=true) ao encerrar a reunião.
   * Chamado por content.js em: pagehide, visibilitychange='hidden', leaveMeeting.
   *
   * Acumula o delta restante desde o último accrual ATÉ lastSeenAt (não até now),
   * para não contar tempo em que o participante não foi observado.
   *
   * @param {object} state
   * @param {number} nowMs
   * @returns {object}
   */
  function finalizeMeeting(state, nowMs) {
    const nextState = state || createMeetingState({ code: '', startedAt: new Date().toISOString() });
    const now = safeNowMs(nowMs);

    for (const key of Object.keys(nextState.participants)) {
      const record = nextState.participants[key];
      if (!record.present) continue;

      const lastSeenMs = new Date(record.lastSeenAt).getTime();
      const accrualMs = record._lastAccrualMs == null ? lastSeenMs : Number(record._lastAccrualMs);
      const deltaSec = clampDeltaSec(lastSeenMs - accrualMs, 30);
      if (deltaSec > 0) {
        record.accumulatedSec += deltaSec;
      }

      record.present = false;
      record._openSinceMs = null;
      record._lastAccrualMs = lastSeenMs;
    }

    nextState.updatedAt = toIso(now);
    nextState._lastTickAtMs = now;
    return nextState;
  }

  /**
   * Retorna um clone do Record com o campo `liveSeconds` calculado no instante `nowMs`.
   * Se present=true, adiciona delta = now − _lastAccrualMs ao accumulatedSec.
   *
   * NÃO modifica o estado original — retorna clone para exibição no popup.
   *
   * @param {object} record  Um Record de participante (state.participants[key]).
   * @param {number} nowMs
   * @returns {object|null}
   */
  function getLiveRecord(record, nowMs) {
    if (!record) return null;

    const now = safeNowMs(nowMs);
    const clone = Object.assign({}, record);

    let liveSeconds = Number(clone.accumulatedSec || 0);
    if (clone.present) {
      const fromMs = clone._lastAccrualMs == null ? now : Number(clone._lastAccrualMs);
      const deltaSec = clampDeltaSec(now - fromMs, 30);
      if (deltaSec > 0) {
        liveSeconds += deltaSec;
      }
    }

    clone.liveSeconds = liveSeconds;
    return clone;
  }

  // ─── Exportação ───────────────────────────────────────────────────────────

  const exportsObject = {
    createMeetingState,
    applyTick,
    finalizeMeeting,
    getLiveRecord
  };

  global.MP_Tracker = exportsObject;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObject;
  }
})(typeof window !== 'undefined' ? window : globalThis);
