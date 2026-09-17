/**
 * @file lib/utils.js
 * @description Utilitários puros (sem DOM) compartilhados entre content scripts e popup.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * FUNÇÕES EXPORTADAS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Formatação
 *   formatDurationHMS(totalSeconds)    → "01:23:45"
 *   formatDurationLong(totalSeconds)   → "1h 23min 45s"
 *   formatDateTimeBR(isoString)        → "23/04/2025 14:30:00" (pt-BR, 24h)
 *
 * Nomes
 *   normalizeName(s)                   → minúsculas sem acentos, espaço único
 *
 * URLs e e-mails
 *   meetingCodeFromUrl(url)            → "abc-defg-hij" ou null
 *   extractEmails(text)                → array de e-mails encontrados no texto
 *   isValidEmail(s)                    → boolean de sintaxe válida
 *
 * CSV
 *   parseEmailMapCsv(text)             → [{name, email}] do arquivo Nome;E-mail
 *
 * Matching nome → e-mail
 *   buildEmailLookup(entries)          → mapa {nomeNormalizado: email}
 *   applyEmailMap(participants, lookup)→ enriquece lista com e-mails via fuzzy match
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ALGORITMO DE MATCHING (findApproximateEmail)
 * ════════════════════════════════════════════════════════════════════════════
 * O matching usa tokenização por palavra + similaridade por prefixo.
 * Critérios obrigatórios:
 *   1. Primeiro nome deve bater (score ≥ 0.95).
 *   2. Além disso: último nome bate, OU participante é subconjunto do roster,
 *      OU ≥ 66% dos tokens têm correspondência.
 *   3. Mínimo 2 tokens com correspondência.
 * Em caso de empate de score entre dois candidatos: descarta (ambiguidade).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * COMPATIBILIDADE
 * ════════════════════════════════════════════════════════════════════════════
 * Expõe `global.MPUtils` para content scripts (window) e
 * `module.exports` para testes Node.js.
 */

(function (global) {
  'use strict';

  /** Comprimento máximo aceito para nomes de participantes. */
  const MAX_NAME_LEN = 80;

  // ─── Utilitários internos ─────────────────────────────────────────────────

  /**
   * Converte `value` para inteiro não-negativo seguro.
   * Retorna 0 para NaN, Infinity, negativos ou não-numéricos.
   *
   * @param {*} value
   * @returns {number}
   */
  function toSafeInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.floor(n));
  }

  // ─── Formatação de duração e data ─────────────────────────────────────────

  /**
   * Formata segundos como "HH:MM:SS" com zero-padding.
   * Usado no CSV de exportação e em comparações de duração.
   * Ex.: 3725 → "01:02:05"
   *
   * @param {number} totalSeconds
   * @returns {string}
   */
  function formatDurationHMS(totalSeconds) {
    const sec = toSafeInt(totalSeconds);
    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const seconds = sec % 60;
    return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }

  /**
   * Formata segundos em forma legível por humanos.
   * Omite horas se = 0; inclui minutos se ≥ 1 ou se horas > 0.
   * Usado na tabela do popup e no JSON de exportação.
   * Ex.: 3725 → "1h 2min 5s" | 90 → "1min 30s" | 45 → "45s"
   *
   * @param {number} totalSeconds
   * @returns {string}
   */
  function formatDurationLong(totalSeconds) {
    const sec = toSafeInt(totalSeconds);
    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const seconds = sec % 60;
    const parts = [];

    if (hours > 0) parts.push(hours + 'h');
    if (minutes > 0 || hours > 0) parts.push(minutes + 'min');
    parts.push(seconds + 's');

    return parts.join(' ');
  }

  /**
   * Formata uma string ISO 8601 como data/hora pt-BR 24h.
   * Retorna '-' para valores ausentes, null ou inválidos.
   * Ex.: "2025-04-23T14:30:00Z" → "23/04/2025 14:30:00"
   *
   * @param {string|null|undefined} isoString
   * @returns {string}
   */
  function formatDateTimeBR(isoString) {
    if (!isoString) return '-';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '-';

    return date.toLocaleString('pt-BR', {
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  // ─── Normalização de nomes ────────────────────────────────────────────────

  /**
   * Normaliza um nome para comparação case-insensitive e sem acentos:
   * 1. Trim e colapsa múltiplos espaços em um único.
   * 2. Converte para minúsculas.
   * 3. Remove diacríticos via decomposição NFD.
   *
   * Usada internamente antes de qualquer matching de nomes (lookup e fuzzy).
   * NUNCA modifica o nome exibido ao usuário — só para chaves de comparação.
   *
   * Ex.: "  José  da  Silva " → "jose da silva"
   *
   * @param {string|null|undefined} s
   * @returns {string}
   */
  function normalizeName(s) {
    const base = String(s || '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();

    return base
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  // ─── URLs ─────────────────────────────────────────────────────────────────

  /**
   * Extrai o código de reunião do Google Meet da URL.
   * Formato do código: "abc-defg-hij" (3-4-3 letras, case-insensitive no input).
   *
   * Retorna null se:
   * • URL inválida ou vazia.
   * • Hostname ≠ meet.google.com.
   * • Pathname não contém o padrão 3-4-3.
   *
   * Ex.: "https://meet.google.com/abc-defg-hij?authuser=0" → "abc-defg-hij"
   *
   * @param {string} url
   * @returns {string|null}
   */
  function meetingCodeFromUrl(url) {
    if (typeof url !== 'string' || url.trim() === '') return null;

    let parsed;
    try {
      parsed = new URL(url);
    } catch (_err) {
      return null;
    }

    if (parsed.hostname !== 'meet.google.com') return null;

    const match = parsed.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[\/?#]|$)/i);
    return match ? match[1].toLowerCase() : null;
  }

  // ─── E-mails ──────────────────────────────────────────────────────────────

  /**
   * Extrai todos os endereços de e-mail distintos de `text`.
   * Case-insensitive; remove duplicatas preservando a primeira ocorrência.
   * Útil para detectar e-mails que o Meet às vezes exibe em aria-labels.
   *
   * @param {string|null|undefined} text
   * @returns {string[]}  Array de e-mails encontrados (sem duplicatas).
   */
  function extractEmails(text) {
    const src = String(text || '');
    if (!src) return [];

    const re = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi;
    const out = [];
    const seen = new Set();

    let m;
    while ((m = re.exec(src)) !== null) {
      const email = m[0];
      const lowered = email.toLowerCase();
      if (!seen.has(lowered)) {
        seen.add(lowered);
        out.push(email);
      }
    }

    return out;
  }

  /**
   * Valida se `s` é um endereço de e-mail sintaticamente bem formado.
   * Não verifica existência real — apenas formato básico RFC 5321.
   *
   * @param {*} s
   * @returns {boolean}
   */
  function isValidEmail(s) {
    if (typeof s !== 'string') return false;
    const text = s.trim();
    if (!text) return false;
    return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}$/i.test(text);
  }

  // ─── Parsing de CSV ───────────────────────────────────────────────────────

  /**
   * Detecta o delimitador mais provável de uma linha CSV.
   * Candidatos: ';' (preferido), '\t', ','.
   * Vence o que aparece mais vezes; empate ou nenhum → ';'.
   *
   * @param {string} line  Geralmente a primeira linha do CSV.
   * @returns {string}
   */
  function chooseDelimiter(line) {
    const delimiters = [';', '\t', ','];
    let best = ';';
    let bestCount = -1;

    for (const d of delimiters) {
      const count = (line.match(new RegExp(d === '\t' ? '\\t' : '\\' + d, 'g')) || []).length;
      if (count > bestCount) {
        bestCount = count;
        best = d;
      }
    }
    return best;
  }

  /**
   * Parseia uma linha CSV respeitando campos entre aspas (RFC 4180 parcial).
   * "" dentro de campo com aspas → literal '"'.
   * Não faz trim dos valores — caller é responsável.
   *
   * @param {string} line
   * @param {string} delimiter
   * @returns {string[]}  Valores brutos de cada campo.
   */
  function parseDelimitedLine(line, delimiter) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        values.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    values.push(current);
    return values;
  }

  /**
   * Converte o conteúdo de um arquivo CSV de lista de turma em entries.
   *
   * Formato aceito:
   * • Delimitador: ';' (padrão EDN), '\t' ou ',' (autodetectado).
   * • Cabeçalho com colunas "Nome" e "E-mail" (ou variações) → opcional.
   *   Sem cabeçalho: coluna 0 = nome, coluna 1 = e-mail.
   * • BOM UTF-8 (\uFEFF) no início → ignorado pelo trim.
   * • Linhas em branco → ignoradas.
   * • Entradas com e-mail inválido → descartadas silenciosamente.
   * • Nomes longos (> MAX_NAME_LEN) → truncados.
   *
   * @param {string|null|undefined} text  Conteúdo bruto do CSV.
   * @returns {Array<{name:string, email:string}>}
   */
  function parseEmailMapCsv(text) {
    const src = String(text || '');
    const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];

    const delimiter = chooseDelimiter(lines[0]);
    const firstRow = parseDelimitedLine(lines[0], delimiter).map((v) => v.trim());

    // Detecta cabeçalho buscando colunas "Nome" e "E-mail"
    const nameIdx = firstRow.findIndex((v) => /^(nome|name)$/i.test(v));
    const emailIdx = firstRow.findIndex((v) => /^(e-?mail|email)$/i.test(v));
    const hasHeader = nameIdx !== -1 && emailIdx !== -1;

    const result = [];
    const start = hasHeader ? 1 : 0;

    for (let i = start; i < lines.length; i += 1) {
      const row = parseDelimitedLine(lines[i], delimiter).map((v) => v.trim());

      let name = '';
      let email = '';

      if (hasHeader) {
        name = row[nameIdx] || '';
        email = row[emailIdx] || '';
      } else {
        name = row[0] || '';
        email = row[1] || '';
      }

      // Remove aspas externas que o parser simples não trata
      name = name.replace(/^"|"$/g, '').trim();
      email = email.replace(/^"|"$/g, '').trim();

      if (!name || !isValidEmail(email)) continue;
      if (name.length > MAX_NAME_LEN) {
        name = name.slice(0, MAX_NAME_LEN).trim();
      }

      result.push({ name, email });
    }

    return result;
  }

  // ─── Matching nome → e-mail ───────────────────────────────────────────────

  /**
   * Remove palavras duplicadas consecutivas de um nome normalizado.
   * O Meet às vezes exibe nomes duplicados (ex.: "João Silva João Silva").
   * Funciona apenas quando a segunda metade é idêntica à primeira
   * (mínimo 4 tokens, número par de tokens).
   *
   * Ex.: "amanda de lima baptista amanda de lima baptista" → "amanda de lima baptista"
   *
   * @param {string} normalized  Nome já normalizado (lowercase, sem acentos).
   * @returns {string}
   */
  function removeDuplicateWords(normalized) {
    const words = normalized.split(' ');
    const half = Math.floor(words.length / 2);

    if (words.length >= 4 && words.length % 2 === 0) {
      const firstHalf = words.slice(0, half).join(' ');
      const secondHalf = words.slice(half).join(' ');
      if (firstHalf === secondHalf) {
        return firstHalf;
      }
    }

    return normalized;
  }

  /**
   * Constrói um mapa de nome normalizado → e-mail a partir de entries importadas.
   *
   * Para cada entry, registra variações do nome (original + sem palavras duplicadas)
   * como chaves, aumentando a probabilidade de match exato antes do fuzzy.
   * Primeiro registro para uma chave vence (duplicatas ignoradas).
   *
   * Para modificar como nomes são chaveados: editar as `variations` aqui.
   *
   * @param {Array<{name:string, email:string}>} entries  Da parseEmailMapCsv.
   * @returns {Object<string, string>}  { [nomeNormalizado]: email }
   */
  function buildEmailLookup(entries) {
    const lookup = {};
    if (!Array.isArray(entries)) return lookup;

    for (const entry of entries) {
      const rawKey = normalizeName(entry && entry.name);
      const email = entry && entry.email ? String(entry.email).trim() : '';
      if (!rawKey || !email || !isValidEmail(email)) continue;

      // Variações: nome original + sem palavras duplicadas
      const variations = [
        rawKey,
        removeDuplicateWords(rawKey)
      ];

      const uniqueVariations = [...new Set(variations)];

      for (const key of uniqueVariations) {
        if (key && !Object.prototype.hasOwnProperty.call(lookup, key)) {
          lookup[key] = email;
        }
      }
    }

    return lookup;
  }

  /**
   * Divide um nome normalizado em tokens (palavras não-vazias).
   * Ex.: "jose da silva" → ["jose", "da", "silva"]
   *
   * @param {string} name
   * @returns {string[]}
   */
  function tokenizeNormalizedName(name) {
    return String(name || '')
      .split(' ')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  /**
   * Calcula a similaridade entre dois tokens individuais.
   *
   * Score:
   * • 1.0 se idênticos.
   * • minLen/maxLen se um é prefixo do outro com min 4 chars
   *   (suporta abreviações: "jose" vs "josefina" → ~0.57).
   * • 0.0 caso contrário (sem distância de edição — por performance).
   *
   * Threshold mínimo de aceitação: veja MIN_TOKEN_MATCH_SCORE em countCommonTokenScore.
   *
   * @param {string} a
   * @param {string} b
   * @returns {number}  Score entre 0 e 1.
   */
  function tokenSimilarityScore(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;

    const minLen = Math.min(a.length, b.length);
    const maxLen = Math.max(a.length, b.length);

    // Aceita prefixos com comprimento mínimo razoável (evita falsos positivos curtos)
    if (minLen >= 4 && (a.startsWith(b) || b.startsWith(a))) {
      return minLen / maxLen;
    }

    return 0;
  }

  /**
   * Conta a quantidade de tokens de `aTokens` que têm correspondência em `bTokens`.
   * Cada token de `bTokens` pode ser usado no máximo uma vez (matching bipartido guloso).
   *
   * @param {string[]} aTokens
   * @param {string[]} bTokens
   * @returns {{commonScore:number, matchedCount:number}}
   *   commonScore: soma dos scores (para desempate e ranking).
   *   matchedCount: número de pares que passaram o threshold.
   */
  function countCommonTokenScore(aTokens, bTokens) {
    if (!aTokens.length || !bTokens.length) {
      return { commonScore: 0, matchedCount: 0 };
    }

    /** Score mínimo para considerar dois tokens "correspondentes". */
    const MIN_TOKEN_MATCH_SCORE = 0.55;
    const used = new Array(bTokens.length).fill(false);
    let commonScore = 0;
    let matchedCount = 0;

    for (const aTok of aTokens) {
      let bestIdx = -1;
      let bestScore = 0;

      for (let i = 0; i < bTokens.length; i += 1) {
        if (used[i]) continue;
        const sim = tokenSimilarityScore(aTok, bTokens[i]);
        if (sim > bestScore) {
          bestScore = sim;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0 && bestScore >= MIN_TOKEN_MATCH_SCORE) {
        used[bestIdx] = true;
        commonScore += bestScore;
        matchedCount += 1;
      }
    }

    return { commonScore, matchedCount };
  }

  /**
   * Busca o e-mail mais provável para `normalizedName` no `lookupMap` via fuzzy match.
   *
   * Critérios de aceitação (TODOS obrigatórios):
   * • sameFirst: primeiro token bate com score ≥ 0.95 (primeiro nome igual ou prefixo).
   * • Uma das condições secundárias:
   *   – sameLast: último token bate com score ≥ 0.55 (sobrenome idêntico ou prefixo).
   *   – participantIsSubset: todos os tokens do participante batem no roster.
   *   – ≥ 66% dos tokens do participante têm correspondência no roster.
   * • Mínimo 2 tokens com correspondência.
   *
   * Score final = commonScore×10 + sameFirst?6 + sameLast?5 + subsets - sizePenalty
   *
   * Empate de score entre candidatos distintos → null (ambiguidade — segurança).
   *
   * PARA AJUSTAR THRESHOLD: modifique sameFirst (0.95), sameLast (0.55),
   * matchedCount mínimo (2), ou percentual mínimo (0.66).
   *
   * @param {string} normalizedName  Nome normalizado do participante.
   * @param {Object<string,string>} lookupMap  {nomeNormalizado: email}.
   * @returns {string|null}  E-mail encontrado ou null.
   */
  function findApproximateEmail(normalizedName, lookupMap) {
    const participantTokens = tokenizeNormalizedName(normalizedName);
    if (participantTokens.length < 2) return null;

    let best = null;
    let secondBest = null;

    for (const [lookupName, email] of Object.entries(lookupMap)) {
      if (!email || !isValidEmail(email)) continue;

      const lookupTokens = tokenizeNormalizedName(lookupName);
      if (lookupTokens.length < 2) continue;

      const { commonScore, matchedCount } = countCommonTokenScore(participantTokens, lookupTokens);
      if (matchedCount < 2) continue;

      const firstNameScore = tokenSimilarityScore(participantTokens[0], lookupTokens[0]);
      const lastNameScore = tokenSimilarityScore(
        participantTokens[participantTokens.length - 1],
        lookupTokens[lookupTokens.length - 1]
      );

      const sameFirst = firstNameScore >= 0.95;
      const sameLast = lastNameScore >= 0.55;
      const participantIsSubset = matchedCount >= participantTokens.length;
      const lookupIsSubset = matchedCount >= lookupTokens.length;

      // Critério de aceitação: primeiro nome obrigatório + condição secundária
      const acceptable =
        sameFirst && (
          sameLast ||
          participantIsSubset ||
          (matchedCount / participantTokens.length >= 0.66)
        );

      if (!acceptable) continue;

      // Score composto para rankear candidatos
      const sizePenalty = Math.abs(participantTokens.length - lookupTokens.length);
      const score =
        commonScore * 10 +
        (sameFirst ? 6 : 0) +
        (sameLast ? 5 : 0) +
        (participantIsSubset ? 4 : 0) +
        (lookupIsSubset ? 2 : 0) -
        sizePenalty;

      const candidate = { email, score, lookupName };
      if (!best || candidate.score > best.score) {
        secondBest = best;
        best = candidate;
      } else if (!secondBest || candidate.score > secondBest.score) {
        secondBest = candidate;
      }
    }

    // Ambiguidade: dois candidatos distintos com score igual → descarta
    if (best && secondBest && best.score === secondBest.score && best.lookupName !== secondBest.lookupName) {
      return null;
    }

    return best ? best.email : null;
  }

  /**
   * Enriquece uma lista de participantes com e-mails do lookup.
   *
   * Para cada participante sem e-mail:
   *   1. Tenta match exato pelo nome normalizado (via chave do lookup).
   *   2. Fallback: fuzzy matching via findApproximateEmail.
   *
   * Participantes que já têm e-mail válido são retornados sem modificação.
   * Os objetos originais NÃO são mutados (retorna clones via Object.assign).
   *
   * ATENÇÃO: buildEmailLookup deve ser chamado antes para preparar o mapa.
   *
   * @param {Array<{key:string, name:string, email?:string|null}>} participants
   * @param {Object<string,string>} lookup  De buildEmailLookup.
   * @returns {{participants: Array, mergedCount: number}}
   */
  function applyEmailMap(participants, lookup) {
    const list = Array.isArray(participants) ? participants : [];
    const map = lookup && typeof lookup === 'object' ? lookup : {};

    let mergedCount = 0;
    const mergedParticipants = list.map((p) => {
      const clone = Object.assign({}, p);
      const hasEmail = clone.email && isValidEmail(clone.email);
      if (hasEmail) return clone;  // já tem e-mail validado, não modifica

      const normalizedName = normalizeName(clone.name);
      // Remove possível duplicação de nome antes de buscar no lookup
      const key = removeDuplicateWords(normalizedName);
      if (!key) return clone;

      // Tentativa 1: match exato
      let mappedEmail = map[key];
      if (!mappedEmail || !isValidEmail(mappedEmail)) {
        // Tentativa 2: fuzzy matching por tokens
        mappedEmail = findApproximateEmail(key, map);
      }

      if (mappedEmail && isValidEmail(mappedEmail)) {
        clone.email = mappedEmail;
        mergedCount += 1;
      }
      return clone;
    });

    return {
      participants: mergedParticipants,
      mergedCount
    };
  }

  // ─── Exportação ───────────────────────────────────────────────────────────

  const exportsObject = {
    formatDurationHMS,
    formatDurationLong,
    formatDateTimeBR,
    normalizeName,
    meetingCodeFromUrl,
    extractEmails,
    isValidEmail,
    parseEmailMapCsv,
    buildEmailLookup,
    applyEmailMap
  };

  global.MPUtils = exportsObject;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObject;
  }
})(typeof window !== 'undefined' ? window : globalThis);
