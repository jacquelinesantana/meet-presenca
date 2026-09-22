/**
 * @file popup/modules/storage.js
 * @description Wrappers de chrome.storage.local para o popup.
 *
 * Todas as operações de leitura/escrita/remoção do storage passam por aqui.
 * Centralizar aqui facilita mocks em testes e troca de backend de persistência.
 *
 * Expõe: window.MP_PopupStorage
 */

(function (global) {
  'use strict';

  /**
   * Lê valores do chrome.storage.local.
   * @param {string|string[]} keys
   * @returns {Promise<object>}
   */
  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => resolve(result || {}));
    });
  }

  /**
   * Grava valores no chrome.storage.local.
   * @param {object} obj
   * @returns {Promise<void>}
   */
  function storageSet(obj) {
    return new Promise((resolve) => {
      chrome.storage.local.set(obj, () => resolve());
    });
  }

  /**
   * Remove chaves do chrome.storage.local.
   * @param {string|string[]} keys
   * @returns {Promise<void>}
   */
  function storageRemove(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(keys, () => resolve());
    });
  }

  global.MP_PopupStorage = { storageGet, storageSet, storageRemove };
})(window);
