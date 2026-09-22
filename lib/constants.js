/**
 * @file lib/constants.js
 * @description Constantes compartilhadas entre content scripts e popup.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * REGRA
 * ════════════════════════════════════════════════════════════════════════════
 * Toda constante usada em mais de um arquivo deve ser definida aqui.
 * Nunca duplique HEARTBEAT_MS, ACTIVE_STALE_MS ou chaves de storage.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * COMPATIBILIDADE
 * ════════════════════════════════════════════════════════════════════════════
 * Expõe `global.MP_Constants` para content scripts (window) e
 * `module.exports` para testes Node.js.
 */

(function (global) {
  'use strict';

  // ─── Timings ──────────────────────────────────────────────────────────────

  /**
   * Intervalo do heartbeat do content script (ms).
   * O content script coleta participantes e acumula tempo a cada tick.
   * Alterar aqui afeta tanto a coleta quanto o anti-supercontagem do tracker.
   * @type {number}
   */
  const HEARTBEAT_MS = 5000;

  /**
   * Intervalo de verificação de navegação no content script (ms).
   * Detecta entrada e saída de reuniões no SPA do Google Meet.
   * @type {number}
   */
  const NAV_CHECK_MS = 1000;

  /**
   * Tempo máximo (ms) para considerar `mp_active` como "fresco".
   * Se `updatedAt` for mais antigo que isso, a reunião é tratada como encerrada.
   * Usado tanto em content.js quanto em popup.js — deve ser idêntico nos dois.
   * @type {number}
   */
  const ACTIVE_STALE_MS = 15000;

  /**
   * Número máximo de arquivos de turma que podem ser salvos pelo usuário.
   * @type {number}
   */
  const MAX_SAVED_EMAIL_MAPS = 30;

  /**
   * Número máximo de reuniões mantidas no índice (mp_index).
   * Reuniões além deste limite têm seus dados removidos do storage.
   * @type {number}
   */
  const MAX_MEETINGS_INDEX = 50;

  /**
   * Comprimento máximo aceito para nomes de participantes e arquivos de turma.
   * @type {number}
   */
  const MAX_NAME_LEN = 80;

  // ─── Chaves de chrome.storage.local ──────────────────────────────────────

  /**
   * Mapa de chaves do chrome.storage.local usadas pela extensão.
   * Use sempre este objeto — nunca escreva strings literais de chave no código.
   *
   * @type {{
   *   index: string,
   *   active: string,
   *   settings: string,
   *   emailMaps: string,
   *   activeEmailMapId: string,
   *   minDwellMinutes: string,
   *   emailMapLegacy: string
   * }}
   */
  const STORAGE_KEYS = {
    /** Índice das últimas MAX_MEETINGS_INDEX reuniões. */
    index: 'mp_index',
    /** Reunião em andamento: `{ code, updatedAt }`. */
    active: 'mp_active',
    /** Configurações do usuário: `{ showBadge: boolean }`. */
    settings: 'mp_settings',
    /** Array de arquivos de turma salvos (formato v2). */
    emailMaps: 'mp_email_maps_v2',
    /** ID do arquivo de turma atualmente selecionado. */
    activeEmailMapId: 'mp_active_email_map_id',
    /** Filtro de tempo mínimo de permanência (minutos). */
    minDwellMinutes: 'mp_min_dwell_minutes',
    /** Legado v1.x — migrado automaticamente para emailMaps. */
    emailMapLegacy: 'mp_email_map'
  };

  /**
   * Retorna a chave de storage para os dados de uma reunião específica.
   * Ex.: "abc-defg-hij" → "mp_meeting_abc-defg-hij"
   *
   * @param {string} code - Código da reunião.
   * @returns {string}
   */
  function meetingStorageKey(code) {
    return 'mp_meeting_' + code;
  }

  // ─── Exportação ───────────────────────────────────────────────────────────

  const exportsObject = {
    HEARTBEAT_MS,
    NAV_CHECK_MS,
    ACTIVE_STALE_MS,
    MAX_SAVED_EMAIL_MAPS,
    MAX_MEETINGS_INDEX,
    MAX_NAME_LEN,
    STORAGE_KEYS,
    meetingStorageKey
  };

  // Expõe como global para content scripts e popup (window.MP_Constants)
  global.MP_Constants = exportsObject;

  // Expõe como module.exports para testes Node.js
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObject;
  }
}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this));
