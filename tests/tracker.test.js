/**
 * @file tests/tracker.test.js
 * @description Testes unitários para content/tracker.js
 *
 * Cobre: criação de estado, acumulação de tempo, grace period,
 * anti-supercontagem, sessões, finalização e getLiveRecord.
 *
 * Rodar: npm test
 */

'use strict';

// tracker.js usa global.MP_Tracker; em Node.js usa module.exports
const T = require('../content/tracker.js');

// =============================================================================
// Helpers
// =============================================================================

/** Cria um participante de teste com chave e nome. */
function mkParticipant(key, name = 'Test User') {
  return { key, name, email: null };
}

/** Avança o tempo em `ms` a partir de `baseMs`. */
function tick(ms) {
  return Date.now() + ms;
}

// =============================================================================
// createMeetingState
// =============================================================================

describe('createMeetingState', () => {
  test('cria estado com código correto', () => {
    const state = T.createMeetingState({ code: 'abc-defg-hij' });
    expect(state.code).toBe('abc-defg-hij');
  });

  test('cria estado com tickCount = 0', () => {
    const state = T.createMeetingState({ code: 'abc-defg-hij' });
    expect(state.tickCount).toBe(0);
  });

  test('cria estado com participants vazio', () => {
    const state = T.createMeetingState({ code: 'abc-defg-hij' });
    expect(Object.keys(state.participants)).toHaveLength(0);
  });

  test('usa startedAt fornecido', () => {
    const iso = '2026-01-01T10:00:00.000Z';
    const state = T.createMeetingState({ code: 'abc-defg-hij', startedAt: iso });
    expect(state.startedAt).toBe(iso);
  });

  test('code vazio cria estado válido', () => {
    const state = T.createMeetingState({});
    expect(state.code).toBe('');
    expect(state.participants).toBeDefined();
  });
});

// =============================================================================
// applyTick — primeiro tick (novo participante)
// =============================================================================

describe('applyTick — novo participante', () => {
  test('cria record na primeira aparição', () => {
    const state = T.createMeetingState({ code: 'abc-defg-hij' });
    const now = Date.now();
    const p = mkParticipant('pid-001');

    const next = T.applyTick(state, [p], now);
    expect(next.participants['pid-001']).toBeDefined();
  });

  test('presente = true na primeira aparição', () => {
    const state = T.createMeetingState({ code: 'abc-defg-hij' });
    const now = Date.now();
    const next = T.applyTick(state, [mkParticipant('pid-001')], now);
    expect(next.participants['pid-001'].present).toBe(true);
  });

  test('sessions = 1 na primeira aparição', () => {
    const state = T.createMeetingState({ code: 'abc-defg-hij' });
    const now = Date.now();
    const next = T.applyTick(state, [mkParticipant('pid-001')], now);
    expect(next.participants['pid-001'].sessions).toBe(1);
  });

  test('incrementa tickCount a cada tick', () => {
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    const now = Date.now();
    state = T.applyTick(state, [], now);
    state = T.applyTick(state, [], now + 5000);
    expect(state.tickCount).toBe(2);
  });
});

// =============================================================================
// applyTick — acumulação de tempo
// =============================================================================

describe('applyTick — acumulação de tempo', () => {
  test('acumula segundos entre ticks', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    const p = mkParticipant('pid-001');

    // Tick 1: registra participante
    state = T.applyTick(state, [p], now);
    // Tick 2: 5 segundos depois
    state = T.applyTick(state, [p], now + 5000);

    const sec = state.participants['pid-001'].accumulatedSec;
    expect(sec).toBeGreaterThanOrEqual(4);
    expect(sec).toBeLessThanOrEqual(6);
  });

  test('anti-supercontagem: limita delta a maxDeltaSec (padrão 30s)', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    const p = mkParticipant('pid-001');

    state = T.applyTick(state, [p], now);
    // Simula aba suspensa por 5 minutos
    state = T.applyTick(state, [p], now + 300000, { graceTicks: 2, maxDeltaSec: 30 });

    const sec = state.participants['pid-001'].accumulatedSec;
    expect(sec).toBeLessThanOrEqual(30);
  });

  test('tempo não acumula quando participante está ausente', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    const p = mkParticipant('pid-001');

    // Tick 1: aparece
    state = T.applyTick(state, [p], now);
    // Ticks 2, 3, 4: não visto (esgota grace period)
    state = T.applyTick(state, [], now + 5000);
    state = T.applyTick(state, [], now + 10000);
    state = T.applyTick(state, [], now + 15000);

    const secAusente = state.participants['pid-001'].accumulatedSec;

    // Tick 5+: ainda ausente — tempo não deve crescer
    state = T.applyTick(state, [], now + 20000);
    state = T.applyTick(state, [], now + 60000);

    expect(state.participants['pid-001'].accumulatedSec).toBe(secAusente);
  });
});

// =============================================================================
// applyTick — grace period
// =============================================================================

describe('applyTick — grace period', () => {
  test('não marca ausente antes de esgotar graceTicks', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    const p = mkParticipant('pid-001');

    state = T.applyTick(state, [p], now);
    // 1 tick de ausência (< graceTicks=2)
    state = T.applyTick(state, [], now + 5000, { graceTicks: 2 });

    expect(state.participants['pid-001'].present).toBe(true);
  });

  test('marca ausente após esgotar graceTicks', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    const p = mkParticipant('pid-001');

    state = T.applyTick(state, [p], now);
    state = T.applyTick(state, [], now + 5000, { graceTicks: 2 });
    state = T.applyTick(state, [], now + 10000, { graceTicks: 2 });
    state = T.applyTick(state, [], now + 15000, { graceTicks: 2 }); // tick 3 > grace 2

    expect(state.participants['pid-001'].present).toBe(false);
  });

  test('reset de missCount quando participante reaparece', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    const p = mkParticipant('pid-001');

    state = T.applyTick(state, [p], now);
    state = T.applyTick(state, [], now + 5000);    // miss 1
    state = T.applyTick(state, [p], now + 10000);  // reaparece

    expect(state.participants['pid-001'].missCount).toBe(0);
  });

  test('incrementa sessions quando participante volta após ausência', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    const p = mkParticipant('pid-001');

    state = T.applyTick(state, [p], now);
    // Esgota grace (graceTicks=0 para forçar saída rápida)
    state = T.applyTick(state, [], now + 5000, { graceTicks: 0 });
    state = T.applyTick(state, [], now + 10000, { graceTicks: 0 });
    // Volta
    state = T.applyTick(state, [p], now + 15000, { graceTicks: 0 });

    expect(state.participants['pid-001'].sessions).toBe(2);
  });
});

// =============================================================================
// applyTick — atualização de nome e e-mail
// =============================================================================

describe('applyTick — atualização de nome e e-mail', () => {
  test('atualiza nome quando o Meet revela nome mais completo', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });

    state = T.applyTick(state, [{ key: 'pid-001', name: 'João', email: null }], now);
    state = T.applyTick(state, [{ key: 'pid-001', name: 'João Silva', email: null }], now + 5000);

    expect(state.participants['pid-001'].name).toBe('João Silva');
  });

  test('preenche e-mail quando disponível no tick seguinte', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });

    state = T.applyTick(state, [{ key: 'pid-001', name: 'João', email: null }], now);
    state = T.applyTick(state, [{ key: 'pid-001', name: 'João', email: 'joao@escola.com' }], now + 5000);

    expect(state.participants['pid-001'].email).toBe('joao@escola.com');
  });
});

// =============================================================================
// finalizeMeeting
// =============================================================================

describe('finalizeMeeting', () => {
  test('marca todos os presentes como ausentes', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    state = T.applyTick(state, [mkParticipant('pid-001'), mkParticipant('pid-002')], now);

    state = T.finalizeMeeting(state, now + 10000);

    expect(state.participants['pid-001'].present).toBe(false);
    expect(state.participants['pid-002'].present).toBe(false);
  });

  test('não acumula tempo além de lastSeenAt', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    state = T.applyTick(state, [mkParticipant('pid-001')], now);

    const secAntes = state.participants['pid-001'].accumulatedSec;
    // Finaliza muito depois, mas o delta deve ser zero pois lastSeenAt = now
    state = T.finalizeMeeting(state, now + 3600000);

    // accumulatedSec não deve ter crescido mais do que o pequeno delta entre now e now
    expect(state.participants['pid-001'].accumulatedSec).toBeCloseTo(secAntes, 0);
  });

  test('estado null é tratado sem lançar exceção', () => {
    expect(() => T.finalizeMeeting(null, Date.now())).not.toThrow();
  });
});

// =============================================================================
// getLiveRecord
// =============================================================================

describe('getLiveRecord', () => {
  test('retorna null para record null', () => {
    expect(T.getLiveRecord(null, Date.now())).toBeNull();
  });

  test('calcula liveSeconds para participante presente', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    state = T.applyTick(state, [mkParticipant('pid-001')], now);

    const record = state.participants['pid-001'];
    // 10 segundos depois do último tick
    const live = T.getLiveRecord(record, now + 10000);

    expect(live.liveSeconds).toBeGreaterThanOrEqual(record.accumulatedSec);
    expect(live.liveSeconds).toBeLessThanOrEqual(record.accumulatedSec + 30); // anti-supercontagem
  });

  test('liveSeconds igual a accumulatedSec quando ausente', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    state = T.applyTick(state, [mkParticipant('pid-001')], now);
    // Força ausência
    state.participants['pid-001'].present = false;

    const record = state.participants['pid-001'];
    const live = T.getLiveRecord(record, now + 60000);

    expect(live.liveSeconds).toBe(record.accumulatedSec);
  });

  test('não muta o record original', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    state = T.applyTick(state, [mkParticipant('pid-001')], now);

    const record = state.participants['pid-001'];
    const secOriginal = record.accumulatedSec;

    T.getLiveRecord(record, now + 60000);

    expect(record.accumulatedSec).toBe(secOriginal); // não mutado
  });
});

// =============================================================================
// applyTick — múltiplos participantes simultâneos
// =============================================================================

describe('applyTick — múltiplos participantes', () => {
  test('rastreia dois participantes independentemente', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    const p1 = mkParticipant('pid-001', 'Alice');
    const p2 = mkParticipant('pid-002', 'Bob');

    state = T.applyTick(state, [p1, p2], now);
    state = T.applyTick(state, [p1], now + 5000); // p2 sumiu

    expect(state.participants['pid-001'].present).toBe(true);
    expect(state.participants['pid-002'].missCount).toBe(1);
  });

  test('lista vazia de participantes não quebra o estado', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    expect(() => {
      state = T.applyTick(state, [], now);
    }).not.toThrow();
    expect(Object.keys(state.participants)).toHaveLength(0);
  });

  test('participante com key inválida (vazia) é ignorado', () => {
    const now = Date.now();
    let state = T.createMeetingState({ code: 'abc-defg-hij' });
    state = T.applyTick(state, [{ key: '', name: 'Inválido' }], now);
    expect(Object.keys(state.participants)).toHaveLength(0);
  });
});
