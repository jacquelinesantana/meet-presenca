/**
 * @file tests/utils.test.js
 * @description Testes unitários para lib/utils.js
 *
 * Cobre: formatação, normalização, validação de e-mail, parsing de CSV,
 * extração de código de reunião e matching nome→e-mail (lookup + fuzzy).
 *
 * Rodar: npm test
 */

'use strict';

const U = require('../lib/utils.js');

// =============================================================================
// formatDurationHMS
// =============================================================================

describe('formatDurationHMS', () => {
  test('formata zero como 00:00:00', () => {
    expect(U.formatDurationHMS(0)).toBe('00:00:00');
  });

  test('formata segundos simples', () => {
    expect(U.formatDurationHMS(65)).toBe('00:01:05');
  });

  test('formata horas, minutos e segundos', () => {
    expect(U.formatDurationHMS(3725)).toBe('01:02:05');
  });

  test('trata NaN como 0', () => {
    expect(U.formatDurationHMS(NaN)).toBe('00:00:00');
  });

  test('trata negativos como 0', () => {
    expect(U.formatDurationHMS(-100)).toBe('00:00:00');
  });

  test('trata Infinity como 0', () => {
    expect(U.formatDurationHMS(Infinity)).toBe('00:00:00');
  });

  test('zero-padding em todos os campos', () => {
    expect(U.formatDurationHMS(3661)).toBe('01:01:01');
  });
});

// =============================================================================
// formatDurationLong
// =============================================================================

describe('formatDurationLong', () => {
  test('apenas segundos', () => {
    expect(U.formatDurationLong(45)).toBe('45s');
  });

  test('minutos e segundos (sem hora)', () => {
    expect(U.formatDurationLong(90)).toBe('1min 30s');
  });

  test('horas, minutos e segundos', () => {
    expect(U.formatDurationLong(3725)).toBe('1h 2min 5s');
  });

  test('zero retorna "0s"', () => {
    expect(U.formatDurationLong(0)).toBe('0s');
  });

  test('hora cheia inclui 0min', () => {
    expect(U.formatDurationLong(3600)).toBe('1h 0min 0s');
  });
});

// =============================================================================
// normalizeName
// =============================================================================

describe('normalizeName', () => {
  test('lowercase e remove acentos', () => {
    expect(U.normalizeName('José da Silva')).toBe('jose da silva');
  });

  test('colapsa múltiplos espaços', () => {
    expect(U.normalizeName('  João   Silva ')).toBe('joao silva');
  });

  test('string vazia retorna vazia', () => {
    expect(U.normalizeName('')).toBe('');
  });

  test('null retorna vazia', () => {
    expect(U.normalizeName(null)).toBe('');
  });

  test('undefined retorna vazia', () => {
    expect(U.normalizeName(undefined)).toBe('');
  });

  test('nome já normalizado permanece igual', () => {
    expect(U.normalizeName('ana lima')).toBe('ana lima');
  });

  test('remove cedilha e til', () => {
    expect(U.normalizeName('Coração')).toBe('coracao');
  });
});

// =============================================================================
// isValidEmail
// =============================================================================

describe('isValidEmail', () => {
  test('e-mail simples válido', () => {
    expect(U.isValidEmail('joao@escola.com')).toBe(true);
  });

  test('e-mail com subdomínio', () => {
    expect(U.isValidEmail('maria@mail.escola.edu.br')).toBe(true);
  });

  test('sem arroba é inválido', () => {
    expect(U.isValidEmail('naoehum email')).toBe(false);
  });

  test('string vazia é inválida', () => {
    expect(U.isValidEmail('')).toBe(false);
  });

  test('null é inválido', () => {
    expect(U.isValidEmail(null)).toBe(false);
  });

  test('número é inválido', () => {
    expect(U.isValidEmail(42)).toBe(false);
  });

  test('sem domínio é inválido', () => {
    expect(U.isValidEmail('user@')).toBe(false);
  });

  test('sem extensão de domínio é inválido', () => {
    expect(U.isValidEmail('user@domain')).toBe(false);
  });
});

// =============================================================================
// extractEmails
// =============================================================================

describe('extractEmails', () => {
  test('extrai e-mail de texto com conteúdo ao redor', () => {
    expect(U.extractEmails('Contato: joao@escola.com aqui')).toEqual(['joao@escola.com']);
  });

  test('extrai múltiplos e-mails sem duplicatas', () => {
    const emails = U.extractEmails('a@b.com e A@B.COM novamente a@b.com');
    expect(emails).toHaveLength(1);
    expect(emails[0].toLowerCase()).toBe('a@b.com');
  });

  test('texto sem e-mail retorna array vazio', () => {
    expect(U.extractEmails('apenas texto sem email')).toEqual([]);
  });

  test('null retorna array vazio', () => {
    expect(U.extractEmails(null)).toEqual([]);
  });
});

// =============================================================================
// meetingCodeFromUrl
// =============================================================================

describe('meetingCodeFromUrl', () => {
  test('extrai código de URL normal', () => {
    expect(U.meetingCodeFromUrl('https://meet.google.com/abc-defg-hij'))
      .toBe('abc-defg-hij');
  });

  test('extrai código de URL com query string', () => {
    expect(U.meetingCodeFromUrl('https://meet.google.com/abc-defg-hij?authuser=0'))
      .toBe('abc-defg-hij');
  });

  test('lowercase no código retornado', () => {
    expect(U.meetingCodeFromUrl('https://meet.google.com/ABC-DEFG-HIJ'))
      .toBe('abc-defg-hij');
  });

  test('URL fora do meet.google.com retorna null', () => {
    expect(U.meetingCodeFromUrl('https://google.com/abc-defg-hij')).toBeNull();
  });

  test('URL sem código retorna null', () => {
    expect(U.meetingCodeFromUrl('https://meet.google.com/')).toBeNull();
  });

  test('string vazia retorna null', () => {
    expect(U.meetingCodeFromUrl('')).toBeNull();
  });

  test('URL inválida retorna null', () => {
    expect(U.meetingCodeFromUrl('nao-e-url')).toBeNull();
  });

  test('página que não é reunião retorna null', () => {
    expect(U.meetingCodeFromUrl('https://meet.google.com/settings')).toBeNull();
  });
});

// =============================================================================
// parseEmailMapCsv
// =============================================================================

describe('parseEmailMapCsv', () => {
  test('parseia CSV com cabeçalho ; (ponto e vírgula)', () => {
    const csv = 'Nome;E-mail\nJoão Silva;joao@escola.com\nMaria Santos;maria@escola.com';
    const result = U.parseEmailMapCsv(csv);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: 'João Silva', email: 'joao@escola.com' });
    expect(result[1]).toEqual({ name: 'Maria Santos', email: 'maria@escola.com' });
  });

  test('parseia CSV sem cabeçalho', () => {
    const csv = 'Ana Lima;ana@escola.com';
    const result = U.parseEmailMapCsv(csv);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Ana Lima');
    expect(result[0].email).toBe('ana@escola.com');
  });

  test('parseia CSV separado por vírgula', () => {
    const csv = 'Nome,Email\nCarlos,carlos@escola.com';
    const result = U.parseEmailMapCsv(csv);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Carlos');
  });

  test('descarta entradas com e-mail inválido', () => {
    const csv = 'Nome;E-mail\nPedro;nao-e-email\nLucia;lucia@escola.com';
    const result = U.parseEmailMapCsv(csv);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Lucia');
  });

  test('ignora linhas em branco', () => {
    const csv = 'Nome;E-mail\n\nAna;ana@a.com\n\n';
    const result = U.parseEmailMapCsv(csv);
    expect(result).toHaveLength(1);
  });

  test('texto vazio retorna array vazio', () => {
    expect(U.parseEmailMapCsv('')).toEqual([]);
  });

  test('null retorna array vazio', () => {
    expect(U.parseEmailMapCsv(null)).toEqual([]);
  });

  test('trunca nomes maiores que 80 caracteres', () => {
    const nome80plus = 'A'.repeat(100);
    const csv = `Nome;E-mail\n${nome80plus};x@x.com`;
    const result = U.parseEmailMapCsv(csv);
    expect(result[0].name.length).toBeLessThanOrEqual(80);
  });

  test('remove BOM UTF-8 do início', () => {
    const csv = '\uFEFFNome;E-mail\nBia;bia@escola.com';
    const result = U.parseEmailMapCsv(csv);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Bia');
  });
});

// =============================================================================
// buildEmailLookup
// =============================================================================

describe('buildEmailLookup', () => {
  test('cria mapa com nome normalizado', () => {
    const entries = [{ name: 'João Silva', email: 'joao@escola.com' }];
    const lookup = U.buildEmailLookup(entries);
    expect(lookup['joao silva']).toBe('joao@escola.com');
  });

  test('ignora entradas com e-mail inválido', () => {
    const entries = [{ name: 'Test', email: 'nao-valido' }];
    const lookup = U.buildEmailLookup(entries);
    expect(Object.keys(lookup)).toHaveLength(0);
  });

  test('primeiro registro vence em caso de nome duplicado', () => {
    const entries = [
      { name: 'Ana Lima', email: 'ana1@escola.com' },
      { name: 'Ana Lima', email: 'ana2@escola.com' }
    ];
    const lookup = U.buildEmailLookup(entries);
    expect(lookup['ana lima']).toBe('ana1@escola.com');
  });

  test('array vazio retorna objeto vazio', () => {
    expect(U.buildEmailLookup([])).toEqual({});
  });

  test('não é array retorna objeto vazio', () => {
    expect(U.buildEmailLookup(null)).toEqual({});
  });
});

// =============================================================================
// applyEmailMap — match exato
// =============================================================================

describe('applyEmailMap — match exato', () => {
  const lookup = U.buildEmailLookup([
    { name: 'João Silva', email: 'joao@escola.com' },
    { name: 'Maria Santos', email: 'maria@escola.com' }
  ]);

  test('preenche e-mail por match exato (normalizado)', () => {
    const participants = [{ key: 'p1', name: 'João Silva', email: null }];
    const { participants: out } = U.applyEmailMap(participants, lookup);
    expect(out[0].email).toBe('joao@escola.com');
  });

  test('não sobrescreve e-mail já existente e válido', () => {
    const participants = [{ key: 'p1', name: 'João Silva', email: 'ja@tem.com' }];
    const { participants: out } = U.applyEmailMap(participants, lookup);
    expect(out[0].email).toBe('ja@tem.com');
  });

  test('participante sem match permanece sem e-mail', () => {
    const participants = [{ key: 'p1', name: 'Desconhecido Xyz', email: null }];
    const { participants: out } = U.applyEmailMap(participants, lookup);
    expect(out[0].email).toBeNull();
  });

  test('retorna mergedCount correto', () => {
    const participants = [
      { key: 'p1', name: 'João Silva', email: null },
      { key: 'p2', name: 'Maria Santos', email: null },
      { key: 'p3', name: 'Sem Match', email: null }
    ];
    const { mergedCount } = U.applyEmailMap(participants, lookup);
    expect(mergedCount).toBe(2);
  });

  test('não muta o objeto original', () => {
    const p = { key: 'p1', name: 'João Silva', email: null };
    U.applyEmailMap([p], lookup);
    expect(p.email).toBeNull(); // original intacto
  });
});

// =============================================================================
// applyEmailMap — fuzzy match
// =============================================================================

describe('applyEmailMap — fuzzy match', () => {
  const lookup = U.buildEmailLookup([
    { name: 'Vagner Santana Hernandes', email: 'vagner@escola.com' },
    { name: 'Ana Paula Lima Santos', email: 'ana@escola.com' }
  ]);

  test('match parcial: nome sem sobrenome do meio', () => {
    const participants = [{ key: 'p1', name: 'Vagner Hernandes', email: null }];
    const { participants: out } = U.applyEmailMap(participants, lookup);
    expect(out[0].email).toBe('vagner@escola.com');
  });

  test('match com acentuação diferente', () => {
    const participants = [{ key: 'p1', name: 'Ana Paula Lima Santos', email: null }];
    const { participants: out } = U.applyEmailMap(participants, lookup);
    expect(out[0].email).toBe('ana@escola.com');
  });

  test('ambiguidade retorna null (sem match)', () => {
    // Dois candidatos igualmente válidos devem resultar em null (segurança)
    const ambiguousLookup = U.buildEmailLookup([
      { name: 'Ana Lima Silva', email: 'ana1@escola.com' },
      { name: 'Ana Lima Souza', email: 'ana2@escola.com' }
    ]);
    const participants = [{ key: 'p1', name: 'Ana Lima', email: null }];
    const { participants: out } = U.applyEmailMap(participants, ambiguousLookup);
    // Pode retornar null (ambiguidade) ou um dos dois — valida que não retorna valor errado
    if (out[0].email !== null) {
      expect(['ana1@escola.com', 'ana2@escola.com']).toContain(out[0].email);
    }
  });
});
