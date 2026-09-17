/**
 * @file background.js
 * @description Service Worker da extensão Meet Presença (Manifest V3).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * RESPONSABILIDADE ÚNICA
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Mantém um mapa em memória de todas as abas abertas com URL do Google Meet
 * e responde à mensagem MP_GET_TAB com o tabId da aba Meet mais recente.
 *
 * Por que é necessário?
 * O popup não pode enviar mensagens diretamente ao content script — precisa
 * do tabId para usar chrome.tabs.sendMessage. O background rastreia os tabIds
 * porque o popup não tem acesso direto à lista de abas.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * VOLATILIDADE DO SERVICE WORKER
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Um Service Worker (Manifest V3) pode ser encerrado pelo browser a qualquer
 * momento. O mapa `meetTabs` é VOLÁTIL — é perdido ao encerrar o SW.
 * Os listeners onInstalled e onStartup repovoam o mapa ao acordar o SW.
 * Toda persistência real de dados fica em chrome.storage.local (content.js).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * PROTOCOLO DE MENSAGENS
 * ════════════════════════════════════════════════════════════════════════════
 *
 *   popup → background : { type: 'MP_GET_TAB' }
 *   background → popup : { tabId: number | null }
 *
 * tabId null significa: nenhuma aba Meet está aberta.
 */

'use strict';

// ─── Estado do módulo ─────────────────────────────────────────────────────

/**
 * Mapa de abas Meet abertas.
 * Chave: tabId (number)
 * Valor: { tabId: number, url: string, updatedAt: number }
 *
 * @type {Map<number, {tabId:number, url:string, updatedAt:number}>}
 */
const meetTabs = new Map();

// ─── Utilitários ──────────────────────────────────────────────────────────

/**
 * Verifica se uma URL pertence ao Google Meet.
 * @param {string} url
 * @returns {boolean}
 */
function isMeetUrl(url) {
  return typeof url === 'string' && /^https:\/\/meet\.google\.com\//i.test(url);
}

/**
 * Registra ou atualiza uma aba no mapa meetTabs.
 * Se a URL não for do Meet (ex.: usuário navegou para outra página),
 * remove a aba do mapa.
 *
 * @param {number} tabId  ID da aba Chrome.
 * @param {string} url    URL atual da aba.
 */
function touchTab(tabId, url) {
  if (!isMeetUrl(url)) {
    meetTabs.delete(tabId);
    return;
  }
  meetTabs.set(tabId, {
    tabId,
    url,
    updatedAt: Date.now()
  });
}

// ─── Listeners de ciclo de vida ───────────────────────────────────────────

/**
 * Ao instalar ou atualizar a extensão:
 * Popula meetTabs com abas Meet já abertas no momento.
 * Necessário porque o SW não estava rodando antes da instalação.
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
    for (const tab of tabs || []) {
      if (typeof tab.id === 'number') {
        touchTab(tab.id, tab.url || '');
      }
    }
  });
});

/**
 * Ao iniciar o browser:
 * Idem — o mapa é volátil e foi perdido ao encerrar a sessão anterior.
 */
chrome.runtime.onStartup.addListener(() => {
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
    for (const tab of tabs || []) {
      if (typeof tab.id === 'number') {
        touchTab(tab.id, tab.url || '');
      }
    }
  });
});

/**
 * Monitora mudanças de URL em abas existentes.
 * changeInfo.url só é definido quando a URL muda; tab.url é o fallback.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const nextUrl = changeInfo.url || tab?.url || '';
  touchTab(tabId, nextUrl);
});

/**
 * Remove abas fechadas do mapa para não acumular entradas obsoletas.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  meetTabs.delete(tabId);
});

// ─── Roteador de mensagens ────────────────────────────────────────────────

/**
 * Responde à mensagem MP_GET_TAB do popup.
 *
 * Retorna o tabId da aba Meet com o `updatedAt` mais recente.
 * O popup usa esse tabId para enviar MP_GET_LIVE e MP_OPEN_PEOPLE_PANEL
 * diretamente ao content.js via chrome.tabs.sendMessage.
 *
 * Retorna { tabId: null } se nenhuma aba Meet estiver aberta.
 * Mensagens de outros tipos são ignoradas (retorna sem chamar sendResponse).
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'MP_GET_TAB') {
    return;
  }

  // Encontra a aba Meet com atividade mais recente
  let latest = null;
  for (const entry of meetTabs.values()) {
    if (!latest || entry.updatedAt > latest.updatedAt) {
      latest = entry;
    }
  }

  sendResponse({ tabId: latest ? latest.tabId : null });
});
