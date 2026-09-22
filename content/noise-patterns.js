/**
 * @file content/noise-patterns.js
 * @description Padrões RegExp para filtragem de ruído de UI do Google Meet.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * COMO MANTER
 * ════════════════════════════════════════════════════════════════════════════
 * Quando um novo texto de UI aparecer como falso-positivo de nome:
 *
 *   • Label de botão/painel EXATO     → adicione em NOISE_ONLY_RE
 *   • Substring de notificação/ação   → adicione em NOISE_FRAGMENT_RE
 *   • Verbo de instrução no início    → adicione em NOISE_VERB_RE
 *
 * Use SEMPRE RegExp literais (/.../flags) — nunca new RegExp(string) —
 * para evitar problemas de escaping e garantir que caracteres especiais
 * (acentos, pontos, parênteses) sejam tratados corretamente.
 *
 * ROLE_SUFFIX_RE e SELF_MARKER_RE NÃO devem ter flag 'g' (global), pois
 * são usados com .replace() em chamadas repetidas e a flag g causaria
 * problemas de lastIndex em uso com .test().
 *
 * ════════════════════════════════════════════════════════════════════════════
 * COMPATIBILIDADE
 * ════════════════════════════════════════════════════════════════════════════
 * Expõe `global.MP_NoisePatterns` para content scripts (window) e
 * `module.exports` para testes Node.js.
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // NOISE_ONLY_RE
  // Corresponde a strings que são EXATAMENTE labels de UI do Google Meet.
  // Âncoras ^ e $ garantem correspondência do string inteiro.
  // Flag /i = case-insensitive.
  //
  // Para adicionar: inclua o texto exato como nova alternativa (termo|novo).
  // ---------------------------------------------------------------------------
  const NOISE_ONLY_RE = /^(você|voce|you|chat|mensagens|messages|atividades|activities|pessoas|people|participantes|participants|convidar|invite|adicionar|add|apresentando|presenting|aguardando|waiting|controles do anfitrião|host controls|configurações|configuracoes|settings|reunião|reuniao|meeting|encerrar|end call|leave call|microfone|microphone|mic|câmera|camera|cam|compartilhar tela|share screen|share|silenciar|mute|unmute|fixar|pin|desafixar|unpin|remover|remove|denunciar|report|bloquear|block|ajuda|help|mais opções|more options|reações|reactions|enquete|poll|quiz|transcrição|transcript|legenda|caption|closed caption|breakout rooms|salas de grupo|sala|room|desligar|turn off|turn on|segurança|security|gravar|record|recording|gravando|levantar a mão|raise hand|baixar a mão|lower hand|emoji|informações|info|ok|yes|no|sim|não|nao|close|cancelar|cancel|confirmar|confirm|salvar|save|editar|edit|copiar|copy|colar|paste|enviar|send|voltar|back|próximo|next|anterior|previous|search|pesquisar pessoas|adic\. pessoas|todos com o som desativado|permitir que os colaboradores ativem o microfone|Carregando itens|Controles de chamada|Copiar link|Mais números de telefone|Reenquadrar|Voltar à tela inicial|Google Meet|A prévia do vídeo está ATIVADA|Mostrar menos opções|Planos de fundo e efeitos|mic_none)$/i;

  // ---------------------------------------------------------------------------
  // NOISE_FRAGMENT_RE
  // Corresponde a strings que CONTÊM uma substring de notificação de status.
  // Sem âncoras — verifica se a substring está presente em qualquer posição.
  //
  // Para adicionar: inclua o fragmento como nova alternativa.
  // ---------------------------------------------------------------------------
  const NOISE_FRAGMENT_RE = /ativou o microfone|desativou o microfone|ativou a câmera|desativou a câmera|está apresentando|apresentando para|entrou na reunião|saiu da reunião|entrou no meeting|saiu do meeting|foi silenciado|foi removido|foi rejeitado|fixado por|apresentando tela|compartilhando tela|está fixado|ativou áudio|desativou áudio|levantou a mão|baixou a mão|todos com o som|colaboradores ativem|ativar o microfone/i;

  // ---------------------------------------------------------------------------
  // NOISE_VERB_RE
  // Corresponde a strings que COMEÇAM com verbo de instrução.
  // \b garante que o verbo termina como palavra completa.
  //
  // Para adicionar: inclua o verbo como nova alternativa no grupo inicial.
  // ---------------------------------------------------------------------------
  const NOISE_VERB_RE = /^(clique|toque|pressione|ativar|desativar|abrir|fechar|entrar|sair|acessar|selecionar|compartilhar|silenciar|remover|denunciar|bloquear|fixar|convidar|pesquisar|permitir|adicionar|adic\.|click|tap|press|open|close|enter|leave|select|share|mute|remove|report|block|pin|invite|search)\b/i;

  // ---------------------------------------------------------------------------
  // ROLE_SUFFIX_RE
  // Remove sufixos de papel entre parênteses do nome exibido pelo Meet.
  // Ex.: "Ana Lima (Anfitriã)" → "Ana Lima"
  // Flag /i sem /g — usado com .replace() em chamadas individuais.
  // ---------------------------------------------------------------------------
  const ROLE_SUFFIX_RE = /\s*\((anfitri[aã]o|host|convidado|guest|apresentador|presenter)\)\s*/i;

  // ---------------------------------------------------------------------------
  // SELF_MARKER_RE
  // Remove marcadores de "você mesmo" adicionados pelo Meet.
  // Ex.: "Carlos (é você)" → "Carlos"
  // Flag /i sem /g — usado com .replace() em chamadas individuais.
  // ---------------------------------------------------------------------------
  const SELF_MARKER_RE = /(é você|e voce|you)\b/i;

  // ─── Exportação ───────────────────────────────────────────────────────────

  const exportsObject = {
    NOISE_ONLY_RE,
    NOISE_FRAGMENT_RE,
    NOISE_VERB_RE,
    ROLE_SUFFIX_RE,
    SELF_MARKER_RE
  };

  global.MP_NoisePatterns = exportsObject;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObject;
  }
}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this));
