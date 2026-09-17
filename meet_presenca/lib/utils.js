(function (global) {
  'use strict';

  const MAX_NAME_LEN = 80;

  function toSafeInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.floor(n));
  }

  function formatDurationHMS(totalSeconds) {
    const sec = toSafeInt(totalSeconds);
    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const seconds = sec % 60;
    return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }

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

  function normalizeName(s) {
    const base = String(s || '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();

    return base
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

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

  function isValidEmail(s) {
    if (typeof s !== 'string') return false;
    const text = s.trim();
    if (!text) return false;
    return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}$/i.test(text);
  }

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

  function parseEmailMapCsv(text) {
    const src = String(text || '');
    const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];

    const delimiter = chooseDelimiter(lines[0]);
    const firstRow = parseDelimitedLine(lines[0], delimiter).map((v) => v.trim());

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

  function removeDuplicateWords(normalized) {
    // Remove palavras duplicadas consecutivas
    // Ex: "amanda de lima baptista amanda de lima baptista" -> "amanda de lima baptista"
    const words = normalized.split(' ');
    const half = Math.floor(words.length / 2);
    
    // Verifica se a primeira metade é igual à segunda metade
    if (words.length >= 4 && words.length % 2 === 0) {
      const firstHalf = words.slice(0, half).join(' ');
      const secondHalf = words.slice(half).join(' ');
      if (firstHalf === secondHalf) {
        return firstHalf;
      }
    }
    
    return normalized;
  }

  function buildEmailLookup(entries) {
    const lookup = {};
    if (!Array.isArray(entries)) return lookup;

    for (const entry of entries) {
      const rawKey = normalizeName(entry && entry.name);
      const email = entry && entry.email ? String(entry.email).trim() : '';
      if (!rawKey || !email || !isValidEmail(email)) continue;
      
      // Cria múltiplas variações do nome para melhorar o matching
      const variations = [
        rawKey,                           // Nome original normalizado
        removeDuplicateWords(rawKey)      // Nome sem duplicações
      ];
      
      // Remove duplicatas das variações
      const uniqueVariations = [...new Set(variations)];
      
      // Adiciona todas as variações ao lookup
      for (const key of uniqueVariations) {
        if (key && !Object.prototype.hasOwnProperty.call(lookup, key)) {
          lookup[key] = email;
        }
      }
    }

    return lookup;
  }

  function tokenizeNormalizedName(name) {
    return String(name || '')
      .split(' ')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  function tokenSimilarityScore(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;

    const minLen = Math.min(a.length, b.length);
    const maxLen = Math.max(a.length, b.length);

    // Aceita abreviações/prefixos com tamanho mínimo razoável
    if (minLen >= 4 && (a.startsWith(b) || b.startsWith(a))) {
      return minLen / maxLen;
    }

    return 0;
  }

  function countCommonTokenScore(aTokens, bTokens) {
    if (!aTokens.length || !bTokens.length) {
      return { commonScore: 0, matchedCount: 0 };
    }

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

      // Regra de aceitação para nome aproximado (sempre exige primeiro nome igual)
      const acceptable =
        sameFirst && (
          sameLast ||
          participantIsSubset ||
          (matchedCount / participantTokens.length >= 0.66)
        );

      if (!acceptable) continue;

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

    // Evita correspondência ambígua
    if (best && secondBest && best.score === secondBest.score && best.lookupName !== secondBest.lookupName) {
      return null;
    }

    return best ? best.email : null;
  }

  function applyEmailMap(participants, lookup) {
    const list = Array.isArray(participants) ? participants : [];
    const map = lookup && typeof lookup === 'object' ? lookup : {};

    let mergedCount = 0;
    const mergedParticipants = list.map((p) => {
      const clone = Object.assign({}, p);
      const hasEmail = clone.email && isValidEmail(clone.email);
      if (hasEmail) return clone;

      const normalizedName = normalizeName(clone.name);
      const key = removeDuplicateWords(normalizedName);
      if (!key) return clone;

      let mappedEmail = map[key];
      if (!mappedEmail || !isValidEmail(mappedEmail)) {
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
