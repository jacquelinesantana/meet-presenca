/**
 * @file popup/modules/merge.js
 * @description Enriquecimento de e-mails e merge de registros duplicados.
 *
 * ## Responsabilidade
 *   - enrichRowsWithEmails(rows, cache) — preenche e-mails via storage + fuzzy match
 *   - mergeParticipantRows(rows)        — soma tempo de registros da mesma pessoa
 *   - participantIdentityKey(row)       — chave de identidade por e-mail ou nome
 *
 * ## Por que mergeParticipantRows existe
 *   O Google Meet pode atribuir um novo data-participant-id quando alguém sai
 *   e volta, criando dois registros separados para a mesma pessoa. Este módulo
 *   une esses registros somando os tempos ANTES do filtro de tempo mínimo.
 *
 * Depende de: window.MPUtils, window.MP_Constants
 * Expõe: window.MP_PopupMerge
 */

(function (global) {
  'use strict';

  /** @type {import('../../lib/utils.js').MPUtils} */
  const U = global.MPUtils;

  // ---------------------------------------------------------------------------
  // Chave de identidade
  // ---------------------------------------------------------------------------

  /**
   * Calcula a chave de identidade de uma linha de participante.
   * Prioriza e-mail (mais confiável); usa nome normalizado como fallback.
   *
   * @param {{name?:string, email?:string|null}} row
   * @returns {string} "email:..." ou "name:..."
   */
  function participantIdentityKey(row) {
    const email = row && row.email ? String(row.email).trim().toLowerCase() : '';
    if (email) return 'email:' + email;
    const name = row && row.name ? U.normalizeName(row.name) : '';
    return 'name:' + name;
  }

  // ---------------------------------------------------------------------------
  // Enriquecimento com e-mails
  // ---------------------------------------------------------------------------

  /**
   * Enriquece linhas de participantes com e-mails de duas fontes:
   * 1. E-mails já persistidos no storage (por chave exata do participante)
   * 2. Arquivo de turma selecionado via fuzzy matching de nome
   *
   * Não sobrescreve e-mails já preenchidos. Não muta os objetos originais.
   *
   * @param {object[]} rows - Linhas de participante.
   * @param {object} cache  - Estado do popup (selectedMeeting, emailMaps, activeEmailMapId).
   * @returns {object[]} Linhas com e-mails preenchidos onde possível.
   */
  function enrichRowsWithEmails(rows, cache) {
    if (!Array.isArray(rows) || !rows.length) return rows;

    let result = rows;

    // Fonte 1: e-mails persistidos no storage (por chave exata)
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

    // Fonte 2: arquivo de turma selecionado (fuzzy matching por nome)
    const selectedMap = cache.activeEmailMapId
      ? cache.emailMaps.find((m) => m.id === cache.activeEmailMapId) || null
      : null;

    if (selectedMap && Array.isArray(selectedMap.entries) && selectedMap.entries.length) {
      const lookup = U.buildEmailLookup(selectedMap.entries);
      const merged = U.applyEmailMap(result, lookup);
      result = merged.participants;
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Merge de registros da mesma pessoa
  // ---------------------------------------------------------------------------

  /**
   * Une linhas de participante que representam a mesma pessoa somando tempos
   * e sessões. Mantém firstSeenAt mais antigo e lastSeenAt mais recente.
   *
   * Linhas com identidade vazia (sem nome e sem e-mail) não são mescladas
   * entre si para evitar junção acidental de registros de ruído.
   *
   * @param {object[]} rows - Linhas já enriquecidas com e-mail.
   * @returns {object[]} Linhas únicas por pessoa.
   */
  function mergeParticipantRows(rows) {
    if (!Array.isArray(rows) || rows.length <= 1) return rows || [];

    const merged = new Map();
    let anonymousCounter = 0;

    for (const row of rows) {
      let idKey = participantIdentityKey(row);

      // Evita juntar múltiplos registros sem nome e sem e-mail
      if (idKey === 'name:') {
        anonymousCounter += 1;
        idKey = 'anon:' + row.key + ':' + anonymousCounter;
      }

      const existing = merged.get(idKey);
      if (!existing) {
        merged.set(idKey, Object.assign({}, row));
        continue;
      }

      // Soma tempo e sessões
      existing.totalSeconds = Number(existing.totalSeconds || 0) + Number(row.totalSeconds || 0);
      existing.sessions     = Number(existing.sessions     || 0) + Number(row.sessions     || 0);
      existing.present      = !!existing.present || !!row.present;

      // Janela de tempo total
      if (row.firstSeenAt && (!existing.firstSeenAt || new Date(row.firstSeenAt) < new Date(existing.firstSeenAt))) {
        existing.firstSeenAt = row.firstSeenAt;
      }
      if (row.lastSeenAt && (!existing.lastSeenAt || new Date(row.lastSeenAt) > new Date(existing.lastSeenAt))) {
        existing.lastSeenAt = row.lastSeenAt;
      }

      if (!existing.email && row.email) existing.email = row.email;
      if (row.name && row.name.length > (existing.name || '').length) existing.name = row.name;
    }

    return Array.from(merged.values());
  }

  global.MP_PopupMerge = {
    participantIdentityKey,
    enrichRowsWithEmails,
    mergeParticipantRows
  };
})(window);
