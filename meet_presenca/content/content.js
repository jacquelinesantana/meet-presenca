(function () {
  'use strict';

  const U = window.MPUtils;
  const S = window.MP_Selectors;
  const T = window.MP_Tracker;

  const APP_VERSION = '1.0.0';
  const HEARTBEAT_MS = 5000;
  const NAV_CHECK_MS = 1000;
  const ACTIVE_STALE_MS = 15000;

  let currentCode = null;
  let state = null;
  let navTimer = null;
  let heartbeatTimer = null;
  let lastPersistMs = 0;

  let badgeHost = null;
  let badgeShadow = null;
  let badgeEl = null;

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (result) => resolve(result || {}));
      } catch (_err) {
        resolve({});
      }
    });
  }

  function storageSet(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => resolve());
      } catch (_err) {
        resolve();
      }
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(keys, () => resolve());
      } catch (_err) {
        resolve();
      }
    });
  }

  function meetingStorageKey(code) {
    return 'mp_meeting_' + code;
  }

  function buildMeetingPayload(meetingState, nowMs) {
    const participants = meetingState && meetingState.participants ? Object.values(meetingState.participants) : [];
    return {
      code: meetingState.code,
      startedAt: meetingState.startedAt,
      lastActivityAt: new Date(nowMs).toISOString(),
      updatedAt: meetingState.updatedAt,
      participantCount: participants.length,
      appVersion: APP_VERSION,
      state: meetingState
    };
  }

  async function updateIndex(code, payload) {
    const data = await storageGet(['mp_index']);
    const prev = Array.isArray(data.mp_index) ? data.mp_index : [];

    const filtered = prev.filter((x) => x && x.code !== code);
    filtered.unshift({
      code,
      startedAt: payload.startedAt,
      lastActivityAt: payload.lastActivityAt,
      participantCount: payload.participantCount
    });

    const capped = filtered.slice(0, 50);
    const removed = filtered.slice(50);

    const toRemoveKeys = removed.map((m) => meetingStorageKey(m.code));
    if (toRemoveKeys.length) {
      await storageRemove(toRemoveKeys);
    }

    await storageSet({ mp_index: capped });
  }

  async function persistState(force) {
    try {
      if (!currentCode || !state) return;
      const nowMs = Date.now();
      if (!force && nowMs - lastPersistMs < HEARTBEAT_MS) return;

      const payload = buildMeetingPayload(state, nowMs);
      const key = meetingStorageKey(currentCode);

      await storageSet({
        [key]: payload,
        mp_active: { code: currentCode, updatedAt: payload.lastActivityAt }
      });

      await updateIndex(currentCode, payload);
      lastPersistMs = nowMs;
    } catch (_err) {
      // nunca interrompe o Meet
    }
  }

  async function loadMeetingState(code) {
    const key = meetingStorageKey(code);
    const data = await storageGet([key]);
    const existing = data[key];

    if (existing && existing.state && existing.state.code === code) {
      return existing.state;
    }

    return T.createMeetingState({ code, startedAt: new Date().toISOString() });
  }

  async function getSettings() {
    const data = await storageGet(['mp_settings']);
    const settings = data.mp_settings || {};
    if (typeof settings.showBadge !== 'boolean') {
      settings.showBadge = true;
      await storageSet({ mp_settings: settings });
    }
    return settings;
  }

  function ensureBadge() {
    if (badgeHost) return;

    badgeHost = document.createElement('div');
    badgeHost.id = 'mp-badge-host';
    badgeHost.style.position = 'fixed';
    badgeHost.style.bottom = '12px';
    badgeHost.style.left = '12px';
    badgeHost.style.zIndex = '2147483646';
    badgeHost.style.pointerEvents = 'none';

    badgeShadow = badgeHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .badge {
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font: 12px/1.3 Arial, sans-serif;
        color: #fff;
        background: rgba(20, 20, 20, 0.75);
        border-radius: 999px;
        padding: 6px 10px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        user-select: none;
      }
      .dot {
        color: #30d158;
        font-size: 14px;
        line-height: 1;
      }
    `;

    badgeEl = document.createElement('div');
    badgeEl.className = 'badge';
    badgeEl.innerHTML = '<span class="dot">●</span><span id="mp-badge-text">Meet Presença</span>';

    badgeShadow.appendChild(style);
    badgeShadow.appendChild(badgeEl);
    document.documentElement.appendChild(badgeHost);
  }

  function removeBadge() {
    if (badgeHost && badgeHost.parentNode) {
      badgeHost.parentNode.removeChild(badgeHost);
    }
    badgeHost = null;
    badgeShadow = null;
    badgeEl = null;
  }

  async function updateBadge() {
    try {
      const settings = await getSettings();
      if (!settings.showBadge || !currentCode || !state) {
        removeBadge();
        return;
      }

      ensureBadge();
      const count = Object.values(state.participants || {}).filter((p) => p.present).length;
      const textEl = badgeShadow.getElementById('mp-badge-text');
      if (textEl) {
        textEl.textContent = 'Meet Presença • ' + count + ' participante(s)';
      }
    } catch (_err) {
      // silencioso
    }
  }

  function applyHeartbeatTick() {
    try {
      if (!currentCode || !state) return;
      const now = Date.now();
      const data = S.collectParticipants(document);
      state = T.applyTick(state, data.participants, now, { graceTicks: 2, maxDeltaSec: 30 });
      state.updatedAt = new Date(now).toISOString();
      persistState(false);
      updateBadge();
    } catch (_err) {
      // nunca quebrar o fluxo da página
    }
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(applyHeartbeatTick, HEARTBEAT_MS);
    applyHeartbeatTick();
  }

  async function enterMeeting(code) {
    try {
      currentCode = code;
      state = await loadMeetingState(code);
      await persistState(true);
      await updateBadge();
      startHeartbeat();
    } catch (_err) {
      // silencioso
    }
  }

  async function leaveMeeting() {
    try {
      if (state) {
        state = T.finalizeMeeting(state, Date.now());
        await persistState(true);
      }
    } catch (_err) {
      // silencioso
    } finally {
      currentCode = null;
      state = null;
      stopHeartbeat();
      removeBadge();

      await storageSet({ mp_active: { code: null, updatedAt: new Date().toISOString() } });
    }
  }

  async function handleNavigationCheck() {
    try {
      const nextCode = U.meetingCodeFromUrl(window.location.href);
      if (nextCode && nextCode !== currentCode) {
        if (currentCode) {
          await leaveMeeting();
        }
        await enterMeeting(nextCode);
      } else if (!nextCode && currentCode) {
        await leaveMeeting();
      } else if (nextCode && currentCode === nextCode) {
        await updateBadge();
      }
    } catch (_err) {
      // silencioso
    }
  }

  function getLiveParticipantsResponse() {
    if (!currentCode || !state) {
      return { active: false };
    }

    const now = Date.now();
    const participants = Object.values(state.participants || {})
      .map((r) => T.getLiveRecord(r, now))
      .map((r) => ({
        key: r.key,
        name: r.name,
        email: r.email || null,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        liveSeconds: r.liveSeconds,
        sessions: r.sessions,
        present: !!r.present,
        _lastAccrualMs: r._lastAccrualMs || null
      }));

    return {
      active: true,
      code: currentCode,
      participants,
      startedAt: state.startedAt
    };
  }

  function installMessageListener() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      (async () => {
        try {
          if (!message || !message.type) {
            sendResponse({ ok: false });
            return;
          }

          if (message.type === 'MP_GET_LIVE') {
            sendResponse(getLiveParticipantsResponse());
            return;
          }

          if (message.type === 'MP_OPEN_PEOPLE_PANEL') {
            const alreadyVisible = S.isParticipantsPanelVisible(document);
            if (alreadyVisible) {
              sendResponse({ ok: true });
              return;
            }

            const button = S.findPeoplePanelButton(document);
            if (button && typeof button.click === 'function') {
              button.click();
              sendResponse({ ok: true });
              return;
            }

            sendResponse({ ok: false });
            return;
          }

          sendResponse({ ok: false });
        } catch (_err) {
          sendResponse({ ok: false });
        }
      })();

      return true;
    });
  }

  function installLifecycleHandlers() {
    window.addEventListener('pagehide', () => {
      if (!state) return;
      try {
        state = T.finalizeMeeting(state, Date.now());
        persistState(true);
      } catch (_err) {
        // silencioso
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden' || !state) return;
      try {
        state = T.finalizeMeeting(state, Date.now());
        persistState(true);
      } catch (_err) {
        // silencioso
      }
    });
  }

  function start() {
    try {
      installMessageListener();
      installLifecycleHandlers();
      navTimer = setInterval(handleNavigationCheck, NAV_CHECK_MS);
      handleNavigationCheck();
    } catch (_err) {
      // silencioso
    }
  }

  start();
})();
