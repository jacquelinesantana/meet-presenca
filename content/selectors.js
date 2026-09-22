// =============================================================================
// content/selectors.js — Extração de participantes da DOM do Google Meet
// =============================================================================
//
// ## Responsabilidade
//   Inspecionar o documento do Google Meet e retornar a lista atual de
//   participantes com nome, chave de identificação e e-mail (quando visível).
//   Toda a lógica de DOM fica concentrada aqui para facilitar manutenção
//   quando o Meet atualizar sua interface.
//
// ## Estratégia de coleta (em ordem de preferência)
//   1. Painel de pessoas   — role="list" / "listitem" dentro do painel
//      lateral; é a fonte mais completa quando aberto.
//   2. Grade de vídeo (tiles) — nós com data-participant-id; rápido mas
//      limitado a quem está visível na tela.
//   3. Fallback heurístico — aria-label / title / data-tooltip em qualquer
//      nó do contêiner principal; usado quando as fontes 1 e 2 falham.
//
// ## Filtragem de ruído
//   Os padrões RegExp estão centralizados em `content/noise-patterns.js`
//   (global.MP_NoisePatterns). Para adicionar novos falsos positivos, edite
//   aquele arquivo — nunca adicione RegExps diretamente aqui.
//
//   Além dos RegExps, isLikelyNoiseName() aplica heurísticas estruturais.
//
// ## Exportações (global.MP_Selectors)
//   collectParticipants(doc)        → CollectResult
//   findPeoplePanelButton(doc)      → HTMLElement | null
//   isParticipantsPanelVisible(doc) → boolean
//   isMeetingPage(url)              → boolean
//   cleanName(raw)                  → string
//   isLikelyNoiseName(name)         → boolean
//
// ## Dependências (carregadas antes por manifest.json)
//   global.MPUtils         (lib/utils.js)            — normalizeName, extractEmails, etc.
//   global.MP_NoisePatterns (content/noise-patterns.js) — RegExps de ruído
// =============================================================================

(function (global) {
  'use strict';

  // ─── Dependências ─────────────────────────────────────────────────────────

  /** @type {import('../lib/utils.js').MPUtils} */
  const U = global.MPUtils;

  /** @type {import('./noise-patterns.js').MP_NoisePatterns} */
  const NP = global.MP_NoisePatterns;

  // ─── Typedefs ─────────────────────────────────────────────────────────────

  /**
   * Participante coletado do DOM do Google Meet.
   *
   * @typedef {object} CollectedParticipant
   * @property {string}      key   - Chave única: data-participant-id ou "name:{normalizado}".
   * @property {string}      name  - Nome exibido no Meet (já limpo de sufixos de papel).
   * @property {string|null} email - E-mail encontrado no DOM, ou null se não visível.
   */

  /**
   * Resultado da coleta de participantes.
   *
   * @typedef {object} CollectResult
   * @property {CollectedParticipant[]}    participants - Lista de participantes únicos.
   * @property {{ panel: number, tiles: number }} sources - Contagem de inserções por fonte.
   */

  /**
   * Entrada interna do mapa acumulador de resultados.
   * Inclui o campo `_sources` para diagnóstico (não exposto na API pública).
   *
   * @typedef {object} ResultMapEntry
   * @property {string}      key      - Chave única do participante.
   * @property {string}      name     - Nome do participante.
   * @property {string|null} email    - E-mail ou null.
   * @property {Set<string>} _sources - Fontes que contribuíram para esta entrada.
   */

  // ─── Atalhos para os padrões de ruído ────────────────────────────────────
  // Importados de noise-patterns.js para uso local sem prefixo NP.

  const NOISE_ONLY_RE     = NP.NOISE_ONLY_RE;
  const NOISE_FRAGMENT_RE = NP.NOISE_FRAGMENT_RE;
  const NOISE_VERB_RE     = NP.NOISE_VERB_RE;
  const ROLE_SUFFIX_RE    = NP.ROLE_SUFFIX_RE;
  const SELF_MARKER_RE    = NP.SELF_MARKER_RE;

  // ---------------------------------------------------------------------------
  // Utilitários de string
  // ---------------------------------------------------------------------------

  /**
   * Normaliza espaços de um valor qualquer: coerce para string, reduz
   * múltiplos espaços/tabs/newlines a um único espaço e apara bordas.
   *
   * @param {*} s - Valor de entrada (qualquer tipo aceitável).
   * @returns {string} String com espaços normalizados.
   *
   * @example
   * safeText('  João   Silva\n') // → 'João Silva'
   * safeText(null)               // → ''
   */
  function safeText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Remove sufixos de papel e marcadores de "você mesmo" de um nome bruto.
   *
   * Esta função NÃO altera maiúsculas/minúsculas nem remove acentos — isso
   * é responsabilidade de `MPUtils.normalizeName`. Ela apenas faz a limpeza
   * sintática de sufixos conhecidos do Meet.
   *
   * Os padrões usados (ROLE_SUFFIX_RE, SELF_MARKER_RE) vêm de noise-patterns.js.
   *
   * @param {string} raw - Texto bruto extraído de um atributo DOM.
   * @returns {string} Nome limpo, com espaços normalizados.
   *
   * @example
   * cleanName('Ana Lima (Anfitriã)')  // → 'Ana Lima'
   * cleanName('Carlos (é você)')      // → 'Carlos'
   * cleanName('  Pedro   (Host)  ')   // → 'Pedro'
   */
  function cleanName(raw) {
    let name = safeText(raw);
    if (!name) return '';

    // Remove sufixos de papel entre parênteses (Anfitriã, Host, etc.)
    // Aplica em loop para cobrir múltiplas ocorrências (RegExp sem flag g)
    let prev;
    do {
      prev = name;
      name = name.replace(ROLE_SUFFIX_RE, ' ');
    } while (name !== prev);

    // Remove marcadores de "você mesmo"
    do {
      prev = name;
      name = name.replace(SELF_MARKER_RE, ' ');
    } while (name !== prev);

    // Normaliza espaços resultantes
    name = safeText(name);

    return name;
  }

  // ---------------------------------------------------------------------------
  // Classificador de ruído
  // ---------------------------------------------------------------------------

  /**
   * Decide se uma string é "ruído de UI" e deve ser descartada como nome
   * de participante. Aplica heurísticas em ordem crescente de custo.
   *
   * A função é intencionalmente conservadora: é preferível descartar um
   * candidato marginal a poluir a lista com textos de interface.
   *
   * Os RegExps (heurísticas 3, 4 e 7) vêm de `content/noise-patterns.js`.
   * Para adicionar novos padrões de ruído, edite aquele arquivo.
   *
   * **Heurísticas (em ordem):**
   * 1.  String vazia ou nula
   * 2.  Comprimento > 80 caracteres
   * 3.  Correspondência exata com NOISE_ONLY_RE (label de UI conhecido)
   * 4.  Contém fragmento de notificação de status (NOISE_FRAGMENT_RE)
   * 5.  O texto inteiro é um endereço de e-mail
   * 6.  Contém URL (http://, https://, www.)
   * 7.  Inicia com verbo de instrução (NOISE_VERB_RE)
   * 8.  Mais de 7 palavras
   * 9.  Termina com pontuação de sentença (. ! ?) ou padrão "Palavra: "
   * 10. Nome de ícone Material Design (snake_case sem espaço)
   * 11. Texto termina com número isolado (label de grupo de UI)
   *
   * @param {string} name - Candidato a nome, já passado por {@link cleanName}.
   * @returns {boolean} `true` se a string é ruído e deve ser ignorada.
   */
  function isLikelyNoiseName(name) {
    // Heurística 1 — vazio
    if (!name) return true;

    // Heurística 2 — tamanho excessivo
    if (name.length > 80) return true;

    // Heurística 3 — label de UI exato (via noise-patterns.js)
    if (NOISE_ONLY_RE.test(name)) return true;

    // Heurística 4 — fragmento de notificação de status (via noise-patterns.js)
    if (NOISE_FRAGMENT_RE.test(name)) return true;

    // Heurística 5 — texto é exatamente um e-mail (ex.: "joao@email.com")
    const emails = U.extractEmails(name);
    if (emails.length && U.normalizeName(name) === U.normalizeName(emails[0])) {
      return true;
    }

    // Heurística 6 — contém URL
    if (/https?:\/\//i.test(name) || /www\./i.test(name)) return true;

    // Heurística 7 — começa com verbo de instrução (via noise-patterns.js)
    if (NOISE_VERB_RE.test(name)) return true;

    // Heurística 8 — mais de 7 palavras (frase longa = provavelmente notificação)
    if (name.trim().split(/\s+/).length > 7) return true;

    // Heurística 9 — termina com pontuação de sentença ou padrão "Nome: texto"
    if (/[.!?]$/.test(name) || /\w:\s/.test(name)) return true;

    // Heurística 10 — nome de ícone Material Design (snake_case sem espaço)
    // Ex.: "keyboard_arrow_down", "mic_off", "person_add"
    if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) return true;

    // Heurística 11 — texto termina com número isolado (label de grupo de UI)
    // Ex.: "Colaboradores 1", "Convidados 3", "Sala 2"
    if (/\s\d+$/.test(name)) return true;

    return false;
  }

  // ---------------------------------------------------------------------------
  // Extração de candidatos de texto a partir de um nó DOM
  // ---------------------------------------------------------------------------

  /**
   * Coleta todos os valores de texto candidatos a nome ou e-mail de um nó
   * DOM e de seus descendentes com atributos nomeados.
   *
   * A ordem de retorno é: atributos do próprio nó → innerText do nó →
   * atributos dos descendentes nomeados → innerText dos descendentes.
   * O chamador deve iterar na ordem retornada, parando no primeiro
   * candidato válido.
   *
   * @param {Element} node - Nó DOM a inspecionar.
   * @returns {string[]} Array de strings candidatas (pode conter duplicatas).
   */
  function collectTextCandidates(node) {
    const values = [];
    if (!node || !node.getAttribute) return values;

    // Atributos em ordem de preferência: mais específicos primeiro.
    const attrs = [
      'data-self-name',        // nome do próprio usuário (Meet)
      'data-participant-name', // nome de participante (Meet)
      'data-tooltip',          // tooltip de hover
      'aria-label',            // rótulo de acessibilidade
      'title'                  // título HTML
    ];

    // Atributos do próprio nó
    for (const attr of attrs) {
      const v = node.getAttribute(attr);
      if (v) values.push(v);
    }

    // Texto visível do próprio nó (pode conter nome se for tile de vídeo)
    if (node.innerText) values.push(node.innerText);

    // Descendentes que possuem atributos nomeados
    const namedChildren = node.querySelectorAll(
      '[data-self-name],[data-participant-name],[data-tooltip],[aria-label],[title]'
    );
    for (const child of namedChildren) {
      for (const attr of attrs) {
        const v = child.getAttribute(attr);
        if (v) values.push(v);
      }
      if (child.innerText) values.push(child.innerText);
    }

    return values;
  }

  // ---------------------------------------------------------------------------
  // Extração de e-mail
  // ---------------------------------------------------------------------------

  /**
   * Tenta extrair um endereço de e-mail válido de um nó DOM e seus
   * descendentes, em melhor esforço.
   *
   * O Google Meet raramente expõe e-mails no DOM; esta função cobre os
   * casos excepcionais em que o endereço aparece em tooltip ou aria-label.
   *
   * @param {Element|null} node - Nó DOM a inspecionar.
   * @returns {string|null} Primeiro e-mail válido encontrado, ou `null`.
   */
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

  // ---------------------------------------------------------------------------
  // Extração de nome
  // ---------------------------------------------------------------------------

  /**
   * Extrai o nome de um participante a partir de um nó DOM, aplicando
   * limpeza e filtragem de ruído.
   *
   * Itera pelos candidatos de texto retornados por
   * {@link collectTextCandidates} e retorna o primeiro que passa pelas
   * verificações de {@link cleanName} e {@link isLikelyNoiseName}.
   *
   * @param {Element|null} node - Nó DOM do tile ou item de painel.
   * @returns {string} Nome limpo do participante, ou string vazia se nenhum
   *   candidato válido for encontrado.
   */
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

  // ---------------------------------------------------------------------------
  // Chave de participante
  // ---------------------------------------------------------------------------

  /**
   * Determina a chave única que identifica um participante nesta sessão de
   * reunião.
   *
   * **Estratégia de chave (por precedência):**
   * 1. `data-participant-id` — ID atribuído pelo Meet, estável durante a
   *    reunião. Procura no nó, no ancestral mais próximo ou no descendente.
   * 2. `"name:" + normalizeName(name)` — fallback quando o ID não está
   *    disponível; pode mesclar participantes com nomes idênticos.
   *
   * @param {Element|null} node - Nó DOM inspecionado.
   * @param {string} name - Nome já extraído por {@link nameFromNode}.
   * @returns {string|null} Chave única, ou `null` se não for possível
   *   determinar uma chave.
   */
  function participantKeyFromNode(node, name) {
    if (!node) return null;

    // Busca data-participant-id no nó, no ancestral mais próximo ou descendente
    const pidHolder =
      node.closest('[data-participant-id]') ||
      node.querySelector('[data-participant-id]') ||
      node;
    const pid = pidHolder.getAttribute && pidHolder.getAttribute('data-participant-id');
    if (pid) return pid;

    // Fallback: chave baseada em nome normalizado
    const normalized = U.normalizeName(name);
    if (normalized) return 'name:' + normalized;

    return null;
  }

  // ---------------------------------------------------------------------------
  // Mapa de resultado (upsert)
  // ---------------------------------------------------------------------------

  /**
   * Insere ou atualiza um item no mapa de resultados de participantes.
   *
   * **Política de atualização:**
   * - Se a chave já existe: atualiza nome e e-mail apenas se o novo valor
   *   trouxer informação adicional (e-mail ausente → preenchido).
   * - Se a chave não existe: insere normalmente.
   * - Registra a fonte (`source`) para fins de diagnóstico.
   *
   * @param {Map<string, ResultMapEntry>} resultMap - Mapa acumulador de participantes.
   * @param {CollectedParticipant} item - Participante a inserir ou atualizar.
   * @param {'tiles'|'panel'|'fallback'} source - Identificador da fonte de coleta.
   * @returns {boolean} `true` se um novo participante foi inserido.
   */
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

    // Atualiza nome apenas se o novo for diferente (pode ser mais completo)
    if (item.name && item.name !== existing.name) {
      existing.name = item.name;
    }
    // Preenche e-mail somente se ainda não havia
    if (!existing.email && item.email) {
      existing.email = item.email;
    }
    existing._sources.add(source);
    return false;
  }

  // ---------------------------------------------------------------------------
  // Construção de objeto participante a partir de nó
  // ---------------------------------------------------------------------------

  /**
   * Constrói um objeto participante completo a partir de um nó DOM,
   * aplicando toda a cadeia de extração e filtragem.
   *
   * Retorna `null` se o nó não representar um participante real (UI noise,
   * próprio usuário, ausência de chave válida).
   *
   * @param {Element} node - Nó DOM candidato.
   * @returns {CollectedParticipant|null} Objeto participante ou `null` se descartado.
   */
  function buildParticipantFromNode(node) {
    const name = nameFromNode(node);
    if (!name || isLikelyNoiseName(name)) return null;

    // Descarta o próprio usuário (identificado por nome normalizado)
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

  // ---------------------------------------------------------------------------
  // Coleta por fonte: tiles (grade de vídeo)
  // ---------------------------------------------------------------------------

  /**
   * Coleta participantes a partir dos tiles da grade de vídeo do Meet.
   *
   * Seleciona todos os nós com `data-participant-id` ou `data-self-name`
   * no documento. Essa fonte é rápida mas limitada a quem está visível
   * na grade de vídeo (sem o painel lateral).
   *
   * @param {Document} doc - Documento da página do Meet.
   * @param {Map<string, ResultMapEntry>} resultMap - Mapa acumulador de resultados.
   * @returns {number} Quantidade de novos participantes inseridos nesta chamada.
   */
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

  // ---------------------------------------------------------------------------
  // Coleta por fonte: painel de pessoas
  // ---------------------------------------------------------------------------

  /**
   * Localiza os contêineres do painel de pessoas do Meet no documento.
   *
   * Usa duas estratégias combinadas para robustez contra mudanças de UI:
   * 1. Busca por `aria-label` contendo "People", "Pessoas", etc., e sobe
   *    para o contêiner de diálogo/painel mais próximo.
   * 2. Busca por `role="list"` e sobe para o contêiner de painel.
   *
   * Retorna um array deduplicado de elementos candidatos ao painel.
   *
   * @param {Document} doc - Documento da página do Meet.
   * @returns {Element[]} Array de elementos contêiner do painel de pessoas.
   */
  function findPanelContainers(doc) {
    const candidates = new Set();

    // Estratégia 1: busca por aria-label de "pessoas/participantes"
    const byAria = doc.querySelectorAll(
      '[aria-label*="People" i], [aria-label*="Pessoas" i], ' +
      '[aria-label*="Participants" i], [aria-label*="Participantes" i]'
    );
    for (const el of byAria) {
      const panel = el.closest('[role="dialog"], [role="tabpanel"], [jsname], section, aside');
      if (panel) candidates.add(panel);
    }

    // Estratégia 2: busca por listas (role="list") que ficam dentro do painel
    const byList = doc.querySelectorAll('[role="list"]');
    for (const el of byList) {
      const panel = el.closest('[role="dialog"], [role="tabpanel"], [jsname], section, aside') || el;
      candidates.add(panel);
    }

    return Array.from(candidates);
  }

  /**
   * Coleta participantes a partir do painel lateral de pessoas do Meet.
   *
   * O painel de pessoas é a fonte mais completa porque lista TODOS os
   * participantes, mesmo os que não aparecem na grade de vídeo. Por isso,
   * é consultado em primeiro lugar em {@link collectParticipants}.
   *
   * @param {Document} doc - Documento da página do Meet.
   * @param {Map<string, ResultMapEntry>} resultMap - Mapa acumulador de resultados.
   * @returns {number} Quantidade de novos participantes inseridos nesta chamada.
   */
  function collectFromPanel(doc, resultMap) {
    let count = 0;
    const panels = findPanelContainers(doc);

    for (const panel of panels) {
      // Dentro de cada contêiner de painel, busca APENAS itens de lista e tiles.
      // [jsname] foi removido — ele existe em quase todos os elementos do Meet
      // (botões, ícones, textos) e era a principal causa de falsos positivos.
      const items = panel.querySelectorAll('[role="listitem"], [data-participant-id]');
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

  // ---------------------------------------------------------------------------
  // Coleta por fallback heurístico
  // ---------------------------------------------------------------------------

  /**
   * Coleta participantes usando heurística ampla quando as fontes primárias
   * (painel e tiles) não retornaram nenhum resultado.
   *
   * Busca qualquer nó com `aria-label`, `title` ou `data-tooltip` dentro
   * do contêiner principal da reunião e filtra pelos classificadores de
   * ruído. É o método menos preciso mas serve como último recurso.
   *
   * @param {Document} doc - Documento da página do Meet.
   * @param {Map<string, ResultMapEntry>} resultMap - Mapa acumulador de resultados.
   * @returns {void}
   */
  function collectFromFallbackHeuristic(doc, resultMap) {
    // Tenta subir ao contêiner principal a partir de um tile conhecido
    const gridContainer =
      doc.querySelector('[data-participant-id]')
        ?.closest('[role="main"], main, [jsname]') || doc.body;
    if (!gridContainer) return;

    const nodes = gridContainer.querySelectorAll('[aria-label],[title],[data-tooltip]');
    for (const node of nodes) {
      const item = buildParticipantFromNode(node);
      if (!item) continue;
      upsertParticipant(resultMap, item, 'tiles');
    }
  }

  // ---------------------------------------------------------------------------
  // API pública de coleta
  // ---------------------------------------------------------------------------

  /**
   * Coleta todos os participantes visíveis na reunião atual.
   *
   * Consulta as fontes em ordem de prioridade:
   * 1. Painel de pessoas (mais completo)
   * 2. Grade de vídeo / tiles
   * 3. Fallback heurístico (apenas se as fontes 1 e 2 retornarem zero)
   *
   * O resultado é deduplicado pelo mapa interno usando a chave do
   * participante. E-mails de fontes diferentes são mesclados sem
   * sobrescrever dados já existentes.
   *
   * @param {Document} doc - Documento do Google Meet.
   * @returns {CollectResult} Lista de participantes únicos e contagem por fonte.
   */
  function collectParticipants(doc) {
    /** @type {Map<string, ResultMapEntry>} */
    const resultMap = new Map();

    // Coleta nas duas fontes primárias
    const panelCount = collectFromPanel(doc, resultMap);
    const tilesCount = collectFromTiles(doc, resultMap);

    // Fallback apenas quando ambas as fontes falharam
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

  /**
   * Verifica se o painel lateral de pessoas está visível e contém
   * participantes coletados.
   *
   * Usado por `content.js` para exibir feedback ao usuário sobre a
   * cobertura de captura (o painel garante lista completa).
   *
   * @param {Document} doc - Documento da página do Meet.
   * @returns {boolean} `true` se o painel retornou ao menos um participante.
   */
  function isParticipantsPanelVisible(doc) {
    const data = collectParticipants(doc);
    return data.sources.panel > 0;
  }

  /**
   * Localiza o botão "Pessoas" / "People" na barra de controles do Meet.
   *
   * Usado por `content.js` para abrir o painel de pessoas programaticamente
   * quando o popup solicita via mensagem MP_OPEN_PEOPLE_PANEL.
   *
   * @param {Document} doc - Documento da página do Meet.
   * @returns {HTMLButtonElement|null} Botão encontrado, ou `null` se não visível.
   */
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

  /**
   * Verifica se a URL fornecida corresponde a uma página de reunião do Meet.
   *
   * Delega para `MPUtils.meetingCodeFromUrl` — retorna `true` quando a URL
   * contém um código de reunião válido (ex.: `meet.google.com/abc-defg-hij`).
   *
   * @param {string} url - URL a verificar.
   * @returns {boolean} `true` se for página de reunião ativa.
   */
  function isMeetingPage(url) {
    return !!U.meetingCodeFromUrl(url);
  }

  // ---------------------------------------------------------------------------
  // Exportações do módulo
  // ---------------------------------------------------------------------------

  const exportsObject = {
    /** Coleta todos os participantes visíveis. @type {function(Document): CollectResult} */
    collectParticipants,
    /** Localiza o botão do painel de pessoas. @type {function(Document): HTMLElement|null} */
    findPeoplePanelButton,
    /** Verifica se o painel de pessoas está aberto e com dados. @type {function(Document): boolean} */
    isParticipantsPanelVisible,
    /** Verifica se a URL é uma página de reunião do Meet. @type {function(string): boolean} */
    isMeetingPage,
    /** Limpa um nome bruto (remove roles, self-markers). @type {function(string): string} */
    cleanName,
    /** Classifica uma string como ruído de UI. @type {function(string): boolean} */
    isLikelyNoiseName
  };

  // Exposição global (uso em content scripts da extensão)
  global.MP_Selectors = exportsObject;

  // Exposição CommonJS (uso em testes Node.js)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObject;
  }
})(typeof window !== 'undefined' ? window : globalThis);
