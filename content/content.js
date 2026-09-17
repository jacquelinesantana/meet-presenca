/**
 * @file content/content.js
 * @description Script principal injetado em todas as páginas do Google Meet.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * RESPONSABILIDADES
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 1. Detecção de reunião (navTimer, intervalo 1 s):
 *    Monitora window.location.href. Se o código de reunião mudar:
 *    • Entra: loadMeetingState → startHeartbeat → persistState.
 *    • Sai:   finalizeMeeting → persistState → limpa estado.
 *
 * 2. Heartbeat (HEARTBEAT_MS = 5 s):
 *    Chama S.collectParticipants(document) → T.applyTick() → persistState().
 *    Tick coletado mesmo se o painel de participantes estiver fechado (fallback
 *    ao tile grid do Meet).
 *
 * 3. Persistência (chrome.storage.local):
 *    Chaves:
 *      mp_meeting_{code}  → payload da reunião (inclui state completo)
 *      mp_active          → { code, updatedAt } da reunião em andamento
 *      mp_index           → lista resumida das últimas 50 reuniões
 *      mp_settings        → { showBadge: boolean }
 *
 * 4. Badge visual (Shadow DOM, canto inferior esquerdo):
 *    Exibe "Meet Presença • N participante(s)" enquanto a reunião está ativa.
 *    Pode ser ocultado via mp_settings.showBadge = false.
 *
 * 5. Protocolo de mensagens (chrome.runtime.onMessage):
 *    MP_GET_LIVE      → responde com participantes ao vivo (do estado atual).
 *    MP_OPEN_PEOPLE_PANEL → clica no botão de pessoas do Meet.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DEPENDÊNCIAS (carregadas antes por manifest.json)
 * ════════════════════════════════════════════════════════════════════════════
 *
 *   window.MPUtils     (lib/utils.js)      — utilitários puros
 *   window.MP_Selectors (content/selectors.js) — scraping do DOM do Meet
 *   window.MP_Tracker  (content/tracker.js)   — acumulação de tempo
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NOTAS DE MANUTENÇÃO
 * ════════════════════════════════════════════════════════════════════════════
 *
 * • Nunca lançar exceções para o caller — todos os erros são silenciados para
 *   não interferir com o Meet.
 * • O badge usa Shadow DOM para evitar conflitos de CSS com o Meet.
 * • O navTimer (1 s) é separado do heartbeat (5 s) para detectar rápido
 *   a entrada/saída da reunião sem escutar eventos de navegação (SPA do Meet).
 */

(function () {
  'use strict';

  // ─── Dependências ─────────────────────────────────────────────────────────
  const U = window.MPUtils;       // utilitários (utils.js)
  const S = window.MP_Selectors;  // scraping do DOM (selectors.js)
  const T = window.MP_Tracker;    // tracker de tempo (tracker.js)

  // ─── Constantes ───────────────────────────────────────────────────────────

  /** Versão exposta nos payloads de storage para diagnóstico. */
  const APP_VERSION = '1.0.0';

  /** Intervalo do heartbeat: coleta participantes e acumula tempo (ms). */
  const HEARTBEAT_MS = 5000;

  /** Intervalo de verificação de navegação (ms). Detecta entrada/saída do Meet. */
  const NAV_CHECK_MS = 1000;

  /**
   * Tempo máximo (ms) para considerar mp_active "fresco" (reunião em andamento).
   * Se updatedAt for mais antigo que isso, a reunião é tratada como encerrada.
   */
  const ACTIVE_STALE_MS = 15000;

  // ─── Estado do módulo ─────────────────────────────────────────────────────

  /** Código da reunião atual ("abc-defg-hij") ou null fora de reuniões. */
  let currentCode = null;

  /** Estado da reunião atual (objeto do tracker). null fora de reuniões. */
  let state = null;

  /** ID do timer de verificação de navegação (setInterval). */
  let navTimer = null;

  /** ID do timer do heartbeat (setInterval). */
  let heartbeatTimer = null;

  /** Timestamp da última chamada a persistState (ms). */
  let lastPersistMs = 0;

  // ─── Referências do badge (Shadow DOM) ───────────────────────────────────
  let badgeHost = null;
  let badgeShadow = null;
  let badgeEl = null;

  // ─── Wrappers de storage ──────────────────────────────────────────────────

  /** Lê chaves do chrome.storage.local. Retorna {} em caso de erro. */
  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (result) => resolve(result || {}));
      } catch (_err) {
        resolve({});
      }
    });
  }

  /** Grava objeto no chrome.storage.local. Silencia erros. */
  function storageSet(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => resolve());
      } catch (_err) {
        resolve();
      }
    });
  }

  /** Remove chaves do chrome.storage.local. Silencia erros. */
  function storageRemove(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(keys, () => resolve());
      } catch (_err) {
        resolve();
      }
    });
  }

  // ─── Chaves de storage ────────────────────────────────────────────────────

  /**
   * Retorna a chave de storage para o estado de uma reunião específica.
   * Ex.: "mp_meeting_abc-defg-hij"
   * @param {string} code
   * @returns {string}
   */
  function meetingStorageKey(code) {
    return 'mp_meeting_' + code;
  }

  // ─── Payload de reunião ───────────────────────────────────────────────────

  /**
   * Constrói o objeto que é salvo no storage para uma reunião.
   * Inclui metadados resumidos + o estado completo do tracker.
   *
   * @param {object} meetingState  Estado do tracker (MP_Tracker).
   * @param {number} nowMs
   * @returns {object}
   */
  function buildMeetingPayload(meetingState, nowMs) {
    const participants = meetingState && meetingState.participants ? Object.values(meetingState.participants) : [];
    return {
      code: meetingState.code,
      startedAt: meetingState.startedAt,
      lastActivityAt: new Date(nowMs).toISOString(),
      updatedAt: meetingState.updatedAt,
      participantCount: participants.length,
      appVersion: APP_VERSION,
      state: meetingState       // estado completo — usado pelo popup e nas próximas sessões
    };
  }

  // ─── Índice de reuniões ───────────────────────────────────────────────────

  /**
   * Atualiza o índice global de reuniões (mp_index) com a reunião atual.
   * O índice é uma lista das últimas 50 reuniões (mais recente primeiro).
   * Reuniões além de 50 têm seus dados removidos do storage.
   *
   * @param {string} code    Código da reunião.
   * @param {object} payload Payload construído por buildMeetingPayload.
   */
  async function updateIndex(code, payload) {
    const data = await storageGet(['mp_index']);
    const prev = Array.isArray(data.mp_index) ? data.mp_index : [];

    // Remove entrada anterior para a mesma reunião e adiciona no topo
    const filtered = prev.filter((x) => x && x.code !== code);
    filtered.unshift({
      code,
      startedAt: payload.startedAt,
      lastActivityAt: payload.lastActivityAt,
      participantCount: payload.participantCount
    });

    // Limita a 50 entradas; remove dados das mais antigas
    const capped = filtered.slice(0, 50);
    const removed = filtered.slice(50);

    const toRemoveKeys = removed.map((m) => meetingStorageKey(m.code));
    if (toRemoveKeys.length) {
      await storageRemove(toRemoveKeys);
    }

    await storageSet({ mp_index: capped });
  }

  // ─── Persistência ─────────────────────────────────────────────────────────

  /**
   * Salva o estado atual no chrome.storage.local.
   * Chamado pelo heartbeat (a cada 5 s) e em eventos críticos (force=true).
   *
   * Se `force=false` e a última persistência foi há < HEARTBEAT_MS, não persiste
   * (evita escritas excessivas durante o heartbeat normal).
   *
   * @param {boolean} force  Se true, persiste imediatamente mesmo que recente.
   */
  async function persistState(force) {
    try {
      if (!currentCode || !state) return;
      const nowMs = Date.now();
      if (!force && nowMs - lastPersistMs < HEARTBEAT_MS) return;

      const payload = buildMeetingPayload(state, nowMs);
      const key = meetingStorageKey(currentCode);

      await storageSet({
        [key]: payload,
        mp_active: { code: currentCode, updatedAt: payload.lastActivityAt }
      });

      await updateIndex(currentCode, payload);
      lastPersistMs = nowMs;
    } catch (_err) {
      // Nunca interrompe o Meet por erro de storage
    }
  }

  // ─── Carregamento de estado ───────────────────────────────────────────────

  /**
   * Carrega o estado de uma reunião do storage.
   * Se a reunião já foi registrada antes, retoma de onde parou.
   * Caso contrário, cria um estado novo.
   *
   * @param {string} code
   * @returns {Promise<object>}  Estado do tracker.
   */
  async function loadMeetingState(code) {
    const key = meetingStorageKey(code);
    const data = await storageGet([key]);
    const existing = data[key];

    if (existing && existing.state && existing.state.code === code) {
      return existing.state;  // retoma reunião existente
    }

    return T.createMeetingState({ code, startedAt: new Date().toISOString() });
  }

  // ─── Configurações ────────────────────────────────────────────────────────

  /**
   * Lê as configurações do usuário do storage.
   * Se showBadge não estiver definido, inicializa como true e salva.
   *
   * @returns {Promise<{showBadge: boolean}>}
   */
  async function getSettings() {
    const data = await storageGet(['mp_settings']);
    const settings = data.mp_settings || {};
    if (typeof settings.showBadge !== 'boolean') {
      settings.showBadge = true;
      await storageSet({ mp_settings: settings });
    }
    return settings;
  }

  // ─── Badge visual (Shadow DOM) ────────────────────────────────────────────

  /**
   * Cria o host do badge no DOM (se ainda não existe).
   * Usa Shadow DOM para isolamento de CSS do Meet.
   * Posicionado no canto inferior esquerdo, pointer-events=auto para acessibilidade.
   */
  function ensureBadge() {
    if (badgeHost) return;

    badgeHost = document.createElement('div');
    badgeHost.id = 'mp-badge-host';
    badgeHost.style.position = 'fixed';
    badgeHost.style.bottom = '12px';
    badgeHost.style.left = '12px';
    badgeHost.style.zIndex = '2147483646';  // abaixo apenas do z-index máximo
    badgeHost.style.pointerEvents = 'none';

    badgeShadow = badgeHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .badge {
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font: 12px/1.3 Arial, sans-serif;
        color: #fff;
        background: rgba(20, 20, 20, 0.75);
        border-radius: 999px;
        padding: 6px 10px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        user-select: none;
      }
      .dot {
        color: #30d158;
        font-size: 14px;
        line-height: 1;
      }
    `;

    badgeEl = document.createElement('div');
    badgeEl.className = 'badge';
    badgeEl.innerHTML = '<span class="dot">●</span><span id="mp-badge-text">Meet Presença</span>';

    badgeShadow.appendChild(style);
    badgeShadow.appendChild(badgeEl);
    document.documentElement.appendChild(badgeHost);
  }

  /**
   * Remove o badge do DOM e limpa as referências.
   * Chamado ao sair da reunião ou se showBadge=false.
   */
  function removeBadge() {
    if (badgeHost && badgeHost.parentNode) {
      badgeHost.parentNode.removeChild(badgeHost);
    }
    badgeHost = null;
    badgeShadow = null;
    badgeEl = null;
  }

  /**
   * Atualiza o texto do badge com a contagem de participantes presentes.
   * Cria o badge se necessário; remove se showBadge=false ou fora de reunião.
   */
  async function updateBadge() {
    try {
      const settings = await getSettings();
      if (!settings.showBadge || !currentCode || !state) {
        removeBadge();
        return;
      }

      ensureBadge();
      const count = Object.values(state.participants || {}).filter((p) => p.present).length;
      const textEl = badgeShadow.getElementById('mp-badge-text');
      if (textEl) {
        textEl.textContent = 'Meet Presença • ' + count + ' participante(s)';
      }
    } catch (_err) {
      // Silencioso — erro de badge não deve interromper rastreamento
    }
  }

  // ─── Heartbeat ────────────────────────────────────────────────────────────

  /**
   * Executa um tick do heartbeat:
   * 1. Coleta participantes visíveis no DOM via MP_Selectors.
   * 2. Aplica o tick ao estado via MP_Tracker.
   * 3. Persiste o estado (se passaram ≥ HEARTBEAT_MS desde a última persistência).
   * 4. Atualiza o badge.
   */
  function applyHeartbeatTick() {
    try {
      if (!currentCode || !state) return;
      const now = Date.now();
      const data = S.collectParticipants(document);
      state = T.applyTick(state, data.participants, now, { graceTicks: 2, maxDeltaSec: 30 });
      state.updatedAt = new Date(now).toISOString();
      persistState(false);
      updateBadge();
    } catch (_err) {
      // Nunca quebrar o fluxo da página do Meet
    }
  }

  /** Para o timer do heartbeat. */
  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  /**
   * Inicia o timer do heartbeat (HEARTBEAT_MS = 5 s).
   * Para qualquer heartbeat anterior antes de iniciar.
   * Executa um tick imediatamente para não esperar o primeiro intervalo.
   */
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(applyHeartbeatTick, HEARTBEAT_MS);
    applyHeartbeatTick();  // tick imediato
  }

  // ─── Ciclo de vida da reunião ─────────────────────────────────────────────

  /**
   * Entra em uma reunião: carrega estado, persiste e inicia heartbeat.
   * @param {string} code
   */
  async function enterMeeting(code) {
    try {
      currentCode = code;
      state = await loadMeetingState(code);
      await persistState(true);
      await updateBadge();
      startHeartbeat();
    } catch (_err) {
      // Silencioso
    }
  }

  /**
   * Sai da reunião atual: finaliza cronômetros abertos, persiste o estado final
   * e limpa todo o estado do módulo.
   */
  async function leaveMeeting() {
    try {
      if (state) {
        state = T.finalizeMeeting(state, Date.now());
        await persistState(true);
      }
    } catch (_err) {
      // Silencioso
    } finally {
      currentCode = null;
      state = null;
      stopHeartbeat();
      removeBadge();

      // Sinaliza ao popup que não há reunião ativa
      await storageSet({ mp_active: { code: null, updatedAt: new Date().toISOString() } });
    }
  }

  // ─── Verificação de navegação ─────────────────────────────────────────────

  /**
   * Verifica se a URL mudou para uma nova reunião ou saiu de uma reunião.
   * Chamada pelo navTimer a cada NAV_CHECK_MS (1 s).
   *
   * Transições:
   * • null → código   → enterMeeting(código)
   * • código → null   → leaveMeeting()
   * • código → outro  → leaveMeeting() + enterMeeting(outro)
   * • código → código → apenas atualiza badge
   */
  async function handleNavigationCheck() {
    try {
      const nextCode = U.meetingCodeFromUrl(window.location.href);
      if (nextCode && nextCode !== currentCode) {
        if (currentCode) {
          await leaveMeeting();
        }
        await enterMeeting(nextCode);
      } else if (!nextCode && currentCode) {
        await leaveMeeting();
      } else if (nextCode && currentCode === nextCode) {
        await updateBadge();
      }
    } catch (_err) {
      // Silencioso
    }
  }

  // ─── Mensagens do popup ───────────────────────────────────────────────────

  /**
   * Constrói a resposta ao popup para a mensagem MP_GET_LIVE.
   * Retorna { active: false } fora de reuniões.
   * Retorna { active, code, participants[], startedAt } dentro de reuniões.
   *
   * participants[] usa T.getLiveRecord para incluir liveSeconds ao vivo.
   *
   * @returns {object}
   */
  function getLiveParticipantsResponse() {
    if (!currentCode || !state) {
      return { active: false };
    }

    const now = Date.now();
    const participants = Object.values(state.participants || {})
      .map((r) => T.getLiveRecord(r, now))
      .map((r) => ({
        key: r.key,
        name: r.name,
        email: r.email || null,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        liveSeconds: r.liveSeconds,
        sessions: r.sessions,
        present: !!r.present,
        _lastAccrualMs: r._lastAccrualMs || null
      }));

    return {
      active: true,
      code: currentCode,
      participants,
      startedAt: state.startedAt
    };
  }

  /**
   * Instala o listener de mensagens do Chrome para o conteúdo do script.
   *
   * Mensagens suportadas:
   * • MP_GET_LIVE          → { active, code, participants, startedAt }
   * • MP_OPEN_PEOPLE_PANEL → { ok: boolean }
   *
   * Retorna true do listener (assíncrono) para manter sendResponse disponível.
   */
  function installMessageListener() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      (async () => {
        try {
          if (!message || !message.type) {
            sendResponse({ ok: false });
            return;
          }

          if (message.type === 'MP_GET_LIVE') {
            sendResponse(getLiveParticipantsResponse());
            return;
          }

          if (message.type === 'MP_OPEN_PEOPLE_PANEL') {
            // Verifica se o painel já está visível (evita clique desnecessário)
            const alreadyVisible = S.isParticipantsPanelVisible(document);
            if (alreadyVisible) {
              sendResponse({ ok: true });
              return;
            }

            // Clica no botão de pessoas para abrir o painel
            const button = S.findPeoplePanelButton(document);
            if (button && typeof button.click === 'function') {
              button.click();
              sendResponse({ ok: true });
              return;
            }

            sendResponse({ ok: false });
            return;
          }

          sendResponse({ ok: false });
        } catch (_err) {
          sendResponse({ ok: false });
        }
      })();

      return true;  // mantém sendResponse disponível para a promise acima
    });
  }

  // ─── Handlers de ciclo de vida da página ─────────────────────────────────

  /**
   * Instala listeners para encerrar a reunião quando a página for fechada
   * ou oculta (aba em background).
   *
   * • pagehide: página vai ser destruída (navegação, fechamento da aba).
   * • visibilitychange: detecta aba indo para background (possível suspend).
   *
   * Ambos chamam finalizeMeeting + persistState (síncrono via fire-and-forget),
   * pois o service worker pode não estar disponível nesses momentos.
   */
  function installLifecycleHandlers() {
    window.addEventListener('pagehide', () => {
      if (!state) return;
      try {
        state = T.finalizeMeeting(state, Date.now());
        persistState(true);  // fire-and-forget (não await em handler síncrono)
      } catch (_err) {
        // Silencioso
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden' || !state) return;
      try {
        state = T.finalizeMeeting(state, Date.now());
        persistState(true);
      } catch (_err) {
        // Silencioso
      }
    });
  }

  // ─── Inicialização ────────────────────────────────────────────────────────

  /**
   * Ponto de entrada do content script.
   * Instala listeners e inicia o timer de verificação de navegação.
   */
  function start() {
    try {
      installMessageListener();
      installLifecycleHandlers();
      navTimer = setInterval(handleNavigationCheck, NAV_CHECK_MS);
      handleNavigationCheck();  // verifica imediatamente (não espera 1 s)
    } catch (_err) {
      // Silencioso — nunca impedir o carregamento da página
    }
  }

  start();
})();
