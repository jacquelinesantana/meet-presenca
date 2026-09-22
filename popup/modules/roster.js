/**
 * @file popup/modules/roster.js
 * @description Gerenciamento de arquivos de turma (importação, aplicação, exclusão).
 *
 * ## Responsabilidade
 *   - normalizeEmailMapName(name)              — sanitiza nome do arquivo
 *   - generateEmailMapId()                     — gera ID único
 *   - saveEmailMaps(nextMaps, id, cache, stor) — persiste lista de arquivos
 *   - persistMergedParticipants(code, arr, stor) — grava e-mails no storage
 *   - applyEmailMapToCurrentMeeting(map, ...)  — vincula e-mails à reunião
 *   - onFileImported(file, ...)                — processa CSV importado
 *   - onApplyRoster(...)                       — handler do botão Aplicar
 *   - onDeleteRoster(...)                      — handler do botão Excluir
 *
 * Depende de: window.MPUtils, window.MP_Constants
 * Expõe: window.MP_PopupRoster
 */

(function (global) {
  'use strict';

  /** @type {import('../../lib/utils.js').MPUtils} */
  const U = global.MPUtils;

  /** @type {import('../../lib/constants.js').MP_Constants} */
  const C = global.MP_Constants;

  const STORAGE_KEYS     = C ? C.STORAGE_KEYS     : {};
  const MAX_SAVED        = C ? C.MAX_SAVED_EMAIL_MAPS : 30;
  const MAX_NAME_LEN     = C ? C.MAX_NAME_LEN     : 80;

  // ---------------------------------------------------------------------------
  // Utilitários de nome e ID
  // ---------------------------------------------------------------------------

  /**
   * Sanitiza o nome de um arquivo de turma.
   * @param {string} name
   * @returns {string}
   */
  function normalizeEmailMapName(name) {
    return String(name || '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LEN);
  }

  /**
   * Gera um ID único para um novo arquivo de turma.
   * @returns {string}
   */
  function generateEmailMapId() {
    return 'map_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ---------------------------------------------------------------------------
  // Persistência de arquivos de turma
  // ---------------------------------------------------------------------------

  /**
   * Persiste a lista de arquivos de turma no storage e atualiza o cache.
   *
   * @param {object[]}    nextMaps    - Lista atualizada de arquivos.
   * @param {string|null} nextActiveId - ID do arquivo a selecionar.
   * @param {object}      cache       - Estado do popup (mutado).
   * @param {object}      stor        - MP_PopupStorage.
   * @returns {Promise<void>}
   */
  async function saveEmailMaps(nextMaps, nextActiveId, cache, stor) {
    cache.emailMaps       = nextMaps;
    cache.activeEmailMapId = nextActiveId || null;

    // Compatibilidade com mp_email_map (legado)
    const activeMap = nextActiveId
      ? nextMaps.find((m) => m.id === nextActiveId) || null
      : null;
    const legacyEntries = activeMap && Array.isArray(activeMap.entries)
      ? activeMap.entries
      : [];

    await stor.storageSet({
      [STORAGE_KEYS.emailMaps]:       nextMaps,
      [STORAGE_KEYS.activeEmailMapId]: cache.activeEmailMapId,
      [STORAGE_KEYS.emailMapLegacy]:   legacyEntries
    });
  }

  // ---------------------------------------------------------------------------
  // Persistência de e-mails vinculados
  // ---------------------------------------------------------------------------

  /**
   * Grava e-mails vinculados pelo arquivo de turma de volta ao registro da
   * reunião no storage. Só preenche e-mails ausentes — não sobrescreve.
   *
   * @param {string}   selectedCode
   * @param {object[]} mergedParticipantsArray
   * @param {object}   stor - MP_PopupStorage.
   * @returns {Promise<void>}
   */
  async function persistMergedParticipants(selectedCode, mergedParticipantsArray, stor) {
    const key  = C ? C.meetingStorageKey(selectedCode) : 'mp_meeting_' + selectedCode;
    const data = await stor.storageGet([key]);
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
    meeting.updatedAt      = meeting.state.updatedAt || meeting.lastActivityAt;

    await stor.storageSet({ [key]: meeting });
  }

  // ---------------------------------------------------------------------------
  // Aplicação de arquivo de turma
  // ---------------------------------------------------------------------------

  /**
   * Aplica um arquivo de turma à reunião selecionada, vinculando e-mails e
   * persistindo o resultado. Exibe feedback detalhado via setFeedback.
   *
   * @param {object|null} emailMap
   * @param {object}      cache
   * @param {object}      stor
   * @param {function}    setFeedback
   * @param {function}    refresh
   * @returns {Promise<void>}
   */
  async function applyEmailMapToCurrentMeeting(emailMap, cache, stor, setFeedback, refresh) {
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
      key:   r.key,
      name:  r.name,
      email: r.email || null
    }));

    const merged = U.applyEmailMap(currentRows, lookup);
    await persistMergedParticipants(cache.selectedCode, merged.participants, stor);

    const nowIso     = new Date().toISOString();
    const updatedMaps = cache.emailMaps.map((m) => {
      if (m.id !== emailMap.id) return m;
      return { ...m, lastUsedAt: nowIso, updatedAt: m.updatedAt || nowIso };
    });

    await saveEmailMaps(updatedMaps, emailMap.id, cache, stor);

    // Feedback
    const total   = currentRows.length;
    const withEmail    = merged.participants.filter((p) => p.email).length;
    const withoutEmail = merged.participants.filter((p) => !p.email);

    let msg =
      `Arquivo "${emailMap.name}" aplicado — ${merged.mergedCount} e-mail(s) preenchido(s). ` +
      `Total: ${withEmail}/${total} com e-mail.`;

    if (withoutEmail.length > 0 && withoutEmail.length <= 5) {
      msg += ` | Sem e-mail: ${withoutEmail.map((p) => p.name || '(sem nome)').join(', ')}`;
    } else if (withoutEmail.length > 5) {
      msg += ` | ${withoutEmail.length} participantes ainda sem e-mail.`;
    }

    setFeedback(msg);
    await refresh();
  }

  // ---------------------------------------------------------------------------
  // Importação de arquivo CSV
  // ---------------------------------------------------------------------------

  /**
   * Processa um arquivo CSV de turma importado pelo usuário.
   *
   * @param {File}     file
   * @param {object}   cache
   * @param {object}   stor
   * @param {function} setFeedback
   * @param {function} refresh
   * @returns {Promise<void>}
   */
  async function onFileImported(file, cache, stor, setFeedback, refresh) {
    const text    = await file.text();
    const entries = U.parseEmailMapCsv(text);
    if (!entries.length) {
      setFeedback('Arquivo sem linhas válidas (esperado: Nome;E-mail).', true);
      return;
    }

    const defaultName = normalizeEmailMapName(
      (file.name || 'Turma').replace(/\.[^/.]+$/, '')
    ) || 'Turma';

    const typedName = window.prompt('Nome deste arquivo de turma (ex.: Turma 1 Manhã):', defaultName);
    if (typedName === null) return;

    const mapName         = normalizeEmailMapName(typedName) || defaultName;
    const nowIso          = new Date().toISOString();
    const normalizedTarget = U.normalizeName(mapName);
    const existingIdx     = cache.emailMaps.findIndex(
      (m) => U.normalizeName(m.name) === normalizedTarget
    );

    let nextMaps  = cache.emailMaps.slice();
    let chosenId  = null;

    if (existingIdx >= 0) {
      const shouldOverwrite = window.confirm(
        `Já existe um arquivo salvo com nome "${nextMaps[existingIdx].name}". Deseja substituir?`
      );
      if (!shouldOverwrite) {
        setFeedback('Importação cancelada para evitar sobrescrita.');
        return;
      }
      const prev  = nextMaps[existingIdx];
      chosenId    = prev.id;
      nextMaps[existingIdx] = { ...prev, name: mapName, entries, updatedAt: nowIso };
    } else {
      chosenId = generateEmailMapId();
      nextMaps.unshift({ id: chosenId, name: mapName, entries, createdAt: nowIso, updatedAt: nowIso, lastUsedAt: null });
      if (nextMaps.length > MAX_SAVED) {
        nextMaps = nextMaps.slice(0, MAX_SAVED);
      }
    }

    await saveEmailMaps(nextMaps, chosenId, cache, stor);
    const chosenMap = nextMaps.find((m) => m.id === chosenId) || null;
    await applyEmailMapToCurrentMeeting(chosenMap, cache, stor, setFeedback, refresh);
  }

  // ---------------------------------------------------------------------------
  // Handlers de botão
  // ---------------------------------------------------------------------------

  /**
   * Handler do botão "Aplicar arquivo selecionado".
   *
   * @param {object}   cache
   * @param {object}   stor
   * @param {function} setFeedback
   * @param {function} refresh
   * @returns {Promise<void>}
   */
  async function onApplyRoster(cache, stor, setFeedback, refresh) {
    const selected = cache.activeEmailMapId
      ? cache.emailMaps.find((m) => m.id === cache.activeEmailMapId) || null
      : null;
    if (!selected) {
      setFeedback('Selecione um arquivo de turma salvo.', true);
      return;
    }
    await applyEmailMapToCurrentMeeting(selected, cache, stor, setFeedback, refresh);
  }

  /**
   * Handler do botão "Excluir arquivo salvo".
   *
   * @param {object}   cache
   * @param {object}   stor
   * @param {function} setFeedback
   * @param {function} refresh
   * @returns {Promise<void>}
   */
  async function onDeleteRoster(cache, stor, setFeedback, refresh) {
    const selected = cache.activeEmailMapId
      ? cache.emailMaps.find((m) => m.id === cache.activeEmailMapId) || null
      : null;
    if (!selected) {
      setFeedback('Não há arquivo salvo para excluir.', true);
      return;
    }

    const ok = window.confirm(`Excluir o arquivo salvo "${selected.name}"?`);
    if (!ok) return;

    const remaining   = cache.emailMaps.filter((m) => m.id !== selected.id);
    const nextActiveId = remaining[0] ? remaining[0].id : null;
    await saveEmailMaps(remaining, nextActiveId, cache, stor);
    setFeedback(`Arquivo "${selected.name}" excluído.`);
    await refresh();
  }

  global.MP_PopupRoster = {
    normalizeEmailMapName,
    generateEmailMapId,
    saveEmailMaps,
    persistMergedParticipants,
    applyEmailMapToCurrentMeeting,
    onFileImported,
    onApplyRoster,
    onDeleteRoster
  };
})(window);
