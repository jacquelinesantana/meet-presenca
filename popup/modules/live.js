/**
 * @file popup/modules/live.js
 * @description Dados ao vivo do content script via mensagens Chrome.
 *
 * ## Responsabilidade
 *   - computeLiveSeconds(record)         — calcula segundos incluindo delta ao vivo
 *   - participantRowsFromMeeting(meeting) — converte storage → linhas de tabela
 *   - participantRowsFromLive(live)       — converte resposta MP_GET_LIVE → linhas
 *   - fetchLiveRowsIfActive(cache)        — busca dados ao vivo se reunião ativa
 *
 * Depende de: window.MP_Constants
 * Expõe: window.MP_PopupLive
 */

(function (global) {
  'use strict';

  /** @type {import('../../lib/constants.js').MP_Constants} */
  const C = global.MP_Constants;

  // ---------------------------------------------------------------------------
  // Cálculo de tempo ao vivo
  // ---------------------------------------------------------------------------

  /**
   * Calcula o total de segundos de permanência de um participante, incluindo
   * o delta ao vivo se ele ainda estiver presente.
   *
   * O delta é limitado a 30 s para evitar acumulação excessiva se o content
   * script tiver parado ou houver lag de comunicação.
   *
   * @param {object} record
   * @param {number} [record.accumulatedSec]
   * @param {number} [record.liveSeconds]
   * @param {boolean} [record.present]
   * @param {number} [record._lastAccrualMs]
   * @returns {number}
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
  // Conversão de registros → linhas de tabela
  // ---------------------------------------------------------------------------

  /**
   * Converte os participantes do storage em linhas de tabela normalizadas.
   *
   * @param {object|null} meeting
   * @returns {object[]}
   */
  function participantRowsFromMeeting(meeting) {
    if (!meeting || !meeting.state || !meeting.state.participants) return [];

    return Object.values(meeting.state.participants).map((r) => ({
      key:          r.key,
      name:         r.name         || '',
      email:        r.email        || null,
      firstSeenAt:  r.firstSeenAt  || null,
      lastSeenAt:   r.lastSeenAt   || null,
      sessions:     Number(r.sessions || 0),
      present:      !!r.present,
      totalSeconds: computeLiveSeconds(r)
    }));
  }

  /**
   * Converte a resposta da mensagem MP_GET_LIVE em linhas de tabela.
   *
   * @param {object|null} live  Resposta do content script.
   * @returns {object[]}
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
        key:          r.key,
        name:         r.name         || '',
        email:        r.email        || null,
        firstSeenAt:  r.firstSeenAt  || null,
        lastSeenAt:   r.lastSeenAt   || null,
        sessions:     Number(r.sessions || 0),
        present:      !!r.present,
        totalSeconds: total
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Busca de dados ao vivo
  // ---------------------------------------------------------------------------

  /**
   * Tenta buscar dados ao vivo do content script se a reunião estiver ativa.
   * Em caso de falha, define cache.liveRows = null sem lançar exceção.
   *
   * @param {object} cache - Estado do popup (selectedCode, active, liveRows).
   * @returns {Promise<void>}
   */
  async function fetchLiveRowsIfActive(cache) {
    const ACTIVE_STALE_MS = C ? C.ACTIVE_STALE_MS : 15000;

    if (!cache.selectedCode || !cache.active || cache.active.code !== cache.selectedCode) {
      cache.liveRows = null;
      return;
    }

    if (!cache.active.updatedAt ||
        Date.now() - new Date(cache.active.updatedAt).getTime() >= ACTIVE_STALE_MS) {
      cache.liveRows = null;
      return;
    }

    const tabResp = await chrome.runtime.sendMessage({ type: 'MP_GET_TAB' })
      .catch(() => ({ tabId: null }));
    const tabId = tabResp && Number.isFinite(tabResp.tabId) ? tabResp.tabId : null;

    if (tabId == null) {
      cache.liveRows = null;
      return;
    }

    const liveResp = await chrome.tabs.sendMessage(tabId, { type: 'MP_GET_LIVE' })
      .catch(() => null);

    if (!liveResp || !liveResp.active || liveResp.code !== cache.selectedCode) {
      cache.liveRows = null;
      return;
    }

    cache.liveRows = participantRowsFromLive(liveResp);
  }

  global.MP_PopupLive = {
    computeLiveSeconds,
    participantRowsFromMeeting,
    participantRowsFromLive,
    fetchLiveRowsIfActive
  };
})(window);
