---
inclusion: always
---

# Meet Presença — Contexto do Projeto para IA

> Este arquivo é injetado automaticamente em toda sessão de IA para garantir contexto completo sem necessidade de re-explicação.
> Referência completa de arquitetura: #[[file:ARCHITECTURE.md]]

---

## O que é o projeto

Extensão Chrome/Edge (Manifest V3) que captura **nome, tempo de presença e e-mail** dos participantes de reuniões do Google Meet. Todos os dados ficam em `chrome.storage.local` — sem servidor, sem telemetria.

---

## Estrutura de arquivos e responsabilidades

| Arquivo | Responsabilidade | Quando modificar |
|---------|-----------------|------------------|
| `manifest.json` | Configuração MV3, permissões, ordem de injeção dos scripts | Ao adicionar novo script, permissão ou recurso |
| `lib/utils.js` | Utilitários **puros sem DOM**: formatação, parsing CSV, matching nome→e-mail | Ao mudar lógica de matching, formatos de data/tempo, parsing |
| `lib/constants.js` | Constantes compartilhadas entre content e popup (chaves de storage, timeouts) | Ao adicionar nova chave de storage ou constante usada em >1 arquivo |
| `content/noise-patterns.js` | RegExps de filtragem de ruído de UI do Meet | Ao identificar novo falso-positivo de nome na lista de participantes |
| `content/selectors.js` | Scraping de participantes do DOM do Meet | Quando o Meet atualizar sua interface e seletores quebrarem |
| `content/tracker.js` | Máquina de estados de tempo/sessões (sem DOM) | Ao mudar lógica de acumulação, grace period, anti-supercontagem |
| `content/content.js` | Orquestrador: heartbeat, storage, badge, mensagens | Ao mudar ciclo de vida da reunião ou protocolo de mensagens |
| `popup/modules/storage.js` | Wrappers de chrome.storage.local para o popup | Ao adicionar/remover chaves de storage acessadas pelo popup |
| `popup/modules/render.js` | Funções de render da tabela e dropdowns | Ao mudar a exibição da tabela ou dropdowns |
| `popup/modules/export.js` | Exportação CSV e JSON | Ao mudar formato de exportação ou colunas |
| `popup/modules/roster.js` | Gerenciamento de arquivos de turma | Ao mudar a lógica de importação ou seleção de arquivo de turma |
| `popup/modules/live.js` | Dados ao vivo do content script via mensagens | Ao mudar protocolo MP_GET_LIVE ou cálculo de tempo ao vivo |
| `popup/modules/merge.js` | Merge de registros da mesma pessoa, enriquecimento de e-mails | Ao mudar lógica de mesclagem ou pipeline de e-mails |
| `popup/popup.js` | Orquestrador do popup: inicializa módulos, bind de eventos | Ao adicionar novo fluxo de usuário ao popup |
| `background.js` | Service worker: rastreia abas Meet, responde MP_GET_TAB | Ao mudar roteamento de mensagens ou suporte a múltiplas abas |

---

## Regras críticas de manutenção

1. **Nunca lançar exceções para o caller em content scripts** — todos os erros devem ser silenciados (`try/catch`) para não interferir com o Google Meet.
2. **Nunca modificar o DOM fora de `content/` e `popup/`** — `utils.js`, `constants.js`, `tracker.js` e `noise-patterns.js` são módulos puros sem DOM.
3. **Constantes compartilhadas ficam em `lib/constants.js`** — não duplicar `HEARTBEAT_MS`, `ACTIVE_STALE_MS` ou chaves de storage.
4. **Padrões de ruído ficam em `content/noise-patterns.js`** — nunca adicionar RegExps de ruído diretamente em `selectors.js`.
5. **Módulos do popup são IIFEs** — o projeto não usa bundler; cada arquivo expõe seu namespace via `window.MP_*`.
6. **A ordem de carregamento dos scripts importa** — `manifest.json` injeta na ordem: `lib/utils.js` → `lib/constants.js` → `content/noise-patterns.js` → `content/selectors.js` → `content/tracker.js` → `content/content.js`.

---

## Protocolo de mensagens Chrome

| Mensagem | De → Para | Payload | Resposta |
|---|---|---|---|
| `MP_GET_TAB` | popup → background | `{ type }` | `{ tabId: number\|null }` |
| `MP_GET_LIVE` | popup → content | `{ type }` | `{ active, code, participants[] }` |
| `MP_OPEN_PEOPLE_PANEL` | popup → content | `{ type }` | `{ ok: boolean }` |

---

## Chaves de chrome.storage.local

Todas centralizadas em `lib/constants.js` (objeto `STORAGE_KEYS`):

| Chave | Descrição |
|---|---|
| `mp_index` | Índice das últimas 50 reuniões |
| `mp_active` | Reunião em andamento `{ code, updatedAt }` |
| `mp_meeting_{code}` | Dados completos de uma reunião |
| `mp_email_maps_v2` | Array de arquivos de turma salvos |
| `mp_active_email_map_id` | ID do arquivo de turma selecionado |
| `mp_min_dwell_minutes` | Filtro de tempo mínimo (minutos) |
| `mp_settings` | Configurações `{ showBadge: boolean }` |
| `mp_email_map` | **Legado v1.x** — migrado automaticamente |

---

## Como rodar os testes

```powershell
npm test
```

Os testes cobrem `lib/utils.js` e `content/tracker.js` (módulos puros sem DOM).
Para `content/selectors.js` use `npm run test:selectors` (requer jsdom).

---

## Onde adicionar novos RegExps de ruído (falsos positivos de nome)

1. Abra `content/noise-patterns.js`
2. Se for um label de UI exato → adicione em `NOISE_ONLY_RE`
3. Se for uma substring de notificação de ação → adicione em `NOISE_FRAGMENT_RE`
4. Se começar com verbo → adicione em `NOISE_VERB_RE`
5. **Nunca edite `selectors.js` para isso**

---

## Onde mudar seletores CSS quando o Meet atualizar a interface

Arquivo: `content/selectors.js`
Funções: `collectFromTiles`, `collectFromPanel`, `collectFallback`

1. Abra o DevTools no Meet (`F12`)
2. Inspecione tiles de vídeo e o painel de pessoas
3. Verifique `data-participant-id`, `aria-label` e estrutura do painel
4. Atualize os seletores CSS nas funções acima
