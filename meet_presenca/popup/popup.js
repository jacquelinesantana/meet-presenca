(function () {
  'use strict';

  const U = window.MPUtils;
  const ACTIVE_STALE_MS = 15000;
  const STORAGE_KEYS = {
    index: 'mp_index',
    active: 'mp_active',
    emailMapLegacy: 'mp_email_map',
    emailMaps: 'mp_email_maps_v2',
    activeEmailMapId: 'mp_active_email_map_id',
    minDwellMinutes: 'mp_min_dwell_minutes'
  };
  const MAX_SAVED_EMAIL_MAPS = 30;

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

  let cache = {
    index: [],
    selectedCode: null,
    selectedMeeting: null,
    active: null,
    emailMaps: [],
    activeEmailMapId: null,
    liveRows: null,
    minDwellMinutes: 0
  };

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => resolve(result || {}));
    });
  }

  function storageSet(obj) {
    return new Promise((resolve) => {
      chrome.storage.local.set(obj, () => resolve());
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(keys, () => resolve());
    });
  }

  function meetingKey(code) {
    return 'mp_meeting_' + code;
  }

  function nowFilenameStamp() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}_${hh}${mi}`;
  }

  function setFeedback(msg, isError) {
    els.feedback.textContent = msg || '';
    els.feedback.style.color = isError ? '#9d1c1c' : '#1f5a9a';
  }

  function renderStatusLine() {
    const active = cache.active;
    const fresh = active && active.code && active.updatedAt && (Date.now() - new Date(active.updatedAt).getTime() < ACTIVE_STALE_MS);

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

  function optionLabel(item) {
    const dt = U.formatDateTimeBR(item.startedAt).slice(0, 16);
    return `${item.code} • ${dt} • ${item.participantCount || 0} pessoas`;
  }

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
    const preferred = cache.selectedCode || (cache.active && cache.active.code) || cache.index[0].code;

    for (const item of cache.index) {
      const opt = document.createElement('option');
      opt.value = item.code;
      opt.textContent = optionLabel(item);
      if (item.code === preferred) opt.selected = true;
      select.appendChild(opt);
    }

    cache.selectedCode = select.value;
  }

  function normalizeEmailMapName(name) {
    const cleaned = String(name || '').trim().replace(/\s+/g, ' ');
    return cleaned.slice(0, 80);
  }

  function generateEmailMapId() {
    return 'map_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

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
    const preferredId = cache.activeEmailMapId && cache.emailMaps.some((m) => m.id === cache.activeEmailMapId)
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

  function getSelectedEmailMap() {
    if (!cache.activeEmailMapId) return null;
    return cache.emailMaps.find((m) => m.id === cache.activeEmailMapId) || null;
  }

  function computeLiveSeconds(record) {
    if (!record) return 0;
    let sec = Number(record.accumulatedSec || record.liveSeconds || 0);
    if (record.present && record._lastAccrualMs) {
      const delta = Math.max(0, Math.floor((Date.now() - Number(record._lastAccrualMs)) / 1000));
      sec += Math.min(delta, 30);
    }
    return sec;
  }

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

  function enrichRowsWithEmails(rows) {
    if (!Array.isArray(rows) || !rows.length) return rows;

    let result = rows;

    // 1. Sobrepõe e-mails já persistidos no registro da reunião (por chave)
    const meeting = cache.selectedMeeting;
    if (meeting && meeting.state && meeting.state.participants) {
      const byKey = meeting.state.participants;
      result = result.map((r) => {
        if (r.email) return r;
        const stored = byKey[r.key];
        if (stored && stored.email) {
          return Object.assign({}, r, { email: stored.email });
        }
        return r;
      });
    }

    // 2. Aplica automaticamente o arquivo de turma selecionado (por nome, com matching aproximado)
    const selectedMap = getSelectedEmailMap();
    if (selectedMap && Array.isArray(selectedMap.entries) && selectedMap.entries.length) {
      const lookup = U.buildEmailLookup(selectedMap.entries);
      const merged = U.applyEmailMap(result, lookup);
      result = merged.participants;
    }

    return result;
  }

  function getSelectedRows() {
    const selectedCode = cache.selectedCode;
    if (!selectedCode || !cache.selectedMeeting) return [];

    const activeFresh = cache.active && cache.active.code === selectedCode && cache.active.updatedAt && (Date.now() - new Date(cache.active.updatedAt).getTime() < ACTIVE_STALE_MS);

    let rows;
    if (activeFresh && cache.liveRows) {
      rows = cache.liveRows.slice();
    } else {
      rows = participantRowsFromMeeting(cache.selectedMeeting);
    }

    return enrichRowsWithEmails(rows);
  }

  function renderStartInfo() {
    if (!cache.selectedMeeting) {
      els.startInfo.textContent = 'Início: -';
      return;
    }

    els.startInfo.textContent = 'Início: ' + U.formatDateTimeBR(cache.selectedMeeting.startedAt);
  }

  function applyMinDwellFilter(rows) {
    const minSeconds = cache.minDwellMinutes * 60;
    if (minSeconds <= 0) {
      return { filtered: rows, excluded: 0 };
    }
    const filtered = rows.filter(r => r.totalSeconds >= minSeconds);
    return { filtered, excluded: rows.length - filtered.length };
  }

  function updateFilterInfo() {
    const allRows = getSelectedRows();
    const { filtered, excluded } = applyMinDwellFilter(allRows);
    
    if (cache.minDwellMinutes > 0 && excluded > 0) {
      els.filterInfo.textContent = `(${excluded} excluído${excluded > 1 ? 's' : ''})`;
    } else {
      els.filterInfo.textContent = '';
    }
  }

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
      const emailDisplay = emailEmpty ? '<span class="email-empty" title="E-mail não exposto pelo Meet — importe uma lista Nome;E-mail">—</span>' : escapeHtml(row.email);

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

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

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

  async function fetchLiveRowsIfActive() {
    if (!cache.selectedCode || !cache.active || cache.active.code !== cache.selectedCode) {
      cache.liveRows = null;
      return;
    }

    if (!cache.active.updatedAt || Date.now() - new Date(cache.active.updatedAt).getTime() >= ACTIVE_STALE_MS) {
      cache.liveRows = null;
      return;
    }

    const tabResp = await chrome.runtime.sendMessage({ type: 'MP_GET_TAB' }).catch(() => ({ tabId: null }));
    const tabId = tabResp && Number.isFinite(tabResp.tabId) ? tabResp.tabId : null;
    if (tabId == null) {
      cache.liveRows = null;
      return;
    }

    const liveResp = await chrome.tabs.sendMessage(tabId, { type: 'MP_GET_LIVE' }).catch(() => null);
    if (!liveResp || !liveResp.active || liveResp.code !== cache.selectedCode) {
      cache.liveRows = null;
      return;
    }

    cache.liveRows = participantRowsFromLive(liveResp);
  }

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
    const legacyEntries = Array.isArray(data[STORAGE_KEYS.emailMapLegacy]) ? data[STORAGE_KEYS.emailMapLegacy] : [];

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
    cache.activeEmailMapId = data[STORAGE_KEYS.activeEmailMapId] || (emailMaps[0] ? emailMaps[0].id : null);

    renderStatusLine();
    renderRosterSelect();

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

  function buildExportRows() {
    const meeting = cache.selectedMeeting;
    if (!meeting || !meeting.code || !meeting.state) return [];

    const allRows = getSelectedRows().sort((a, b) => b.totalSeconds - a.totalSeconds);
    const { filtered: rows } = applyMinDwellFilter(allRows);

    return rows.map((r) => ({
      nome: r.name,
      email: r.email || '',
      primeiraEntrada: U.formatDateTimeBR(r.firstSeenAt),
      ultimaSaida: U.formatDateTimeBR(r.lastSeenAt),
      tempoHms: U.formatDurationHMS(r.totalSeconds),
      tempoSeg: Math.max(0, Math.floor(r.totalSeconds)),
      sessoes: r.sessions,
      presenteAgora: r.present ? 'Sim' : 'Não',
      reuniao: meeting.code
    }));
  }

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

  function onExportCsv() {
    const meeting = cache.selectedMeeting;
    if (!meeting || !meeting.code) {
      setFeedback('Selecione uma reunião para exportar.', true);
      return;
    }

    const rows = buildExportRows();
    
    // Data atual (do dia da exportação)
    const meetingDate = new Date().toLocaleDateString('pt-BR');
    
    // Deduplicar por e-mail: manter apenas a linha com maior tempo para cada e-mail
    const withEmail = rows.filter(r => r.email);
    const byEmail = {};
    for (const row of withEmail) {
      const email = row.email.toLowerCase().trim();
      if (!byEmail[email] || row.tempoSeg > byEmail[email].tempoSeg) {
        byEmail[email] = row;
      }
    }
    const deduplicated = Object.values(byEmail);
    
    // Formato simplificado: apenas E-mail e Data
    const header = 'E-mail;Data';
    const lines = deduplicated.map((r) => [
      r.email,
      meetingDate
    ].map(csvEscape).join(';'));

    const csv = '\uFEFF' + [header, ...lines].join('\n');
    const filename = `presenca_${meeting.code}_${nowFilenameStamp()}.csv`;
    downloadBlob(csv, 'text/csv;charset=utf-8', filename);
    
    const duplicatesRemoved = withEmail.length - deduplicated.length;
    let feedbackMsg = `CSV exportado: ${deduplicated.length} participante(s) único(s) com e-mail.`;
    if (duplicatesRemoved > 0) {
      feedbackMsg += ` (${duplicatesRemoved} duplicata(s) removida(s))`;
    }
    setFeedback(feedbackMsg);
  }

  function csvEscape(v) {
    const text = String(v || '');
    if (/[;"\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  function onExportJson() {
    const meeting = cache.selectedMeeting;
    if (!meeting || !meeting.code) {
      setFeedback('Selecione uma reunião para exportar.', true);
      return;
    }

    const allRows = getSelectedRows().sort((a, b) => b.totalSeconds - a.totalSeconds);
    const { filtered: rows } = applyMinDwellFilter(allRows);

    // Formato simplificado: apenas dados essenciais de presença
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
      participantes: participantes
    };

    const filename = `presenca_${meeting.code}_${nowFilenameStamp()}.json`;
    downloadBlob(JSON.stringify(payload, null, 2), 'application/json;charset=utf-8', filename);
    setFeedback('JSON exportado com sucesso.');
  }

  async function persistMergedParticipants(selectedCode, mergedParticipantsArray) {
    const key = meetingKey(selectedCode);
    const data = await storageGet([key]);
    const meeting = data[key];
    if (!meeting || !meeting.state || !meeting.state.participants) return;

    const mapByKey = {};
    for (const p of mergedParticipantsArray) {
      mapByKey[p.key] = p;
    }

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

  async function saveEmailMaps(nextMaps, nextActiveId) {
    cache.emailMaps = nextMaps;
    cache.activeEmailMapId = nextActiveId || null;

    const legacyEntries = (getSelectedEmailMap() && Array.isArray(getSelectedEmailMap().entries))
      ? getSelectedEmailMap().entries
      : [];

    await storageSet({
      [STORAGE_KEYS.emailMaps]: nextMaps,
      [STORAGE_KEYS.activeEmailMapId]: cache.activeEmailMapId,
      [STORAGE_KEYS.emailMapLegacy]: legacyEntries
    });
  }

  async function applyEmailMapToCurrentMeeting(emailMap) {
    if (!emailMap || !Array.isArray(emailMap.entries)) {
      setFeedback('Selecione um arquivo de turma válido.', true);
      return;
    }

    if (!cache.selectedMeeting || !cache.selectedMeeting.state) {
      setFeedback(`⚠️ Nenhuma reunião ativa ou selecionada. Entre em uma reunião do Meet ou selecione uma reunião salva no dropdown acima para aplicar o arquivo "${emailMap.name}".`, true);
      return;
    }

    const currentParticipants = Object.keys(cache.selectedMeeting.state.participants || {});
    if (currentParticipants.length === 0) {
      setFeedback(`⚠️ Nenhum participante capturado ainda. Aguarde alguns segundos para que a extensão capture os participantes, depois aplique o arquivo "${emailMap.name}".`, true);
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

    const nowIso = new Date().toISOString();
    const updatedMaps = cache.emailMaps.map((m) => {
      if (m.id !== emailMap.id) return m;
      return { ...m, lastUsedAt: nowIso, updatedAt: m.updatedAt || nowIso };
    });

    await saveEmailMaps(updatedMaps, emailMap.id);
    
    // Feedback detalhado
    const totalParticipants = currentRows.length;
    const participantsWithEmail = merged.participants.filter(p => p.email).length;
    const participantsWithoutEmail = merged.participants.filter(p => !p.email);
    
    let feedbackMsg = `Arquivo "${emailMap.name}" aplicado — ${merged.mergedCount} e-mail(s) preenchido(s). `;
    feedbackMsg += `Total: ${participantsWithEmail}/${totalParticipants} com e-mail.`;
    
    if (participantsWithoutEmail.length > 0 && participantsWithoutEmail.length <= 5) {
      const names = participantsWithoutEmail.map(p => p.name || '(sem nome)').join(', ');
      feedbackMsg += ` | Sem e-mail: ${names}`;
    } else if (participantsWithoutEmail.length > 5) {
      feedbackMsg += ` | ${participantsWithoutEmail.length} participantes ainda sem e-mail.`;
    }
    
    setFeedback(feedbackMsg);
    await refresh();
  }

  async function onFileImported(file) {
    const text = await file.text();
    const entries = U.parseEmailMapCsv(text);
    if (!entries.length) {
      setFeedback('Arquivo sem linhas válidas (esperado: Nome;E-mail).', true);
      return;
    }

    const defaultName = normalizeEmailMapName((file.name || 'Turma').replace(/\.[^/.]+$/, '')) || 'Turma';
    const typedName = window.prompt('Nome deste arquivo de turma (ex.: Turma 1 Manhã):', defaultName);
    if (typedName === null) return;

    const mapName = normalizeEmailMapName(typedName) || defaultName;
    const nowIso = new Date().toISOString();
    const normalizedTarget = U.normalizeName(mapName);
    const existingIdx = cache.emailMaps.findIndex((m) => U.normalizeName(m.name) === normalizedTarget);

    let nextMaps = cache.emailMaps.slice();
    let chosenId = null;

    if (existingIdx >= 0) {
      const shouldOverwrite = window.confirm(`Já existe um arquivo salvo com nome "${nextMaps[existingIdx].name}". Deseja substituir?`);
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
      chosenId = generateEmailMapId();
      nextMaps.unshift({
        id: chosenId,
        name: mapName,
        entries,
        createdAt: nowIso,
        updatedAt: nowIso,
        lastUsedAt: null
      });

      if (nextMaps.length > MAX_SAVED_EMAIL_MAPS) {
        nextMaps = nextMaps.slice(0, MAX_SAVED_EMAIL_MAPS);
      }
    }

    await saveEmailMaps(nextMaps, chosenId);
    const chosenMap = nextMaps.find((m) => m.id === chosenId) || null;
    await applyEmailMapToCurrentMeeting(chosenMap);
  }

  async function onApplyRoster() {
    const selected = getSelectedEmailMap();
    if (!selected) {
      setFeedback('Selecione um arquivo de turma salvo.', true);
      return;
    }
    await applyEmailMapToCurrentMeeting(selected);
  }

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

    const data = await storageGet(['mp_index']);
    const nextIndex = (Array.isArray(data.mp_index) ? data.mp_index : []).filter((x) => x.code !== code);
    await storageSet({ mp_index: nextIndex });

    if (cache.active && cache.active.code === code) {
      await storageSet({ mp_active: { code: null, updatedAt: new Date().toISOString() } });
    }

    cache.selectedCode = nextIndex[0] ? nextIndex[0].code : null;
    await refresh();
    setFeedback('Reunião removida com sucesso.');
  }

  async function loadMinDwellConfig() {
    const data = await storageGet([STORAGE_KEYS.minDwellMinutes]);
    const minutes = Number.isFinite(data[STORAGE_KEYS.minDwellMinutes]) ? data[STORAGE_KEYS.minDwellMinutes] : 0;
    cache.minDwellMinutes = Math.max(0, Math.floor(minutes));
    els.minDwellInput.value = String(cache.minDwellMinutes);
  }

  async function saveMinDwellConfig() {
    await storageSet({ [STORAGE_KEYS.minDwellMinutes]: cache.minDwellMinutes });
  }

  function bindEvents() {
    els.meetingSelect.addEventListener('change', async () => {
      cache.selectedCode = els.meetingSelect.value || null;
      await loadMeetingData(cache.selectedCode);
      await fetchLiveRowsIfActive();
      renderTable();
    });

    els.minDwellInput.addEventListener('input', async () => {
      const val = parseInt(els.minDwellInput.value, 10);
      cache.minDwellMinutes = Number.isFinite(val) && val >= 0 ? val : 0;
      await saveMinDwellConfig();
      renderTable();
    });

    els.rosterSelect.addEventListener('change', async () => {
      cache.activeEmailMapId = els.rosterSelect.value || null;
      await storageSet({ [STORAGE_KEYS.activeEmailMapId]: cache.activeEmailMapId });
    });

    els.btnExportCsv.addEventListener('click', onExportCsv);
    els.btnExportJson.addEventListener('click', onExportJson);

    els.btnImport.addEventListener('click', () => {
      els.fileInput.value = '';
      els.fileInput.click();
    });

    els.btnApplyRoster.addEventListener('click', onApplyRoster);
    els.btnDeleteRoster.addEventListener('click', onDeleteRoster);

    els.fileInput.addEventListener('change', async () => {
      try {
        const file = els.fileInput.files && els.fileInput.files[0];
        if (!file) return;
        await onFileImported(file);
      } catch (_err) {
        setFeedback('Falha ao importar arquivo de turma.', true);
      }
    });

    els.btnOpenPanel.addEventListener('click', onOpenPanel);
    els.btnClearMeeting.addEventListener('click', onClearMeeting);

    chrome.storage.onChanged.addListener(() => {
      refresh();
    });

    setInterval(async () => {
      await fetchLiveRowsIfActive();
      renderStatusLine();
      renderTable();
    }, 2000);
  }

  async function start() {
    await loadMinDwellConfig();
    bindEvents();
    await refresh();
  }

  start();
})();
