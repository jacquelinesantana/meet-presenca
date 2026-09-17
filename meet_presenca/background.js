const meetTabs = new Map();

function isMeetUrl(url) {
  return typeof url === 'string' && /^https:\/\/meet\.google\.com\//i.test(url);
}

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

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
    for (const tab of tabs || []) {
      if (typeof tab.id === 'number') {
        touchTab(tab.id, tab.url || '');
      }
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
    for (const tab of tabs || []) {
      if (typeof tab.id === 'number') {
        touchTab(tab.id, tab.url || '');
      }
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const nextUrl = changeInfo.url || tab?.url || '';
  touchTab(tabId, nextUrl);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  meetTabs.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'MP_GET_TAB') {
    return;
  }

  let latest = null;
  for (const entry of meetTabs.values()) {
    if (!latest || entry.updatedAt > latest.updatedAt) {
      latest = entry;
    }
  }

  sendResponse({ tabId: latest ? latest.tabId : null });
});
