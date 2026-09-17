(function (global) {
  'use strict';

  const U = global.MPUtils;

  // Centralização de seletores do Meet (manutenção futura):
  // 1) Priorizar data-participant-id (grade e painel).
  // 2) Fallback para data-self-name (próprio usuário) e elementos com role list/listitem.
  // 3) Heurísticas conservadoras por aria-label/title/tooltip quando o Meet mudar o DOM.

  const NOISE_ONLY_RE = /^(você|voce|you|chat|mensagens|messages|atividades|activities|pessoas|people|participantes|participants|convidar|invite|adicionar|add|apresentando|presenting|aguardando|waiting|controles do anfitrião|host controls|configurações|configuracoes|settings)$/i;
  const ROLE_SUFFIX_RE = /\s*\((anfitri[aã]o|host|convidado|guest|apresentador|presenter)\)\s*/gi;
  const SELF_MARKER_RE = /(é você|e voce|you)\b/gi;

  function safeText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function cleanName(raw) {
    let name = safeText(raw);
    if (!name) return '';

    name = name.replace(ROLE_SUFFIX_RE, ' ');
    name = name.replace(SELF_MARKER_RE, ' ');
    name = safeText(name);

    return name;
  }

  function isLikelyNoiseName(name) {
    if (!name) return true;
    if (name.length > 80) return true;
    if (NOISE_ONLY_RE.test(name)) return true;

    const emails = U.extractEmails(name);
    if (emails.length && U.normalizeName(name) === U.normalizeName(emails[0])) {
      return true;
    }

    if (/https?:\/\//i.test(name) || /www\./i.test(name)) {
      return true;
    }

    return false;
  }

  function collectTextCandidates(node) {
    const values = [];
    if (!node || !node.getAttribute) return values;

    const attrs = [
      'data-self-name',
      'data-participant-name',
      'data-tooltip',
      'aria-label',
      'title'
    ];

    for (const attr of attrs) {
      const v = node.getAttribute(attr);
      if (v) values.push(v);
    }

    if (node.innerText) values.push(node.innerText);

    const namedChildren = node.querySelectorAll('[data-self-name],[data-participant-name],[data-tooltip],[aria-label],[title]');
    for (const child of namedChildren) {
      for (const attr of attrs) {
        const v = child.getAttribute(attr);
        if (v) values.push(v);
      }
      if (child.innerText) values.push(child.innerText);
    }

    return values;
  }

  function extractEmailBestEffort(node) {
    if (!node) return null;

    const values = collectTextCandidates(node);
    for (const value of values) {
      const emails = U.extractEmails(value);
      if (emails.length) {
        const email = emails[0].trim();
        if (U.isValidEmail(email)) return email;
      }
    }

    return null;
  }

  function nameFromNode(node) {
    if (!node) return '';

    const values = collectTextCandidates(node);
    for (const value of values) {
      const cleaned = cleanName(value);
      if (!cleaned || isLikelyNoiseName(cleaned)) continue;
      return cleaned;
    }

    return '';
  }

  function participantKeyFromNode(node, name) {
    if (!node) return null;

    const pidHolder = node.closest('[data-participant-id]') || node.querySelector('[data-participant-id]') || node;
    const pid = pidHolder.getAttribute && pidHolder.getAttribute('data-participant-id');
    if (pid) return pid;

    const normalized = U.normalizeName(name);
    if (normalized) return 'name:' + normalized;

    return null;
  }

  function upsertParticipant(resultMap, item, source) {
    if (!item || !item.key || !item.name) return false;

    const existing = resultMap.get(item.key);
    if (!existing) {
      resultMap.set(item.key, {
        key: item.key,
        name: item.name,
        email: item.email || null,
        _sources: new Set([source])
      });
      return true;
    }

    if (item.name && item.name !== existing.name) {
      existing.name = item.name;
    }
    if (!existing.email && item.email) {
      existing.email = item.email;
    }
    existing._sources.add(source);
    return false;
  }

  function buildParticipantFromNode(node) {
    const name = nameFromNode(node);
    if (!name || isLikelyNoiseName(name)) return null;

    const norm = U.normalizeName(name);
    if (norm === 'voce' || norm === 'você' || norm === 'you') {
      return null;
    }

    const key = participantKeyFromNode(node, name);
    if (!key) return null;

    const email = extractEmailBestEffort(node);

    return {
      key,
      name,
      email: email || null
    };
  }

  function collectFromTiles(doc, resultMap) {
    let count = 0;

    const nodes = doc.querySelectorAll('[data-participant-id], [data-self-name]');
    for (const node of nodes) {
      const item = buildParticipantFromNode(node);
      if (!item) continue;
      if (upsertParticipant(resultMap, item, 'tiles')) {
        count += 1;
      }
    }

    return count;
  }

  function findPanelContainers(doc) {
    const candidates = new Set();

    const byAria = doc.querySelectorAll('[aria-label*="People" i], [aria-label*="Pessoas" i], [aria-label*="Participants" i], [aria-label*="Participantes" i]');
    for (const el of byAria) {
      const panel = el.closest('[role="dialog"], [role="tabpanel"], [jsname], section, aside');
      if (panel) candidates.add(panel);
    }

    const byList = doc.querySelectorAll('[role="list"]');
    for (const el of byList) {
      const panel = el.closest('[role="dialog"], [role="tabpanel"], [jsname], section, aside') || el;
      candidates.add(panel);
    }

    return Array.from(candidates);
  }

  function collectFromPanel(doc, resultMap) {
    let count = 0;
    const panels = findPanelContainers(doc);

    for (const panel of panels) {
      const items = panel.querySelectorAll('[role="listitem"], [data-participant-id], [jsname]');
      for (const itemNode of items) {
        const item = buildParticipantFromNode(itemNode);
        if (!item) continue;
        if (upsertParticipant(resultMap, item, 'panel')) {
          count += 1;
        }
      }
    }

    return count;
  }

  function collectFromFallbackHeuristic(doc, resultMap) {
    const gridContainer = doc.querySelector('[data-participant-id]')?.closest('[role="main"], main, [jsname]') || doc.body;
    if (!gridContainer) return;

    const nodes = gridContainer.querySelectorAll('[aria-label],[title],[data-tooltip]');
    for (const node of nodes) {
      const item = buildParticipantFromNode(node);
      if (!item) continue;
      upsertParticipant(resultMap, item, 'tiles');
    }
  }

  function collectParticipants(doc) {
    const resultMap = new Map();

    const panelCount = collectFromPanel(doc, resultMap);
    const tilesCount = collectFromTiles(doc, resultMap);

    if (!panelCount && !tilesCount) {
      collectFromFallbackHeuristic(doc, resultMap);
    }

    const participants = Array.from(resultMap.values()).map((p) => ({
      key: p.key,
      name: p.name,
      email: p.email || null
    }));

    return {
      participants,
      sources: {
        panel: panelCount,
        tiles: tilesCount
      }
    };
  }

  function isParticipantsPanelVisible(doc) {
    const data = collectParticipants(doc);
    return data.sources.panel > 0;
  }

  function findPeoplePanelButton(doc) {
    const buttons = doc.querySelectorAll('button[aria-label], [role="button"][aria-label]');
    for (const button of buttons) {
      const label = safeText(button.getAttribute('aria-label'));
      if (!label) continue;
      if (/(pessoas|people|participantes|participants)/i.test(label)) {
        return button;
      }
    }
    return null;
  }

  function isMeetingPage(url) {
    return !!U.meetingCodeFromUrl(url);
  }

  const exportsObject = {
    collectParticipants,
    findPeoplePanelButton,
    isParticipantsPanelVisible,
    isMeetingPage,
    cleanName,
    isLikelyNoiseName
  };

  global.MP_Selectors = exportsObject;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObject;
  }
})(typeof window !== 'undefined' ? window : globalThis);
