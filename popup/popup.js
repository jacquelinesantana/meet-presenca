// =============================================================================
// popup/popup.js — Interface do popup da extensão Meet Presença
// =============================================================================
//
// ## Responsabilidade
//   Controlar toda a interface de usuário do popup da extensão: exibir a
//   lista de participantes, gerenciar arquivos de turma (e-mails), exportar
//   dados e comunicar-se com o content script e o service worker.
//
// ## Arquitetura de dados (fluxo de informação)
//   chrome.storage.local → refresh() → cache → renderTable()
//   chrome.tabs (content) → fetchLiveRowsIfActive() → cache.liveRows
//
//   O `cache` é o estado local do popup. Toda exibição usa o cache;
//   persistência vai para o storage via storageSet().
//
// ## Fontes de dados para participantes
//   1. cache.selectedMeeting.state.participants — dados gravados no storage
//      (fonte principal para reuniões passadas)
//   2. cache.liveRows — dados ao vivo do content script via MP_GET_LIVE
//      (usados apenas quando a reunião está ativa e o popup está aberto)
//   3. enrichRowsWithEmails() — aplica o arquivo de turma selecionado para
//      completar e-mails que não foram capturados do DOM
//
// ## Protocolo de mensagens
//   MP_GET_TAB  : popup → background.js → { tabId }
//   MP_GET_LIVE : popup → content.js (via tabId) → { participants[], ... }
//   MP_OPEN_PEOPLE_PANEL : popup → content.js → { ok }
//
// ## Chaves de storage utilizadas (ver STORAGE_KEYS)
//   mp_index              — índice de reuniões salvas
//   mp_active             — reunião ativa no momento
//   mp_meeting_{code}     — dados de uma reunião específica
//   mp_email_maps_v2      — array de arquivos de turma salvos
//   mp_active_email_map_id — ID do arquivo de turma selecionado
//   mp_min_dwell_minutes  — filtro de tempo mínimo de permanência
//   mp_email_map          — (legado v1.x) arquivo de turma único
//
// ## Mesclagem de sessões (v1.7.0)
//   getSelectedRows() → enrichRowsWithEmails() → mergeParticipantRows()
//   Registros da mesma pessoa (ex.: saiu e voltou com um novo ID do Meet)
//   são somados por identidade (e-mail, ou nome quando não há e-mail) ANTES
//   do filtro de tempo mínimo. Assim: (1) quem saiu e voltou tem as duas
//   permanências somadas; (2) quem saiu de vez mas já tinha tempo suficiente
//   continua sendo contabilizado.
//
// ## Exportações CSV (v1.6.0)
//   Formato: Nome;E-mail;Data
//   - Participantes com e-mail aparecem primeiro (um por e-mail)
//   - Participantes sem e-mail aparecem depois (um por nome)
//   - Todos os participantes que atendem ao filtro de tempo mínimo (já com
//     tempos somados) são incluídos; e-mail vazio para quem não foi vinculado
//
// =============================================================================

(function () {
  'use strict';

  /** @type {import('../lib/utils.js').MPUtils} */
  const U = window.MPUtils;

  /**
   * Tempo em ms após o qual considera-se que o registro de reunião ativa
   * no storage ficou desatualizado (content script parou de gravar).
   * @type {number}
   */
  const ACTIVE_STALE_MS = 15000;

  /**
   * Chaves do chrome.storage.local usadas por este popup.
   * Centralizadas aqui para facilitar manutenção e testes.
   * @type {Object<string, string>}
   */
  const STORAGE_KEYS = {
    index: 'mp_index',
    active: 'mp_active',
    emailMapLegacy: 'mp_email_map',        // chave legado v1.x (migrada automaticamente)
    emailMaps: 'mp_email_maps_v2',         // array de arquivos de turma (v2)
    activeEmailMapId: 'mp_active_email_map_id',
    minDwellMinutes: 'mp_min_dwell_minutes'
  };

  /** Número máximo de arquivos de turma que podem ser salvos. @type {number} */
  const MAX_SAVED_EMAIL_MAPS = 30;

  // ---------------------------------------------------------------------------
  // Referências aos elementos DOM do popup.html
  // ---------------------------------------------------------------------------

  /**
   * Mapa de referências a elementos DOM do popup.
   * Inicializado uma vez na carga — elementos devem existir no HTML.
   */
  const els = {
    statusLine: document.getElementById('statusLine'),
    meetingSelect: document.getElementById('meetingSelect'),
    startInfo: document.getElementById('startInfo'),
    minDwellInput: document.getElementById('minDwellInput'),
    filterInfo: document.getElementById('filterInfo'),
    rosterSelect: document.getElementById('rosterSelect'),
    participantsBody: document.getElementById('participantsBody'),
    btnExportCsv: document.getElementById('btnExportCsv'),
    btnExportJson: document.getElementById('btnExportJson'),
    btnImport: document.getElementById('btnImport'),
    btnApplyRoster: document.getElementById('btnApplyRoster'),
    btnDeleteRoster: document.getElementById('btnDeleteRoster'),
    btnOpenPanel: document.getElementById('btnOpenPanel'),
    btnClearMeeting: document.getElementById('btnClearMeeting'),
    fileInput: document.getElementById('fileInput'),
    feedback: document.getElementById('feedback')
  };

  // ---------------------------------------------------------------------------
  // Estado do popup (cache local)
  // ---------------------------------------------------------------------------

  /**
   * Estado centralizado do popup. Toda leitura de dados para exibição usa
   * este objeto; nunca acesse o storage diretamente nas funções de render.
   *
   * @type {{
   *   index: object[],
   *   selectedCode: string|null,
   *   selectedMeeting: object|null,
   *   active: object|null,
   *   emailMaps: object[],
   *   activeEmailMapId: string|null,
   *   liveRows: object[]|null,
   *   minDwellMinutes: number
   * }}
   */
  let cache = {
    index: [],              // lista de reuniões salvas (do mp_index)
    selectedCode: null,     // código da reunião selecionada no dropdown
    selectedMeeting: null,  // objeto completo da reunião selecionada
    active: null,           // registro de reunião ativa (mp_active)
    emailMaps: [],          // array de arquivos de turma (mp_email_maps_v2)
    activeEmailMapId: null, // ID do arquivo selecionado no rosterSelect
    liveRows: null,         // dados ao vivo do content script
    minDwellMinutes: 0      // filtro de tempo mínimo (mp_min_dwell_minutes)
  };

  // ---------------------------------------------------------------------------
  // Wrappers de storage (retornam Promise)
  // ---------------------------------------------------------------------------

  /**
   * Lê valores do chrome.storage.local.
   * @param {string|string[]} keys - Chave ou array de chaves a ler.
   * @returns {Promise<object>} Objeto com os valores lidos.
   */
  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => resolve(result || {}));
    });
  }

  /**
   * Grava valores no chrome.storage.local.
   * @param {object} obj - Objeto com pares chave-valor a persistir.
   * @returns {Promise<void>}
   */
  function storageSet(obj) {
    return new Promise((resolve) => {
      chrome.storage.local.set(obj, () => resolve());
    });
  }

  /**
   * Remove chaves do chrome.storage.local.
   * @param {string|string[]} keys - Chave ou array de chaves a remover.
   * @returns {Promise<void>}
   */
  function storageRemove(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(keys, () => resolve());
    });
  }

  // ---------------------------------------------------------------------------
  // Utilitários gerais
  // ---------------------------------------------------------------------------

  /**
   * Retorna a chave de storage para os dados de uma reunião específica.
   * @param {string} code - Código da reunião (ex.: "abc-defg-hij").
   * @returns {string} Chave do storage (ex.: "mp_meeting_abc-defg-hij").
   */
  function meetingKey(code) {
    return 'mp_meeting_' + code;
  }

  /**
   * Gera um sufixo de timestamp para nomes de arquivo de exportação.
   * Formato: `YYYY-MM-DD_HHmm`.
   * @returns {string} Timestamp formatado para uso em nome de arquivo.
   */
  function nowFilenameStamp() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}_${hh}${mi}`;
  }

  /**
   * Exibe uma mensagem de feedback no elemento #feedback.
   * @param {string} msg - Texto da mensagem.
   * @param {boolean} [isError=false] - Se `true`, exibe em vermelho (erro).
   */
  function setFeedback(msg, isError) {
    els.feedback.textContent = msg || '';
    els.feedback.style.color = isError ? '#9d1c1c' : '#1f5a9a';
  }

  // ---------------------------------------------------------------------------
  // Render: barra de status
  // ---------------------------------------------------------------------------

  /**
   * Atualiza a linha de status no topo do popup indicando se há reunião ativa.
   *
   * Critério de "fresh": o registro `mp_active` foi atualizado nos últimos
   * ACTIVE_STALE_MS ms — indica que o content script ainda está em execução.
   */
  function renderStatusLine() {
    const active = cache.active;
    const fresh =
      active &&
      active.code &&
      active.updatedAt &&
      Date.now() - new Date(active.updatedAt).getTime() < ACTIVE_STALE_MS;

    if (fresh) {
      els.statusLine.innerHTML = `<span class="dot">●</span> Capturando — reunião ${active.code}`;
      return;
    }

    if (cache.index.length > 0) {
      els.statusLine.textContent = 'Última reunião: ' + cache.index[0].code;
      return;
    }

    els.statusLine.textContent = 'Sem reunião ativa';
  }

  // ---------------------------------------------------------------------------
  // Render: dropdown de reuniões
  // ---------------------------------------------------------------------------

  /**
   * Formata o texto de uma opção no dropdown de reuniões.
   * Formato: `{code} • {data/hora início} • {N} pessoas`.
   *
   * @param {{ code: string, startedAt: string, participantCount?: number }} item
   *   Item do índice de reuniões.
   * @returns {string} Label formatado para exibição.
   */
  function optionLabel(item) {
    const dt = U.formatDateTimeBR(item.startedAt).slice(0, 16);
    return `${item.code} • ${dt} • ${item.participantCount || 0} pessoas`;
  }

  /**
   * Renderiza o dropdown de seleção de reunião com todas as reuniões salvas.
   * Seleciona automaticamente a reunião ativa (se houver) ou a mais recente.
   */
  function renderMeetingSelect() {
    const select = els.meetingSelect;
    select.innerHTML = '';

    if (!cache.index.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Nenhuma reunião salva';
      select.appendChild(opt);
      select.disabled = true;
      return;
    }

    select.disabled = false;
    // Preferência: código já selecionado > reunião ativa > mais recente
    const preferred =
      cache.selectedCode ||
      (cache.active && cache.active.code) ||
      cache.index[0].code;

    for (const item of cache.index) {
      const opt = document.createElement('option');
      opt.value = item.code;
      opt.textContent = optionLabel(item);
      if (item.code === preferred) opt.selected = true;
      select.appendChild(opt);
    }

    cache.selectedCode = select.value;
  }

  // ---------------------------------------------------------------------------
  // Gerenciamento de nomes de arquivos de turma
  // ---------------------------------------------------------------------------

  /**
   * Limpa e trunca o nome de um arquivo de turma para exibição segura.
   * Remove espaços extras e limita a 80 caracteres.
   *
   * @param {string} name - Nome digitado pelo usuário.
   * @returns {string} Nome normalizado.
   */
  function normalizeEmailMapName(name) {
    const cleaned = String(name || '').trim().replace(/\s+/g, ' ');
    return cleaned.slice(0, 80);
  }

  /**
   * Gera um ID único para um novo arquivo de turma.
   * Baseado em timestamp + sufixo aleatório para evitar colisões.
   *
   * @returns {string} ID único no formato "map_{timestamp}_{random}".
   */
  function generateEmailMapId() {
    return 'map_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ---------------------------------------------------------------------------
  // Render: dropdown de arquivos de turma
  // ---------------------------------------------------------------------------

  /**
   * Renderiza o dropdown de seleção de arquivo de turma (roster).
   * Exibe nome e contagem de entradas de cada arquivo salvo.
   */
  function renderRosterSelect() {
    const select = els.rosterSelect;
    select.innerHTML = '';

    if (!cache.emailMaps.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Nenhum arquivo salvo';
      select.appendChild(opt);
      select.disabled = true;
      cache.activeEmailMapId = null;
      return;
    }

    select.disabled = false;
    const preferredId =
      cache.activeEmailMapId && cache.emailMaps.some((m) => m.id === cache.activeEmailMapId)
        ? cache.activeEmailMapId
        : cache.emailMaps[0].id;

    for (const map of cache.emailMaps) {
      const opt = document.createElement('option');
      opt.value = map.id;
      const count = Array.isArray(map.entries) ? map.entries.length : 0;
      opt.textContent = `${map.name} • ${count} e-mail(s)`;
      if (map.id === preferredId) opt.selected = true;
      select.appendChild(opt);
    }

    cache.activeEmailMapId = select.value;
  }

  /**
   * Retorna o arquivo de turma atualmente selecionado no dropdown.
   * @returns {object|null} Objeto do arquivo de turma, ou `null` se nenhum.
   */
  function getSelectedEmailMap() {
    if (!cache.activeEmailMapId) return null;
    return cache.emailMaps.find((m) => m.id === cache.activeEmailMapId) || null;
  }

  // ---------------------------------------------------------------------------
  // Cálculo de tempo ao vivo
  // ---------------------------------------------------------------------------

  /**
   * Calcula o tempo de permanência atual de um participante, incluindo
   * o tempo acumulado no registro e o delta ao vivo (se ainda presente).
   *
   * O delta ao vivo é limitado a 30 segundos para evitar acumulação excessiva
   * em casos de content script parado ou lag de comunicação.
   *
   * @param {object} record - Registro de participante do storage.
   * @param {number} [record.accumulatedSec] - Segundos acumulados (storage).
   * @param {number} [record.liveSeconds] - Alias de accumulatedSec (content).
   * @param {boolean} [record.present] - Se o participante está presente agora.
   * @param {number} [record._lastAccrualMs] - Timestamp do último tick (ms).
   * @returns {number} Total de segundos de permanência.
   */
  function computeLiveSeconds(record) {
    if (!record) return 0;
    let sec = Number(record.accumulatedSec || record.liveSeconds || 0);
    if (record.present && record._lastAccrualMs) {
      const delta = Math.max(0, Math.floor((Date.now() - Number(record._lastAccrualMs)) / 1000));
      sec += Math.min(delta, 30);
    }
    return sec;
  }

  // ---------------------------------------------------------------------------
  // Conversão de registros para linhas de tabela
  // ---------------------------------------------------------------------------

  /**
   * Converte os participantes do storage de uma reunião em linhas de tabela.
   * Usado para reuniões passadas ou quando não há dados ao vivo.
   *
   * @param {object|null} meeting - Objeto de reunião do storage.
   * @returns {object[]} Array de linhas de tabela normalizadas.
   */
  function participantRowsFromMeeting(meeting) {
    if (!meeting || !meeting.state || !meeting.state.participants) return [];

    return Object.values(meeting.state.participants).map((r) => ({
      key: r.key,
      name: r.name || '',
      email: r.email || null,
      firstSeenAt: r.firstSeenAt || null,
      lastSeenAt: r.lastSeenAt || null,
      sessions: Number(r.sessions || 0),
      present: !!r.present,
      totalSeconds: computeLiveSeconds(r)
    }));
  }

  /**
   * Converte dados ao vivo recebidos do content script em linhas de tabela.
   * Inclui cálculo de delta ao vivo para participantes presentes.
   *
   * @param {object|null} live - Resposta da mensagem MP_GET_LIVE.
   * @returns {object[]} Array de linhas de tabela normalizadas.
   */
  function participantRowsFromLive(live) {
    if (!live || !Array.isArray(live.participants)) return [];

    return live.participants.map((r) => {
      let total = Number(r.liveSeconds || 0);
      if (r.present && r._lastAccrualMs) {
        const delta = Math.max(0, Math.floor((Date.now() - Number(r._lastAccrualMs)) / 1000));
        total += Math.min(delta, 30);
      }

      return {
        key: r.key,
        name: r.name || '',
        email: r.email || null,
        firstSeenAt: r.firstSeenAt || null,
        lastSeenAt: r.lastSeenAt || null,
        sessions: Number(r.sessions || 0),
        present: !!r.present,
        totalSeconds: total
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Enriquecimento com e-mails
  // ---------------------------------------------------------------------------

  /**
   * Enriquece as linhas de participantes com e-mails de duas fontes:
   * 1. E-mails já persistidos no storage da reunião (por chave de participante)
   * 2. Arquivo de turma selecionado (por correspondência de nome, com fuzzy matching)
   *
   * Esta função é usada tanto para exibição na tabela quanto para exportação.
   * Não sobrescreve e-mails já preenchidos.
   *
   * @param {object[]} rows - Linhas de participantes sem e-mail completo.
   * @returns {object[]} Linhas com e-mails preenchidos onde possível.
   */
  function enrichRowsWithEmails(rows) {
    if (!Array.isArray(rows) || !rows.length) return rows;

    let result = rows;

    // Fonte 1: e-mails persistidos no storage (por chave exata do participante)
    const meeting = cache.selectedMeeting;
    if (meeting && meeting.state && meeting.state.participants) {
      const byKey = meeting.state.participants;
      result = result.map((r) => {
        if (r.email) return r; // já tem e-mail, não sobrescreve
        const stored = byKey[r.key];
        if (stored && stored.email) {
          return Object.assign({}, r, { email: stored.email });
        }
        return r;
      });
    }

    // Fonte 2: arquivo de turma selecionado (fuzzy matching por nome)
    const selectedMap = getSelectedEmailMap();
    if (selectedMap && Array.isArray(selectedMap.entries) && selectedMap.entries.length) {
      const lookup = U.buildEmailLookup(selectedMap.entries);
      const merged = U.applyEmailMap(result, lookup);
      result = merged.participants;
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Mesclagem de registros da mesma pessoa (múltiplas entradas/saídas)
  // ---------------------------------------------------------------------------
  //
  // CORREÇÃO: o Google Meet pode atribuir um novo data-participant-id quando
  // alguém sai e volta à chamada (reconexão real, não apenas flicker de DOM,
  // que já é absorvido pelo graceTicks do tracker.js). Isso fazia o content
  // script criar um SEGUNDO registro para a mesma pessoa, com o cronômetro
  // zerado. O efeito colateral era duplo:
  //   1. O tempo de cada sessão ficava separado, então o filtro de tempo
  //      mínimo podia excluir a pessoa mesmo que a SOMA das sessões batesse
  //      o mínimo exigido.
  //   2. Uma pessoa que saiu de vez, mas cumpriu o tempo mínimo antes de
  //      sair, podia acabar sem ser contabilizada se a última sessão restante
  //      (curta) fosse avaliada isoladamente.
  //
  // A correção junta, por identidade (e-mail normalizado; ou nome normalizado
  // quando não há e-mail), todos os registros da mesma reunião e SOMA os
  // tempos (`totalSeconds`) e o número de sessões, antes de qualquer filtro
  // de tempo mínimo ser aplicado. Isso garante:
  //   • Quem saiu e voltou: as duas (ou mais) permanências são somadas.
  //   • Quem saiu definitivamente: o tempo acumulado até a saída continua
  //     contando normalmente para o filtro de presença mínima.

  /**
   * Calcula a chave de identidade de uma linha de participante, usada para
   * unir registros que pertencem à mesma pessoa mas vieram de sessões
   * diferentes (ex.: saiu e voltou com um novo data-participant-id).
   *
   * Prioriza e-mail (mais confiável); usa nome normalizado como fallback.
   *
   * @param {{name?:string, email?:string|null}} row
   * @returns {string} Chave de identidade ("email:..." ou "name:...").
   */
  function participantIdentityKey(row) {
    const email = row && row.email ? String(row.email).trim().toLowerCase() : '';
    if (email) return 'email:' + email;
    const name = row && row.name ? U.normalizeName(row.name) : '';
    return 'name:' + name;
  }

  /**
   * Junta linhas de participante que pertencem à mesma pessoa (mesma chave
   * de identidade) somando o tempo de permanência e o número de sessões.
   *
   * Mantém a primeira entrada (`firstSeenAt`) mais antiga e a última saída
   * (`lastSeenAt`) mais recente entre os registros unidos. `present` vira
   * `true` se QUALQUER um dos registros ainda estiver ativo.
   *
   * Linhas sem nome e sem e-mail (identidade vazia) não são mescladas entre
   * si, para não juntar por engano registros de ruído não identificados.
   *
   * @param {object[]} rows - Linhas já enriquecidas com e-mail (ver enrichRowsWithEmails).
   * @returns {object[]} Linhas únicas por pessoa, com tempos somados.
   */
  function mergeParticipantRows(rows) {
    if (!Array.isArray(rows) || rows.length <= 1) return rows || [];

    const merged = new Map();
    let anonymousCounter = 0;

    for (const row of rows) {
      let idKey = participantIdentityKey(row);
      // Evita juntar múltiplos registros "sem nome e sem e-mail" entre si
      if (idKey === 'name:') {
        anonymousCounter += 1;
        idKey = 'anon:' + row.key + ':' + anonymousCounter;
      }

      const existing = merged.get(idKey);
      if (!existing) {
        merged.set(idKey, Object.assign({}, row));
        continue;
      }

      // Soma tempo e sessões das diferentes permanências da mesma pessoa
      existing.totalSeconds = Number(existing.totalSeconds || 0) + Number(row.totalSeconds || 0);
      existing.sessions = Number(existing.sessions || 0) + Number(row.sessions || 0);
      existing.present = !!existing.present || !!row.present;

      // Mantém a janela de tempo total (primeira entrada → última saída)
      if (row.firstSeenAt && (!existing.firstSeenAt || new Date(row.firstSeenAt) < new Date(existing.firstSeenAt))) {
        existing.firstSeenAt = row.firstSeenAt;
      }
      if (row.lastSeenAt && (!existing.lastSeenAt || new Date(row.lastSeenAt) > new Date(existing.lastSeenAt))) {
        existing.lastSeenAt = row.lastSeenAt;
      }

      // Preenche e-mail se um dos registros tiver e o outro não
      if (!existing.email && row.email) existing.email = row.email;
      // Mantém o nome mais completo (geralmente o mais longo)
      if (row.name && row.name.length > (existing.name || '').length) existing.name = row.name;
    }

    return Array.from(merged.values());
  }

  // ---------------------------------------------------------------------------
  // Obtenção das linhas selecionadas (fonte unificada)
  // ---------------------------------------------------------------------------

  /**
   * Retorna as linhas de participantes para a reunião selecionada, com
   * e-mails enriquecidos e registros da mesma pessoa já somados (ver
   * mergeParticipantRows). Todo o restante do popup (tabela, filtro de
   * tempo mínimo e exportações) parte deste resultado já mesclado.
   *
   * Usa dados ao vivo (cache.liveRows) se a reunião estiver ativa e fresca;
   * caso contrário, usa os dados persistidos no storage.
   *
   * @returns {object[]} Array de linhas de participante enriquecidas e mescladas.
   */
  function getSelectedRows() {
    const selectedCode = cache.selectedCode;
    if (!selectedCode || !cache.selectedMeeting) return [];

    const activeFresh =
      cache.active &&
      cache.active.code === selectedCode &&
      cache.active.updatedAt &&
      Date.now() - new Date(cache.active.updatedAt).getTime() < ACTIVE_STALE_MS;

    let rows;
    if (activeFresh && cache.liveRows) {
      rows = cache.liveRows.slice();
    } else {
      rows = participantRowsFromMeeting(cache.selectedMeeting);
    }

    const enriched = enrichRowsWithEmails(rows);
    return mergeParticipantRows(enriched);
  }

  // ---------------------------------------------------------------------------
  // Render: informação de início de reunião
  // ---------------------------------------------------------------------------

  /**
   * Atualiza o elemento #startInfo com a data/hora de início da reunião.
   */
  function renderStartInfo() {
    if (!cache.selectedMeeting) {
      els.startInfo.textContent = 'Início: -';
      return;
    }

    els.startInfo.textContent = 'Início: ' + U.formatDateTimeBR(cache.selectedMeeting.startedAt);
  }

  // ---------------------------------------------------------------------------
  // Filtro de tempo mínimo
  // ---------------------------------------------------------------------------

  /**
   * Aplica o filtro de tempo mínimo de permanência às linhas de participante.
   *
   * IMPORTANTE: `rows` deve vir de `getSelectedRows()`, ou seja, já com os
   * tempos de sessões diferentes da mesma pessoa somados (mergeParticipantRows).
   * Isso garante que quem saiu e voltou tenha as permanências somadas antes
   * da comparação com o mínimo, e que quem saiu definitivamente mas já
   * cumpriu o tempo mínimo continue sendo contado (o filtro não olha para
   * `present`, só para o tempo total acumulado).
   *
   * @param {object[]} rows - Linhas de participante não filtradas (já mescladas).
   * @returns {{ filtered: object[], excluded: number }} Linhas que passaram
   *   no filtro e contagem das excluídas.
   */
  function applyMinDwellFilter(rows) {
    const minSeconds = cache.minDwellMinutes * 60;
    if (minSeconds <= 0) {
      return { filtered: rows, excluded: 0 };
    }
    const filtered = rows.filter(r => r.totalSeconds >= minSeconds);
    return { filtered, excluded: rows.length - filtered.length };
  }

  /**
   * Atualiza o elemento #filterInfo com a contagem de participantes excluídos
   * pelo filtro de tempo mínimo.
   */
  function updateFilterInfo() {
    const allRows = getSelectedRows();
    const { filtered, excluded } = applyMinDwellFilter(allRows);
    // Suprime aviso de unused — filtered é retornado por applyMinDwellFilter
    void filtered;
    if (cache.minDwellMinutes > 0 && excluded > 0) {
      els.filterInfo.textContent = `(${excluded} excluído${excluded > 1 ? 's' : ''})`;
    } else {
      els.filterInfo.textContent = '';
    }
  }

  // ---------------------------------------------------------------------------
  // Render: tabela de participantes
  // ---------------------------------------------------------------------------

  /**
   * Renderiza a tabela de participantes com base no estado atual do cache.
   * Ordena por tempo decrescente e aplica o filtro de permanência mínima.
   *
   * Colunas: Nome | E-mail | Tempo | Sessões | Status
   */
  function renderTable() {
    const allRows = getSelectedRows().sort((a, b) => b.totalSeconds - a.totalSeconds);
    const { filtered: rows } = applyMinDwellFilter(allRows);
    const tbody = els.participantsBody;
    tbody.innerHTML = '';

    updateFilterInfo();

    if (!rows.length) {
      if (allRows.length > 0 && cache.minDwellMinutes > 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">Nenhum participante atende ao tempo mínimo configurado.</td></tr>';
      } else {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">Nenhum participante capturado nesta reunião.</td></tr>';
      }
      return;
    }

    for (const row of rows) {
      const tr = document.createElement('tr');
      const emailEmpty = !row.email;
      const emailDisplay = emailEmpty
        ? '<span class="email-empty" title="E-mail não exposto pelo Meet — importe uma lista Nome;E-mail">—</span>'
        : escapeHtml(row.email);

      tr.innerHTML = `
        <td>${escapeHtml(row.name || '(sem nome)')}</td>
        <td>${emailDisplay}</td>
        <td>${escapeHtml(U.formatDurationLong(row.totalSeconds))}</td>
        <td>${row.sessions}</td>
        <td>${row.present ? '<span class="status-pill"><span class="dot">●</span>Presente</span>' : 'Saiu'}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  /**
   * Escapa caracteres HTML especiais para exibição segura no DOM.
   * Previne XSS ao exibir nomes ou e-mails de participantes.
   *
   * @param {*} text - Valor a escapar (qualquer tipo é coercionado para string).
   * @returns {string} String com entidades HTML escapadas.
   */
  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------------------
  // Carregamento de dados de reunião
  // ---------------------------------------------------------------------------

  /**
   * Carrega os dados de uma reunião específica do storage e atualiza o cache.
   * Também solicita dados ao vivo ao content script se a reunião estiver ativa.
   *
   * @param {string|null} code - Código da reunião a carregar, ou `null` para
   *   limpar a seleção.
   * @returns {Promise<void>}
   */
  async function loadMeetingData(code) {
    if (!code) {
      cache.selectedMeeting = null;
      cache.liveRows = null;
      renderStartInfo();
      renderTable();
      return;
    }

    const key = meetingKey(code);
    const data = await storageGet([key]);
    cache.selectedMeeting = data[key] || null;
    cache.liveRows = null;

    renderStartInfo();
    renderTable();
  }

  // ---------------------------------------------------------------------------
  // Dados ao vivo do content script
  // ---------------------------------------------------------------------------

  /**
   * Tenta obter dados ao vivo de participantes do content script via
   * mensagem MP_GET_LIVE, se a reunião selecionada estiver ativa e fresca.
   *
   * Em caso de falha (aba não encontrada, content script não respondeu, reunião
   * diferente), define `cache.liveRows = null` sem lançar exceção.
   *
   * @returns {Promise<void>}
   */
  async function fetchLiveRowsIfActive() {
    if (!cache.selectedCode || !cache.active || cache.active.code !== cache.selectedCode) {
      cache.liveRows = null;
      return;
    }

    if (!cache.active.updatedAt || Date.now() - new Date(cache.active.updatedAt).getTime() >= ACTIVE_STALE_MS) {
      cache.liveRows = null;
      return;
    }

    // Solicita ao background o tabId da aba do Meet ativa
    const tabResp = await chrome.runtime.sendMessage({ type: 'MP_GET_TAB' }).catch(() => ({ tabId: null }));
    const tabId = tabResp && Number.isFinite(tabResp.tabId) ? tabResp.tabId : null;
    if (tabId == null) {
      cache.liveRows = null;
      return;
    }

    // Solicita dados ao vivo ao content script na aba do Meet
    const liveResp = await chrome.tabs.sendMessage(tabId, { type: 'MP_GET_LIVE' }).catch(() => null);
    if (!liveResp || !liveResp.active || liveResp.code !== cache.selectedCode) {
      cache.liveRows = null;
      return;
    }

    cache.liveRows = participantRowsFromLive(liveResp);
  }

  // ---------------------------------------------------------------------------
  // Refresh completo do popup
  // ---------------------------------------------------------------------------

  /**
   * Recarrega todos os dados do storage e re-renderiza o popup completo.
   *
   * Inclui migração automática do formato legado de arquivo de turma (v1.x):
   * se `mp_email_maps_v2` estiver vazio mas `mp_email_map` (legado) tiver
   * entradas, cria automaticamente um arquivo de turma com essas entradas.
   *
   * @returns {Promise<void>}
   */
  async function refresh() {
    const data = await storageGet([
      STORAGE_KEYS.index,
      STORAGE_KEYS.active,
      STORAGE_KEYS.emailMaps,
      STORAGE_KEYS.activeEmailMapId,
      STORAGE_KEYS.emailMapLegacy
    ]);

    cache.index = Array.isArray(data[STORAGE_KEYS.index]) ? data[STORAGE_KEYS.index] : [];
    cache.active = data[STORAGE_KEYS.active] || null;

    let emailMaps = Array.isArray(data[STORAGE_KEYS.emailMaps]) ? data[STORAGE_KEYS.emailMaps] : [];
    const legacyEntries = Array.isArray(data[STORAGE_KEYS.emailMapLegacy])
      ? data[STORAGE_KEYS.emailMapLegacy]
      : [];

    // Migração automática do formato legado (mp_email_map → mp_email_maps_v2)
    if (!emailMaps.length && legacyEntries.length) {
      const nowIso = new Date().toISOString();
      emailMaps = [{
        id: generateEmailMapId(),
        name: 'Turma importada (legado)',
        entries: legacyEntries,
        createdAt: nowIso,
        updatedAt: nowIso,
        lastUsedAt: null
      }];
      await storageSet({
        [STORAGE_KEYS.emailMaps]: emailMaps,
        [STORAGE_KEYS.activeEmailMapId]: emailMaps[0].id
      });
    }

    cache.emailMaps = emailMaps;
    cache.activeEmailMapId =
      data[STORAGE_KEYS.activeEmailMapId] || (emailMaps[0] ? emailMaps[0].id : null);

    renderStatusLine();
    renderRosterSelect();

    // Preserva a seleção anterior se a reunião ainda existe no índice
    const prevSelected = cache.selectedCode;
    renderMeetingSelect();

    if (prevSelected && cache.index.some((x) => x.code === prevSelected)) {
      cache.selectedCode = prevSelected;
      els.meetingSelect.value = prevSelected;
    }

    if (!cache.selectedCode && cache.index[0]) {
      cache.selectedCode = cache.index[0].code;
    }

    await loadMeetingData(cache.selectedCode);
    await fetchLiveRowsIfActive();
    renderTable();
  }

  // ---------------------------------------------------------------------------
  // Exportação: construção das linhas
  // ---------------------------------------------------------------------------

  /**
   * Constrói o array de linhas para exportação a partir do estado atual
   * do cache, aplicando o filtro de tempo mínimo e enriquecimento de e-mails.
   *
   * Cada objeto retornado contém todos os campos necessários para CSV e JSON.
   *
   * @returns {Array<{
   *   nome: string,
   *   email: string,
   *   primeiraEntrada: string,
   *   ultimaSaida: string,
   *   tempoHms: string,
   *   tempoSeg: number,
   *   sessoes: number,
   *   presenteAgora: string,
   *   reuniao: string
   * }>} Array de linhas de exportação.
   */
  function buildExportRows() {
    const meeting = cache.selectedMeeting;
    if (!meeting || !meeting.code || !meeting.state) return [];

    const allRows = getSelectedRows().sort((a, b) => b.totalSeconds - a.totalSeconds);
    const { filtered: rows } = applyMinDwellFilter(allRows);

    return rows.map((r) => ({
      nome: r.name,
      email: r.email || '',          // string vazia (não null) para CSV
      primeiraEntrada: U.formatDateTimeBR(r.firstSeenAt),
      ultimaSaida: U.formatDateTimeBR(r.lastSeenAt),
      tempoHms: U.formatDurationHMS(r.totalSeconds),
      tempoSeg: Math.max(0, Math.floor(r.totalSeconds)),
      sessoes: r.sessions,
      presenteAgora: r.present ? 'Sim' : 'Não',
      reuniao: meeting.code
    }));
  }

  // ---------------------------------------------------------------------------
  // Download de arquivo
  // ---------------------------------------------------------------------------

  /**
   * Dispara o download de um arquivo no navegador usando um Blob URL temporário.
   *
   * @param {string} content - Conteúdo do arquivo (texto ou binário).
   * @param {string} mimeType - Tipo MIME (ex.: 'text/csv;charset=utf-8').
   * @param {string} filename - Nome do arquivo a ser salvo.
   */
  function downloadBlob(content, mimeType, filename) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // ---------------------------------------------------------------------------
  // Exportação CSV (v1.6.0)
  // ---------------------------------------------------------------------------

  /**
   * Exporta a lista de presença no formato CSV simplificado.
   *
   * **Formato (v1.6.0):** `Nome;E-mail;Data`
   *
   * **Ordem das linhas:**
   * 1. Participantes COM e-mail (um por e-mail)
   * 2. Participantes SEM e-mail (um por nome normalizado)
   *
   * **Deduplicação (rede de segurança):**
   * A junção principal de registros da mesma pessoa (ex.: quem saiu e voltou
   * com um novo ID do Meet) já acontece em `mergeParticipantRows`, ANTES do
   * filtro de tempo mínimo — os tempos de cada sessão já vêm SOMADOS aqui.
   * O agrupamento abaixo por e-mail/nome é apenas uma segunda camada de
   * segurança para o caso raro de duas linhas ainda coincidirem depois da
   * mesclagem (ex.: e-mail preenchido manualmente após o merge); nesse caso
   * mantém a linha com maior tempo, já que ambas deveriam representar o
   * mesmo período de tempo, não períodos adicionais.
   *
   * O arquivo é codificado em UTF-8 com BOM para compatibilidade com Excel.
   * A data no arquivo é sempre a data DO DIA DA EXPORTAÇÃO (não da reunião).
   *
   * @returns {void} Dispara download direto no navegador.
   */
  function onExportCsv() {
    const meeting = cache.selectedMeeting;
    if (!meeting || !meeting.code) {
      setFeedback('Selecione uma reunião para exportar.', true);
      return;
    }

    const rows = buildExportRows();

    // Data do dia da exportação (formato brasileiro: DD/MM/AAAA)
    const meetingDate = new Date().toLocaleDateString('pt-BR');

    // --- Grupo 1: participantes COM e-mail ---
    // Deduplica por e-mail (case-insensitive), mantendo o maior tempo de permanência
    const withEmail = rows.filter(r => r.email);
    const byEmail = {};
    for (const row of withEmail) {
      const key = row.email.toLowerCase().trim();
      if (!byEmail[key] || row.tempoSeg > byEmail[key].tempoSeg) {
        byEmail[key] = row;
      }
    }
    const emailRows = Object.values(byEmail);

    // --- Grupo 2: participantes SEM e-mail ---
    // Deduplica por nome normalizado, mantendo o maior tempo de permanência
    const withoutEmail = rows.filter(r => !r.email);
    const byName = {};
    for (const row of withoutEmail) {
      const key = U.normalizeName(row.nome);
      if (!byName[key] || row.tempoSeg > byName[key].tempoSeg) {
        byName[key] = row;
      }
    }
    const noEmailRows = Object.values(byName);

    // --- Montagem do CSV: cabeçalho + linhas com e-mail + linhas sem e-mail ---
    const header = 'Nome;E-mail;Data';
    const emailLines = emailRows.map(r =>
      [r.nome, r.email, meetingDate].map(csvEscape).join(';')
    );
    const noEmailLines = noEmailRows.map(r =>
      [r.nome, '', meetingDate].map(csvEscape).join(';')
    );

    // BOM UTF-8 (\uFEFF) para compatibilidade com Excel
    const csv = '\uFEFF' + [header, ...emailLines, ...noEmailLines].join('\n');
    const filename = `presenca_${meeting.code}_${nowFilenameStamp()}.csv`;
    downloadBlob(csv, 'text/csv;charset=utf-8', filename);

    // --- Feedback informativo ---
    const dupEmailRemoved = withEmail.length - emailRows.length;
    const dupNameRemoved = withoutEmail.length - noEmailRows.length;

    let feedbackMsg = `CSV exportado: ${emailRows.length} com e-mail`;

    if (noEmailRows.length > 0) {
      // Exibe até 5 nomes dos sem e-mail para facilitar diagnóstico
      const namesPreview = noEmailRows.slice(0, 5).map(r => r.nome).join(', ');
      const extra = noEmailRows.length > 5 ? ` +${noEmailRows.length - 5}` : '';
      feedbackMsg += `, ${noEmailRows.length} sem e-mail (${namesPreview}${extra})`;
    }

    if (dupEmailRemoved > 0 || dupNameRemoved > 0) {
      const totalDup = dupEmailRemoved + dupNameRemoved;
      feedbackMsg += `. ${totalDup} duplicata(s) removida(s)`;
    }

    setFeedback(feedbackMsg + '.');
  }

  /**
   * Escapa um valor para uso seguro em CSV com delimitador ponto-e-vírgula.
   *
   * Envolve o valor em aspas duplas se ele contiver `;`, `"` ou quebra de
   * linha. Aspas duplas internas são dobradas conforme RFC 4180.
   *
   * @param {*} v - Valor a escapar (qualquer tipo é coercionado para string).
   * @returns {string} Valor escapado para CSV.
   *
   * @example
   * csvEscape('João "J" Silva')  // → '"João ""J"" Silva"'
   * csvEscape('a;b')             // → '"a;b"'
   * csvEscape('normal')          // → 'normal'
   */
  function csvEscape(v) {
    const text = String(v || '');
    if (/[;"\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  // ---------------------------------------------------------------------------
  // Exportação JSON
  // ---------------------------------------------------------------------------

  /**
   * Exporta os dados completos da reunião no formato JSON.
   *
   * O JSON inclui todos os participantes que atendem ao filtro de tempo
   * mínimo, com nome, e-mail, horários e tempo de permanência formatado.
   * Não há deduplicação — o JSON é um relatório completo.
   *
   * @returns {void} Dispara download do arquivo JSON.
   */
  function onExportJson() {
    const meeting = cache.selectedMeeting;
    if (!meeting || !meeting.code) {
      setFeedback('Selecione uma reunião para exportar.', true);
      return;
    }

    const allRows = getSelectedRows().sort((a, b) => b.totalSeconds - a.totalSeconds);
    const { filtered: rows } = applyMinDwellFilter(allRows);

    const participantes = rows.map((r) => ({
      nome: r.name,
      email: r.email || '',
      primeiraEntrada: U.formatDateTimeBR(r.firstSeenAt),
      ultimaSaida: U.formatDateTimeBR(r.lastSeenAt),
      tempoPermanencia: U.formatDurationLong(r.totalSeconds)
    }));

    const payload = {
      reuniao: meeting.code,
      dataExportacao: new Date().toLocaleDateString('pt-BR'),
      participantes
    };

    const filename = `presenca_${meeting.code}_${nowFilenameStamp()}.json`;
    downloadBlob(JSON.stringify(payload, null, 2), 'application/json;charset=utf-8', filename);
    setFeedback('JSON exportado com sucesso.');
  }

  // ---------------------------------------------------------------------------
  // Persistência de e-mails vinculados
  // ---------------------------------------------------------------------------

  /**
   * Persiste os e-mails vinculados pelo arquivo de turma de volta ao registro
   * da reunião no storage.
   *
   * Após aplicar o arquivo de turma via `applyEmailMap`, os e-mails novos
   * são gravados no `mp_meeting_{code}` para que fiquem disponíveis mesmo
   * após fechar e reabrir o popup.
   *
   * Somente preenche e-mails ausentes — não sobrescreve dados existentes.
   *
   * @param {string} selectedCode - Código da reunião cujos dados serão atualizados.
   * @param {object[]} mergedParticipantsArray - Array de participantes com e-mails
   *   preenchidos pelo `applyEmailMap`.
   * @returns {Promise<void>}
   */
  async function persistMergedParticipants(selectedCode, mergedParticipantsArray) {
    const key = meetingKey(selectedCode);
    const data = await storageGet([key]);
    const meeting = data[key];
    if (!meeting || !meeting.state || !meeting.state.participants) return;

    // Indexa por chave para busca rápida
    const mapByKey = {};
    for (const p of mergedParticipantsArray) {
      mapByKey[p.key] = p;
    }

    // Preenche apenas os e-mails ausentes no storage
    for (const k of Object.keys(meeting.state.participants)) {
      const rec = meeting.state.participants[k];
      if (!rec.email && mapByKey[k] && mapByKey[k].email) {
        rec.email = mapByKey[k].email;
      }
    }

    meeting.lastActivityAt = new Date().toISOString();
    meeting.updatedAt = meeting.state.updatedAt || meeting.lastActivityAt;

    await storageSet({ [key]: meeting });
  }

  // ---------------------------------------------------------------------------
  // Persistência de arquivos de turma
  // ---------------------------------------------------------------------------

  /**
   * Salva a lista atualizada de arquivos de turma no storage e atualiza
   * o cache.
   *
   * Também mantém a chave legada `mp_email_map` sincronizada com o arquivo
   * atualmente selecionado para compatibilidade com versões anteriores.
   *
   * @param {object[]} nextMaps - Array atualizado de arquivos de turma.
   * @param {string|null} nextActiveId - ID do arquivo que deve ficar selecionado.
   * @returns {Promise<void>}
   */
  async function saveEmailMaps(nextMaps, nextActiveId) {
    cache.emailMaps = nextMaps;
    cache.activeEmailMapId = nextActiveId || null;

    // Mantém compatibilidade legada com mp_email_map
    const legacyEntries =
      getSelectedEmailMap() && Array.isArray(getSelectedEmailMap().entries)
        ? getSelectedEmailMap().entries
        : [];

    await storageSet({
      [STORAGE_KEYS.emailMaps]: nextMaps,
      [STORAGE_KEYS.activeEmailMapId]: cache.activeEmailMapId,
      [STORAGE_KEYS.emailMapLegacy]: legacyEntries
    });
  }

  // ---------------------------------------------------------------------------
  // Aplicação de arquivo de turma à reunião atual
  // ---------------------------------------------------------------------------

  /**
   * Aplica um arquivo de turma à reunião selecionada, vinculando e-mails aos
   * participantes capturados e persistindo o resultado no storage.
   *
   * Valida que:
   * - O arquivo de turma tem entradas
   * - Há uma reunião selecionada com participantes capturados
   *
   * Exibe feedback detalhado incluindo:
   * - Quantos e-mails foram preenchidos
   * - Proporção total (X/N com e-mail)
   * - Nomes dos participantes sem correspondência (até 5)
   *
   * @param {object|null} emailMap - Arquivo de turma a aplicar.
   * @returns {Promise<void>}
   */
  async function applyEmailMapToCurrentMeeting(emailMap) {
    if (!emailMap || !Array.isArray(emailMap.entries)) {
      setFeedback('Selecione um arquivo de turma válido.', true);
      return;
    }

    if (!cache.selectedMeeting || !cache.selectedMeeting.state) {
      setFeedback(
        `⚠️ Nenhuma reunião ativa ou selecionada. Entre em uma reunião do Meet ou selecione ` +
        `uma reunião salva no dropdown acima para aplicar o arquivo "${emailMap.name}".`,
        true
      );
      return;
    }

    const currentParticipants = Object.keys(cache.selectedMeeting.state.participants || {});
    if (currentParticipants.length === 0) {
      setFeedback(
        `⚠️ Nenhum participante capturado ainda. Aguarde alguns segundos para que a extensão ` +
        `capture os participantes, depois aplique o arquivo "${emailMap.name}".`,
        true
      );
      return;
    }

    const lookup = U.buildEmailLookup(emailMap.entries);
    const currentRows = Object.values(cache.selectedMeeting.state.participants || {}).map((r) => ({
      key: r.key,
      name: r.name,
      email: r.email || null
    }));

    const merged = U.applyEmailMap(currentRows, lookup);
    await persistMergedParticipants(cache.selectedCode, merged.participants);

    // Atualiza lastUsedAt do arquivo aplicado
    const nowIso = new Date().toISOString();
    const updatedMaps = cache.emailMaps.map((m) => {
      if (m.id !== emailMap.id) return m;
      return { ...m, lastUsedAt: nowIso, updatedAt: m.updatedAt || nowIso };
    });

    await saveEmailMaps(updatedMaps, emailMap.id);

    // Feedback detalhado sobre a aplicação
    const totalParticipants = currentRows.length;
    const participantsWithEmail = merged.participants.filter(p => p.email).length;
    const participantsWithoutEmail = merged.participants.filter(p => !p.email);

    let feedbackMsg =
      `Arquivo "${emailMap.name}" aplicado — ${merged.mergedCount} e-mail(s) preenchido(s). ` +
      `Total: ${participantsWithEmail}/${totalParticipants} com e-mail.`;

    if (participantsWithoutEmail.length > 0 && participantsWithoutEmail.length <= 5) {
      const names = participantsWithoutEmail.map(p => p.name || '(sem nome)').join(', ');
      feedbackMsg += ` | Sem e-mail: ${names}`;
    } else if (participantsWithoutEmail.length > 5) {
      feedbackMsg += ` | ${participantsWithoutEmail.length} participantes ainda sem e-mail.`;
    }

    setFeedback(feedbackMsg);
    await refresh();
  }

  // ---------------------------------------------------------------------------
  // Importação de arquivo de turma
  // ---------------------------------------------------------------------------

  /**
   * Processa um arquivo CSV de turma importado pelo usuário.
   *
   * Fluxo:
   * 1. Lê o texto do arquivo e faz parse com `MPUtils.parseEmailMapCsv`
   * 2. Pede ao usuário um nome para o arquivo (window.prompt)
   * 3. Verifica se já existe arquivo com mesmo nome normalizado
   * 4. Se sim: oferece substituição (window.confirm)
   * 5. Salva o arquivo e imediatamente aplica à reunião atual
   *
   * @param {File} file - Arquivo CSV selecionado pelo input[type=file].
   * @returns {Promise<void>}
   */
  async function onFileImported(file) {
    const text = await file.text();
    const entries = U.parseEmailMapCsv(text);
    if (!entries.length) {
      setFeedback('Arquivo sem linhas válidas (esperado: Nome;E-mail).', true);
      return;
    }

    const defaultName = normalizeEmailMapName(
      (file.name || 'Turma').replace(/\.[^/.]+$/, '')
    ) || 'Turma';
    const typedName = window.prompt('Nome deste arquivo de turma (ex.: Turma 1 Manhã):', defaultName);
    if (typedName === null) return; // cancelado pelo usuário

    const mapName = normalizeEmailMapName(typedName) || defaultName;
    const nowIso = new Date().toISOString();
    const normalizedTarget = U.normalizeName(mapName);
    const existingIdx = cache.emailMaps.findIndex(
      (m) => U.normalizeName(m.name) === normalizedTarget
    );

    let nextMaps = cache.emailMaps.slice();
    let chosenId = null;

    if (existingIdx >= 0) {
      // Arquivo com mesmo nome já existe — pergunta se deve sobrescrever
      const shouldOverwrite = window.confirm(
        `Já existe um arquivo salvo com nome "${nextMaps[existingIdx].name}". Deseja substituir?`
      );
      if (!shouldOverwrite) {
        setFeedback('Importação cancelada para evitar sobrescrita.');
        return;
      }

      const prev = nextMaps[existingIdx];
      chosenId = prev.id;
      nextMaps[existingIdx] = {
        ...prev,
        name: mapName,
        entries,
        updatedAt: nowIso
      };
    } else {
      // Novo arquivo — insere no início da lista
      chosenId = generateEmailMapId();
      nextMaps.unshift({
        id: chosenId,
        name: mapName,
        entries,
        createdAt: nowIso,
        updatedAt: nowIso,
        lastUsedAt: null
      });

      // Respeita o limite máximo de arquivos salvos (30)
      if (nextMaps.length > MAX_SAVED_EMAIL_MAPS) {
        nextMaps = nextMaps.slice(0, MAX_SAVED_EMAIL_MAPS);
      }
    }

    await saveEmailMaps(nextMaps, chosenId);
    const chosenMap = nextMaps.find((m) => m.id === chosenId) || null;
    await applyEmailMapToCurrentMeeting(chosenMap);
  }

  // ---------------------------------------------------------------------------
  // Handlers dos botões do popup
  // ---------------------------------------------------------------------------

  /**
   * Handler do botão "Aplicar arquivo selecionado".
   * Aplica o arquivo de turma selecionado no dropdown à reunião atual.
   * @returns {Promise<void>}
   */
  async function onApplyRoster() {
    const selected = getSelectedEmailMap();
    if (!selected) {
      setFeedback('Selecione um arquivo de turma salvo.', true);
      return;
    }
    await applyEmailMapToCurrentMeeting(selected);
  }

  /**
   * Handler do botão "Excluir arquivo salvo".
   * Confirma com o usuário e remove o arquivo de turma selecionado.
   * @returns {Promise<void>}
   */
  async function onDeleteRoster() {
    const selected = getSelectedEmailMap();
    if (!selected) {
      setFeedback('Não há arquivo salvo para excluir.', true);
      return;
    }

    const ok = window.confirm(`Excluir o arquivo salvo "${selected.name}"?`);
    if (!ok) return;

    const remaining = cache.emailMaps.filter((m) => m.id !== selected.id);
    const nextActiveId = remaining[0] ? remaining[0].id : null;
    await saveEmailMaps(remaining, nextActiveId);
    setFeedback(`Arquivo "${selected.name}" excluído.`);
    await refresh();
  }

  /**
   * Handler do botão "Abrir painel de participantes".
   * Solicita ao content script que abra o painel lateral de pessoas do Meet.
   * @returns {Promise<void>}
   */
  async function onOpenPanel() {
    const tabResp = await chrome.runtime.sendMessage({ type: 'MP_GET_TAB' }).catch(() => ({ tabId: null }));
    const tabId = tabResp && Number.isFinite(tabResp.tabId) ? tabResp.tabId : null;
    if (tabId == null) {
      setFeedback('Não foi encontrada aba ativa do Google Meet.', true);
      return;
    }

    const resp = await chrome.tabs.sendMessage(tabId, { type: 'MP_OPEN_PEOPLE_PANEL' }).catch(() => ({ ok: false }));
    if (resp && resp.ok) {
      setFeedback('Painel de participantes aberto (ou já estava aberto).');
    } else {
      setFeedback('Não foi possível abrir o painel automaticamente.', true);
    }
  }

  /**
   * Handler do botão "Limpar reunião".
   * Remove todos os dados da reunião selecionada do storage após confirmação.
   * @returns {Promise<void>}
   */
  async function onClearMeeting() {
    const code = cache.selectedCode;
    if (!code) {
      setFeedback('Selecione uma reunião para limpar.', true);
      return;
    }

    const ok = window.confirm('Tem certeza que deseja apagar os dados desta reunião? Esta ação não pode ser desfeita.');
    if (!ok) return;

    const key = meetingKey(code);
    await storageRemove([key]);

    // Atualiza o índice removendo esta reunião
    const data = await storageGet(['mp_index']);
    const nextIndex = (Array.isArray(data.mp_index) ? data.mp_index : []).filter(
      (x) => x.code !== code
    );
    await storageSet({ mp_index: nextIndex });

    // Limpa o registro de ativa se era esta reunião
    if (cache.active && cache.active.code === code) {
      await storageSet({ mp_active: { code: null, updatedAt: new Date().toISOString() } });
    }

    cache.selectedCode = nextIndex[0] ? nextIndex[0].code : null;
    await refresh();
    setFeedback('Reunião removida com sucesso.');
  }

  // ---------------------------------------------------------------------------
  // Configuração de tempo mínimo de permanência
  // ---------------------------------------------------------------------------

  /**
   * Carrega a configuração de tempo mínimo do storage e atualiza o input.
   * @returns {Promise<void>}
   */
  async function loadMinDwellConfig() {
    const data = await storageGet([STORAGE_KEYS.minDwellMinutes]);
    const minutes = Number.isFinite(data[STORAGE_KEYS.minDwellMinutes])
      ? data[STORAGE_KEYS.minDwellMinutes]
      : 0;
    cache.minDwellMinutes = Math.max(0, Math.floor(minutes));
    els.minDwellInput.value = String(cache.minDwellMinutes);
  }

  /**
   * Salva a configuração de tempo mínimo atual no storage.
   * @returns {Promise<void>}
   */
  async function saveMinDwellConfig() {
    await storageSet({ [STORAGE_KEYS.minDwellMinutes]: cache.minDwellMinutes });
  }

  // ---------------------------------------------------------------------------
  // Vinculação de eventos DOM
  // ---------------------------------------------------------------------------

  /**
   * Registra todos os event listeners dos elementos do popup.
   * Chamado uma única vez durante a inicialização.
   */
  function bindEvents() {
    // Mudança de reunião no dropdown
    els.meetingSelect.addEventListener('change', async () => {
      cache.selectedCode = els.meetingSelect.value || null;
      await loadMeetingData(cache.selectedCode);
      await fetchLiveRowsIfActive();
      renderTable();
    });

    // Mudança no filtro de tempo mínimo
    els.minDwellInput.addEventListener('input', async () => {
      const val = parseInt(els.minDwellInput.value, 10);
      cache.minDwellMinutes = Number.isFinite(val) && val >= 0 ? val : 0;
      await saveMinDwellConfig();
      renderTable();
    });

    // Mudança no arquivo de turma selecionado
    els.rosterSelect.addEventListener('change', async () => {
      cache.activeEmailMapId = els.rosterSelect.value || null;
      await storageSet({ [STORAGE_KEYS.activeEmailMapId]: cache.activeEmailMapId });
    });

    // Botões de exportação
    els.btnExportCsv.addEventListener('click', onExportCsv);
    els.btnExportJson.addEventListener('click', onExportJson);

    // Botão de importar arquivo de turma (abre o file picker)
    els.btnImport.addEventListener('click', () => {
      els.fileInput.value = ''; // permite reimportar o mesmo arquivo
      els.fileInput.click();
    });

    // Botões de gerenciamento de roster
    els.btnApplyRoster.addEventListener('click', onApplyRoster);
    els.btnDeleteRoster.addEventListener('click', onDeleteRoster);

    // Processamento do arquivo selecionado no file picker
    els.fileInput.addEventListener('change', async () => {
      try {
        const file = els.fileInput.files && els.fileInput.files[0];
        if (!file) return;
        await onFileImported(file);
      } catch (_err) {
        setFeedback('Falha ao importar arquivo de turma.', true);
      }
    });

    // Botões de ação na reunião
    els.btnOpenPanel.addEventListener('click', onOpenPanel);
    els.btnClearMeeting.addEventListener('click', onClearMeeting);

    // Atualização reativa: storage mudou (outra aba do popup ou content script)
    chrome.storage.onChanged.addListener(() => {
      refresh();
    });

    // Polling de dados ao vivo a cada 2 segundos
    setInterval(async () => {
      await fetchLiveRowsIfActive();
      renderStatusLine();
      renderTable();
    }, 2000);
  }

  // ---------------------------------------------------------------------------
  // Inicialização do popup
  // ---------------------------------------------------------------------------

  /**
   * Ponto de entrada do popup.
   * Carrega configurações, vincula eventos e faz o refresh inicial.
   * @returns {Promise<void>}
   */
  async function start() {
    await loadMinDwellConfig();
    bindEvents();
    await refresh();
  }

  start();
})();
