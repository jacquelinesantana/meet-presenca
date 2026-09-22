// =============================================================================
// popup/popup.js — Orquestrador do popup Meet Presença
// =============================================================================
//
// ## Responsabilidade
//   Inicializar o popup: carregar configurações, vincular eventos DOM
//   e orquestrar os módulos especializados.
//
// ## Módulos
//   window.MP_PopupStorage  → wrappers de chrome.storage.local
//   window.MP_PopupLive     → dados ao vivo do content script
//   window.MP_PopupMerge    → enriquecimento de e-mails e merge de registros
//   window.MP_PopupRender   → renderização da tabela e dropdowns
//   window.MP_PopupExport   → exportação CSV e JSON
//   window.MP_PopupRoster   → importação e gerenciamento de arquivos de turma
//
// ## Fluxo principal
//   start() → loadMinDwellConfig() → bindEvents() → refresh()
//
//   refresh() → storage → cache → renderTable()
//   polling 2 s → fetchLiveRowsIfActive() → renderTable()
//
// ## Dependências (carregadas antes por popup.html)
//   lib/utils.js, lib/constants.js
//   popup/modules/storage.js, live.js, merge.js, render.js, export.js, roster.js
// =============================================================================

(function () {
  'use strict';

  // ─── Módulos ──────────────────────────────────────────────────────────────
  const stor   = window.MP_PopupStorage;
  const live   = window.MP_PopupLive;
  const merge  = window.MP_PopupMerge;
  const render = window.MP_PopupRender;
  const exp    = window.MP_PopupExport;
  const roster = window.MP_PopupRoster;

  /** @type {import('../lib/constants.js').MP_Constants} */
  const C = window.MP_Constants;

  const STORAGE_KEYS    = C ? C.STORAGE_KEYS    : {};
  const ACTIVE_STALE_MS = C ? C.ACTIVE_STALE_MS : 15000;

  // ─── Referências DOM ──────────────────────────────────────────────────────

  const els = {
    statusLine:      document.getElementById('statusLine'),
    meetingSelect:   document.getElementById('meetingSelect'),
    startInfo:       document.getElementById('startInfo'),
    minDwellInput:   document.getElementById('minDwellInput'),
    filterInfo:      document.getElementById('filterInfo'),
    rosterSelect:    document.getElementById('rosterSelect'),
    participantsBody: document.getElementById('participantsBody'),
    btnExportCsv:    document.getElementById('btnExportCsv'),
    btnExportJson:   document.getElementById('btnExportJson'),
    btnImport:       document.getElementById('btnImport'),
    btnApplyRoster:  document.getElementById('btnApplyRoster'),
    btnDeleteRoster: document.getElementById('btnDeleteRoster'),
    btnOpenPanel:    document.getElementById('btnOpenPanel'),
    btnClearMeeting: document.getElementById('btnClearMeeting'),
    fileInput:       document.getElementById('fileInput'),
    feedback:        document.getElementById('feedback')
  };

  // ─── Estado do popup ──────────────────────────────────────────────────────

  /**
   * Cache local do popup. Toda leitura de dados para exibição usa este objeto.
   * Nunca acesse o storage diretamente nas funções de render.
   */
  let cache = {
    index:           [],     // lista de reuniões salvas
    selectedCode:    null,   // código da reunião selecionada
    selectedMeeting: null,   // objeto completo da reunião
    active:          null,   // reunião ativa (mp_active)
    emailMaps:       [],     // arquivos de turma salvos
    activeEmailMapId: null,  // ID do arquivo selecionado
    liveRows:        null,   // dados ao vivo do content script
    minDwellMinutes: 0       // filtro de tempo mínimo
  };

  // ─── Helpers locais ───────────────────────────────────────────────────────

  /**
   * Exibe mensagem de feedback no elemento #feedback.
   * @param {string}  msg
   * @param {boolean} [isError=false]
   */
  function setFeedback(msg, isError) {
    els.feedback.textContent  = msg || '';
    els.feedback.style.color  = isError ? '#9d1c1c' : '#1f5a9a';
  }

  /**
   * Retorna a chave de storage de uma reunião.
   * @param {string} code
   * @returns {string}
   */
  function meetingKey(code) {
    return C ? C.meetingStorageKey(code) : 'mp_meeting_' + code;
  }

  // ─── Fonte unificada de linhas ────────────────────────────────────────────

  /**
   * Retorna as linhas de participantes da reunião selecionada.
   * Enriquece com e-mails e mescla registros duplicados antes de retornar.
   *
   * @returns {object[]}
   */
  function getSelectedRows() {
    if (!cache.selectedCode || !cache.selectedMeeting) return [];

    const activeFresh =
      cache.active &&
      cache.active.code === cache.selectedCode &&
      cache.active.updatedAt &&
      Date.now() - new Date(cache.active.updatedAt).getTime() < ACTIVE_STALE_MS;

    const rows = (activeFresh && cache.liveRows)
      ? cache.liveRows.slice()
      : live.participantRowsFromMeeting(cache.selectedMeeting);

    const enriched = merge.enrichRowsWithEmails(rows, cache);
    return merge.mergeParticipantRows(enriched);
  }

  // ─── Carregamento de reunião ──────────────────────────────────────────────

  /**
   * Carrega dados de uma reunião do storage e atualiza o cache.
   * @param {string|null} code
   * @returns {Promise<void>}
   */
  async function loadMeetingData(code) {
    if (!code) {
      cache.selectedMeeting = null;
      cache.liveRows        = null;
      render.renderStartInfo(els, cache);
      render.renderTable(els, cache, getSelectedRows);
      return;
    }

    const key  = meetingKey(code);
    const data = await stor.storageGet([key]);
    cache.selectedMeeting = data[key] || null;
    cache.liveRows        = null;

    render.renderStartInfo(els, cache);
    render.renderTable(els, cache, getSelectedRows);
  }

  // ─── Refresh completo ─────────────────────────────────────────────────────

  /**
   * Recarrega todos os dados do storage e re-renderiza o popup.
   * Inclui migração automática de mp_email_map → mp_email_maps_v2.
   * @returns {Promise<void>}
   */
  async function refresh() {
    const data = await stor.storageGet([
      STORAGE_KEYS.index,
      STORAGE_KEYS.active,
      STORAGE_KEYS.emailMaps,
      STORAGE_KEYS.activeEmailMapId,
      STORAGE_KEYS.emailMapLegacy,
      STORAGE_KEYS.minDwellMinutes
    ]);

    cache.index  = Array.isArray(data[STORAGE_KEYS.index]) ? data[STORAGE_KEYS.index] : [];
    cache.active = data[STORAGE_KEYS.active] || null;

    // Configuração de tempo mínimo
    const storedMin = data[STORAGE_KEYS.minDwellMinutes];
    if (Number.isFinite(storedMin)) {
      cache.minDwellMinutes = Math.max(0, Math.floor(storedMin));
      els.minDwellInput.value = String(cache.minDwellMinutes);
    }

    let emailMaps     = Array.isArray(data[STORAGE_KEYS.emailMaps]) ? data[STORAGE_KEYS.emailMaps] : [];
    const legacyEntries = Array.isArray(data[STORAGE_KEYS.emailMapLegacy])
      ? data[STORAGE_KEYS.emailMapLegacy]
      : [];

    // Migração legado v1.x
    if (!emailMaps.length && legacyEntries.length) {
      const nowIso = new Date().toISOString();
      emailMaps = [{
        id:         roster.generateEmailMapId(),
        name:       'Turma importada (legado)',
        entries:    legacyEntries,
        createdAt:  nowIso,
        updatedAt:  nowIso,
        lastUsedAt: null
      }];
      await stor.storageSet({
        [STORAGE_KEYS.emailMaps]:        emailMaps,
        [STORAGE_KEYS.activeEmailMapId]: emailMaps[0].id
      });
    }

    cache.emailMaps       = emailMaps;
    cache.activeEmailMapId =
      data[STORAGE_KEYS.activeEmailMapId] || (emailMaps[0] ? emailMaps[0].id : null);

    render.renderStatusLine(els, cache);
    render.renderRosterSelect(els, cache);

    const prevSelected = cache.selectedCode;
    render.renderMeetingSelect(els, cache);

    if (prevSelected && cache.index.some((x) => x.code === prevSelected)) {
      cache.selectedCode        = prevSelected;
      els.meetingSelect.value   = prevSelected;
    }
    if (!cache.selectedCode && cache.index[0]) {
      cache.selectedCode = cache.index[0].code;
    }

    await loadMeetingData(cache.selectedCode);
    await live.fetchLiveRowsIfActive(cache);
    render.renderTable(els, cache, getSelectedRows);
  }

  // ─── Handlers de ação ─────────────────────────────────────────────────────

  /** Abre o painel de participantes no Meet. */
  async function onOpenPanel() {
    const tabResp = await chrome.runtime.sendMessage({ type: 'MP_GET_TAB' })
      .catch(() => ({ tabId: null }));
    const tabId = tabResp && Number.isFinite(tabResp.tabId) ? tabResp.tabId : null;

    if (tabId == null) {
      setFeedback('Não foi encontrada aba ativa do Google Meet.', true);
      return;
    }

    const resp = await chrome.tabs.sendMessage(tabId, { type: 'MP_OPEN_PEOPLE_PANEL' })
      .catch(() => ({ ok: false }));

    if (resp && resp.ok) {
      setFeedback('Painel de participantes aberto (ou já estava aberto).');
    } else {
      setFeedback('Não foi possível abrir o painel automaticamente.', true);
    }
  }

  /** Remove todos os dados da reunião selecionada. */
  async function onClearMeeting() {
    const code = cache.selectedCode;
    if (!code) {
      setFeedback('Selecione uma reunião para limpar.', true);
      return;
    }

    const ok = window.confirm('Tem certeza que deseja apagar os dados desta reunião? Esta ação não pode ser desfeita.');
    if (!ok) return;

    await stor.storageRemove([meetingKey(code)]);

    const data      = await stor.storageGet(['mp_index']);
    const nextIndex = (Array.isArray(data.mp_index) ? data.mp_index : []).filter((x) => x.code !== code);
    await stor.storageSet({ mp_index: nextIndex });

    if (cache.active && cache.active.code === code) {
      await stor.storageSet({ mp_active: { code: null, updatedAt: new Date().toISOString() } });
    }

    cache.selectedCode = nextIndex[0] ? nextIndex[0].code : null;
    await refresh();
    setFeedback('Reunião removida com sucesso.');
  }

  // ─── Configuração de tempo mínimo ─────────────────────────────────────────

  async function loadMinDwellConfig() {
    const data    = await stor.storageGet([STORAGE_KEYS.minDwellMinutes]);
    const minutes = Number.isFinite(data[STORAGE_KEYS.minDwellMinutes])
      ? data[STORAGE_KEYS.minDwellMinutes]
      : 0;
    cache.minDwellMinutes   = Math.max(0, Math.floor(minutes));
    els.minDwellInput.value = String(cache.minDwellMinutes);
  }

  async function saveMinDwellConfig() {
    await stor.storageSet({ [STORAGE_KEYS.minDwellMinutes]: cache.minDwellMinutes });
  }

  // ─── Vinculação de eventos ────────────────────────────────────────────────

  function bindEvents() {
    // Mudança de reunião
    els.meetingSelect.addEventListener('change', async () => {
      cache.selectedCode = els.meetingSelect.value || null;
      await loadMeetingData(cache.selectedCode);
      await live.fetchLiveRowsIfActive(cache);
      render.renderTable(els, cache, getSelectedRows);
    });

    // Filtro de tempo mínimo
    els.minDwellInput.addEventListener('input', async () => {
      const val = parseInt(els.minDwellInput.value, 10);
      cache.minDwellMinutes = Number.isFinite(val) && val >= 0 ? val : 0;
      await saveMinDwellConfig();
      render.renderTable(els, cache, getSelectedRows);
    });

    // Mudança de arquivo de turma selecionado
    els.rosterSelect.addEventListener('change', async () => {
      cache.activeEmailMapId = els.rosterSelect.value || null;
      await stor.storageSet({ [STORAGE_KEYS.activeEmailMapId]: cache.activeEmailMapId });
    });

    // Exportação
    els.btnExportCsv.addEventListener('click', () =>
      exp.onExportCsv(cache, getSelectedRows, render.applyMinDwellFilter, setFeedback)
    );
    els.btnExportJson.addEventListener('click', () =>
      exp.onExportJson(cache, getSelectedRows, render.applyMinDwellFilter, setFeedback)
    );

    // Importar arquivo de turma (abre file picker)
    els.btnImport.addEventListener('click', () => {
      els.fileInput.value = '';
      els.fileInput.click();
    });

    // Gerenciamento de roster
    els.btnApplyRoster.addEventListener('click', () =>
      roster.onApplyRoster(cache, stor, setFeedback, refresh)
    );
    els.btnDeleteRoster.addEventListener('click', () =>
      roster.onDeleteRoster(cache, stor, setFeedback, refresh)
    );

    // Processamento do arquivo selecionado no file picker
    els.fileInput.addEventListener('change', async () => {
      try {
        const file = els.fileInput.files && els.fileInput.files[0];
        if (!file) return;
        await roster.onFileImported(file, cache, stor, setFeedback, refresh);
      } catch (_err) {
        setFeedback('Falha ao importar arquivo de turma.', true);
      }
    });

    // Ações na reunião
    els.btnOpenPanel.addEventListener('click', onOpenPanel);
    els.btnClearMeeting.addEventListener('click', onClearMeeting);

    // Atualização reativa ao storage (outra aba ou content script)
    chrome.storage.onChanged.addListener(() => refresh());

    // Polling de dados ao vivo a cada 2 s
    setInterval(async () => {
      await live.fetchLiveRowsIfActive(cache);
      render.renderStatusLine(els, cache);
      render.renderTable(els, cache, getSelectedRows);
    }, 2000);
  }

  // ─── Inicialização ────────────────────────────────────────────────────────

  async function start() {
    await loadMinDwellConfig();
    bindEvents();
    await refresh();
  }

  start();
})();
