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
//   O Meet expõe muitos textos de UI (botões, notificações, painéis) nos
//   mesmos atributos usados para nomes. Três padrões eliminam falsos positivos:
//
//   NOISE_ONLY_RE     — correspondência EXATA com labels de botão/painel
//   NOISE_FRAGMENT_RE — substrings de notificações de ação (ex.: "ativou o microfone")
//   NOISE_VERB_RE     — strings que começam com verbo de instrução
//
//   Além dos RegExp, isLikelyNoiseName() aplica mais 6 heurísticas estruturais.
//
// ## Exportações (global.MP_Selectors)
//   collectParticipants(doc)        → { participants[], sources }
//   findPeoplePanelButton(doc)      → HTMLElement | null
//   isParticipantsPanelVisible(doc) → boolean
//   isMeetingPage(url)              → boolean
//   cleanName(raw)                  → string
//   isLikelyNoiseName(name)         → boolean
//
// ## Dependências
//   global.MPUtils (lib/utils.js) — normalizeName, extractEmails,
//                                   isValidEmail, meetingCodeFromUrl
// =============================================================================

(function (global) {
  'use strict';

  /** @type {import('../lib/utils.js').MPUtils} */
  const U = global.MPUtils;

  // ---------------------------------------------------------------------------
  // Expressões regulares de filtragem de ruído
  // ---------------------------------------------------------------------------

  /**
   * NOISE_ONLY_RE — Corresponde a strings que são EXATAMENTE labels de
   * interface do Google Meet (botões, painéis, menus, ações).
   *
   * Âncoras ^ e $ garantem correspondência do string inteiro.
   * Case-insensitive (flag /i). O flag /u não é necessário porque todos os
   * termos são ASCII ou Latin-1 simples.
   *
   * **Como manter:** quando o Meet introduzir novos elementos de UI que
   * aparecam como falsos positivos de nome, basta adicionar o texto aqui.
   * Não há problema em ter muitos termos — o RegExp é compilado uma vez.
   */
  const NOISE_ONLY_RE = /^(você|voce|you|chat|mensagens|messages|atividades|activities|pessoas|people|participantes|participants|convidar|invite|adicionar|add|apresentando|presenting|aguardando|waiting|controles do anfitrião|host controls|configurações|configuracoes|settings|reunião|reuniao|meeting|encerrar|end call|leave call|microfone|microphone|mic|câmera|camera|cam|compartilhar tela|share screen|share|silenciar|mute|unmute|fixar|pin|desafixar|unpin|remover|remove|denunciar|report|bloquear|block|ajuda|help|mais opções|more options|reações|reactions|enquete|poll|quiz|transcrição|transcript|legenda|caption|closed caption|breakout rooms|salas de grupo|sala|room|desligar|turn off|turn on|segurança|security|gravar|record|recording|gravando|levantar a mão|raise hand|baixar a mão|lower hand|emoji|informações|info|ok|yes|no|sim|não|nao|close|cancelar|cancel|confirmar|confirm|salvar|save|editar|edit|copiar|copy|colar|paste|enviar|send|voltar|back|próximo|next|anterior|previous|search|pesquisar pessoas|adic\. pessoas|todos com o som desativado|permitir que os colaboradores ativem o microfone)$/i;

  /**
   * NOISE_FRAGMENT_RE — Corresponde a substrings de notificações de status
   * emitidas pelo Google Meet durante a reunião.
   *
   * Diferente de NOISE_ONLY_RE, verifica se a substring ESTÁ CONTIDA na
   * string (não correspondência exata). Detecta avisos como:
   *   "João ativou o microfone"
   *   "Maria está apresentando para todos"
   *   "Pedro saiu da reunião"
   *
   * Essas strings aparecem esporadicamente em tooltips e aria-labels de
   * elementos de status e não representam nomes de pessoa.
   */
  const NOISE_FRAGMENT_RE = /ativou o microfone|desativou o microfone|ativou a câmera|desativou a câmera|está apresentando|apresentando para|entrou na reunião|saiu da reunião|entrou no meeting|saiu do meeting|foi silenciado|foi removido|foi rejeitado|fixado por|apresentando tela|compartilhando tela|está fixado|ativou áudio|desativou áudio|levantou a mão|baixou a mão|todos com o som|colaboradores ativem|ativar o microfone/i;

  /**
   * NOISE_VERB_RE — Corresponde a strings que começam com um verbo de
   * instrução em português ou inglês, típico de aria-labels de botões.
   *
   * Exemplos de strings capturadas:
   *   "Clique para silenciar o microfone"
   *   "Ativar câmera"
   *   "Open participant panel"
   *
   * O `\b` garante que o verbo termina como palavra completa (evita falsos
   * positivos com nomes que comecem por sílabas coincidentes).
   */
  const NOISE_VERB_RE = /^(clique|toque|pressione|ativar|desativar|abrir|fechar|entrar|sair|acessar|selecionar|compartilhar|silenciar|remover|denunciar|bloquear|fixar|convidar|pesquisar|permitir|adicionar|adic\.|click|tap|press|open|close|enter|leave|select|share|mute|remove|report|block|pin|invite|search)\b/i;

  /**
   * ROLE_SUFFIX_RE — Remove sufixos de papel/função escritos entre
   * parênteses que o Meet acrescenta ao nome exibido.
   *
   * Exemplos:
   *   "Ana Lima (Anfitriã)"   → "Ana Lima"
   *   "Carlos (Host)"         → "Carlos"
   *   "Paula (Apresentadora)" → "Paula"
   *
   * `gi` = global + case-insensitive, pois pode haver múltiplas ocorrências.
   */
  const ROLE_SUFFIX_RE = /\s*\((anfitri[aã]o|host|convidado|guest|apresentador|presenter)\)\s*/gi;

  /**
   * SELF_MARKER_RE — Remove marcadores que o Meet adiciona ao próprio
   * usuário para indicar que aquele tile é "você mesmo".
   *
   * Exemplos:
   *   "Maria (é você)"  → "Maria"
   *   "Carlos (you)"    → "Carlos"
   */
  const SELF_MARKER_RE = /(é você|e voce|you)\b/gi;

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
    name = name.replace(ROLE_SUFFIX_RE, ' ');
    // Remove marcadores de "você mesmo"
    name = name.replace(SELF_MARKER_RE, ' ');
    // Normaliza espaços resultantes
    name = safeText(name);

    return name;
  }

  // ---------------------------------------------------------------------------
  // Classificador de ruído
  // ---------------------------------------------------------------------------

  /**
   * Decide se uma string é "ruído de UI" e deve ser descartada como nome
   * de participante. Aplica 9 heurísticas em ordem crescente de custo.
   *
   * A função é intencionalmente conservadora: é preferível descartar um
   * candidato marginal a poluir a lista com textos de interface.
   *
   * **Heurísticas (em ordem):**
   * 1. String vazia ou nula
   * 2. Comprimento > 80 caracteres (muito longa para ser nome real)
   * 3. Correspondência exata com NOISE_ONLY_RE (label de UI conhecido)
   * 4. Contém fragmento de notificação de status (NOISE_FRAGMENT_RE)
   * 5. O texto inteiro é um endereço de e-mail (não um nome)
   * 6. Contém URL (http://, https://, www.)
   * 7. Inicia com verbo de instrução (NOISE_VERB_RE)
   * 8. Mais de 7 palavras (provavelmente uma frase ou notificação longa)
   * 9. Termina com pontuação de sentença (. ! ?) ou contém padrão "Palavra: "
   *
   * @param {string} name - Candidato a nome, já passado por {@link cleanName}.
   * @returns {boolean} `true` se a string é ruído e deve ser ignorada.
   */
  function isLikelyNoiseName(name) {
    // Heurística 1 — vazio
    if (!name) return true;

    // Heurística 2 — tamanho excessivo
    if (name.length > 80) return true;

    // Heurística 3 — label de UI exato
    if (NOISE_ONLY_RE.test(name)) return true;

    // Heurística 4 — fragmento de notificação de status do Meet
    if (NOISE_FRAGMENT_RE.test(name)) return true;

    // Heurística 5 — texto é exatamente um e-mail (ex.: "joao@email.com")
    const emails = U.extractEmails(name);
    if (emails.length && U.normalizeName(name) === U.normalizeName(emails[0])) {
      return true;
    }

    // Heurística 6 — contém URL
    if (/https?:\/\//i.test(name) || /www\./i.test(name)) return true;

    // Heurística 7 — começa com verbo de instrução (aria-label de botão)
    if (NOISE_VERB_RE.test(name)) return true;

    // Heurística 8 — mais de 7 palavras (frase longa = provavelmente notificação)
    if (name.trim().split(/\s+/).length > 7) return true;

    // Heurística 9 — termina com pontuação de sentença ou padrão "Nome: texto"
    if (/[.!?]$/.test(name) || /\w:\s/.test(name)) return true;

    // Heurística 10 — nome de ícone Material Design (snake_case sem espaço)
    // Ex.: "keyboard_arrow_down", "mic_off", "person_add", "search"
    // Ícones do Material Icons nunca contêm espaço e usam _ como separador.
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
      'data-self-name',       // nome do próprio usuário (Meet)
      'data-participant-name', // nome de participante (Meet)
      'data-tooltip',         // tooltip de hover
      'aria-label',           // rótulo de acessibilidade
      'title'                 // título HTML
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
   * @param {Map<string, object>} resultMap - Mapa acumulador de participantes.
   * @param {{ key: string, name: string, email: string|null }} item
   *   Participante a inserir ou atualizar.
   * @param {string} source - Identificador da fonte de coleta ('tiles' |
   *   'panel' | 'fallback').
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
   * @returns {{ key: string, name: string, email: string|null }|null}
   *   Objeto participante ou `null` se descartado.
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
   * @param {Map<string, object>} resultMap - Mapa acumulador de resultados.
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
   * @param {Map<string, object>} resultMap - Mapa acumulador de resultados.
   * @returns {number} Quantidade de novos participantes inseridos nesta chamada.
   */
  function collectFromPanel(doc, resultMap) {
    let count = 0;
    const panels = findPanelContainers(doc);

    for (const panel of panels) {
      // Dentro de cada contêiner de painel, busca APENAS itens de lista e tiles.
      // Nota: [jsname] foi removido daqui — ele está em praticamente todos os
      // elementos do Meet (botões, ícones, textos), não só em nomes de participantes,
      // e era a principal causa de capturar "Adic. pessoas", "mic_off", etc.
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
   * @param {Map<string, object>} resultMap - Mapa acumulador de resultados.
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
   * @returns {{
   *   participants: Array<{ key: string, name: string, email: string|null }>,
   *   sources: { panel: number, tiles: number }
   * }} Lista de participantes únicos e contagem por fonte.
   */
  function collectParticipants(doc) {
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
   * @returns {HTMLButtonElement|null} Botão encontrado, ou `null` se o Meet
   *   não tiver o botão visível no momento.
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
    /** Coleta todos os participantes visíveis. */
    collectParticipants,
    /** Localiza o botão do painel de pessoas. */
    findPeoplePanelButton,
    /** Verifica se o painel de pessoas está aberto e com dados. */
    isParticipantsPanelVisible,
    /** Verifica se a URL é uma página de reunião do Meet. */
    isMeetingPage,
    /** Limpa um nome bruto (remove roles, self-markers). */
    cleanName,
    /** Classifica uma string como ruído de UI. */
    isLikelyNoiseName
  };

  // Exposição global (uso em content scripts da extensão)
  global.MP_Selectors = exportsObject;

  // Exposição CommonJS (uso em testes Node.js)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObject;
  }
})(typeof window !== 'undefined' ? window : globalThis);
