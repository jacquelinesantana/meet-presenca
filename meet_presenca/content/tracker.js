(function (global) {
  'use strict';

  function toIso(ms) {
    return new Date(ms).toISOString();
  }

  function clampDeltaSec(deltaMs, maxDeltaSec) {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 0;
    const raw = deltaMs / 1000;
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.min(raw, maxDeltaSec);
  }

  function safeNowMs(nowMs) {
    const n = Number(nowMs);
    if (!Number.isFinite(n) || n < 0) return Date.now();
    return n;
  }

  function createMeetingState(input) {
    const code = input && input.code ? String(input.code) : '';
    const startedMs = input && input.startedAt ? new Date(input.startedAt).getTime() : Date.now();
    const started = Number.isFinite(startedMs) ? startedMs : Date.now();

    return {
      code,
      startedAt: toIso(started),
      updatedAt: toIso(started),
      tickCount: 0,
      participants: {},
      _lastTickAtMs: started
    };
  }

  function ensureRecord(state, participant, nowMs) {
    const key = String(participant.key || '').trim();
    if (!key) return null;

    const maybeExisting = state.participants[key];
    const nextName = String(participant.name || '').trim();
    const nextEmail = participant.email ? String(participant.email).trim() : '';

    if (maybeExisting) {
      if (nextName) maybeExisting.name = nextName;
      if (nextEmail) maybeExisting.email = nextEmail;
      return maybeExisting;
    }

    const nowIso = toIso(nowMs);
    const record = {
      key,
      name: nextName,
      email: nextEmail || null,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      accumulatedSec: 0,
      sessions: 1,
      missCount: 0,
      present: true,
      _openSinceMs: nowMs,
      _lastAccrualMs: nowMs
    };

    state.participants[key] = record;
    return record;
  }

  // Modelo de acumulação:
  // - O tempo cresce apenas quando o participante está presente e aparece em um tick observado.
  // - Para evitar supercontagem em aba suspensa, cada delta é limitado por maxDeltaSec.
  // - Se o participante some por poucos ticks (graceTicks), mantemos a sessão aberta.
  // - Ao passar do graceTicks, presente=false e o cronômetro para.
  function applyTick(state, seenParticipants, nowMs, options) {
    const nextState = state || createMeetingState({ code: '', startedAt: new Date().toISOString() });
    const now = safeNowMs(nowMs);

    const config = Object.assign({ graceTicks: 2, maxDeltaSec: 30 }, options || {});
    const graceTicks = Number.isFinite(config.graceTicks) ? Math.max(0, Math.floor(config.graceTicks)) : 2;
    const maxDeltaSec = Number.isFinite(config.maxDeltaSec) ? Math.max(1, config.maxDeltaSec) : 30;

    const input = Array.isArray(seenParticipants) ? seenParticipants : [];
    const seenKeys = new Set();

    nextState.tickCount = (nextState.tickCount || 0) + 1;

    for (const p of input) {
      if (!p || !p.key) continue;
      const record = ensureRecord(nextState, p, now);
      if (!record) continue;

      seenKeys.add(record.key);

      if (record.present) {
        const lastAccrualMs = record._lastAccrualMs == null ? now : Number(record._lastAccrualMs);
        const deltaMs = now - lastAccrualMs;
        const deltaSec = clampDeltaSec(deltaMs, maxDeltaSec);
        if (deltaSec > 0) {
          record.accumulatedSec += deltaSec;
        }
      } else {
        record.sessions += 1;
        record.present = true;
        record._openSinceMs = now;
      }

      record.missCount = 0;
      record.lastSeenAt = toIso(now);
      record._lastAccrualMs = now;

      if (p.name && String(p.name).trim()) {
        record.name = String(p.name).trim();
      }
      if (p.email && String(p.email).trim()) {
        record.email = String(p.email).trim();
      }
    }

    for (const key of Object.keys(nextState.participants)) {
      if (seenKeys.has(key)) continue;

      const record = nextState.participants[key];
      record.missCount = (record.missCount || 0) + 1;

      if (record.present && record.missCount > graceTicks) {
        record.present = false;
        record._openSinceMs = null;
        record._lastAccrualMs = new Date(record.lastSeenAt).getTime();
      }
    }

    nextState._lastTickAtMs = now;
    nextState.updatedAt = toIso(now);

    return nextState;
  }

  function finalizeMeeting(state, nowMs) {
    const nextState = state || createMeetingState({ code: '', startedAt: new Date().toISOString() });
    const now = safeNowMs(nowMs);

    for (const key of Object.keys(nextState.participants)) {
      const record = nextState.participants[key];
      if (!record.present) continue;

      const lastSeenMs = new Date(record.lastSeenAt).getTime();
      const accrualMs = record._lastAccrualMs == null ? lastSeenMs : Number(record._lastAccrualMs);
      const deltaSec = clampDeltaSec(lastSeenMs - accrualMs, 30);
      if (deltaSec > 0) {
        record.accumulatedSec += deltaSec;
      }

      record.present = false;
      record._openSinceMs = null;
      record._lastAccrualMs = lastSeenMs;
    }

    nextState.updatedAt = toIso(now);
    nextState._lastTickAtMs = now;
    return nextState;
  }

  function getLiveRecord(record, nowMs) {
    if (!record) return null;

    const now = safeNowMs(nowMs);
    const clone = Object.assign({}, record);

    let liveSeconds = Number(clone.accumulatedSec || 0);
    if (clone.present) {
      const fromMs = clone._lastAccrualMs == null ? now : Number(clone._lastAccrualMs);
      const deltaSec = clampDeltaSec(now - fromMs, 30);
      if (deltaSec > 0) {
        liveSeconds += deltaSec;
      }
    }

    clone.liveSeconds = liveSeconds;
    return clone;
  }

  const exportsObject = {
    createMeetingState,
    applyTick,
    finalizeMeeting,
    getLiveRecord
  };

  global.MP_Tracker = exportsObject;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObject;
  }
})(typeof window !== 'undefined' ? window : globalThis);
