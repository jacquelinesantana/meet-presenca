# Meet Presença — Arquitetura do Projeto

> **Propósito deste documento:** permitir que qualquer sessão futura (humana ou
> agente de IA) entenda o projeto por completo antes de fazer qualquer alteração,
> sem precisar reler todo o código-fonte.
>
> **Última atualização:** v1.6.0

---

## 1. Visão Geral

Meet Presença é uma extensão MV3 para Chrome/Edge que:
1. **Captura** nome, tempo de presença e (quando visível) e-mail de todos os
   participantes de uma reunião do Google Meet.
2. **Vincula** e-mails a participantes usando um arquivo CSV de turma importado
   pelo usuário (fuzzy matching de nomes).
3. **Exporta** a lista em CSV (Nome;E-mail;Data) para uso em sistemas de presença.

Todos os dados ficam em `chrome.storage.local` — sem servidor, sem CDN, sem
telemetria.

---

## 2. Diagrama de Componentes

```
┌─────────────────────────────────────────────────────────────────┐
│  Página do Google Meet (meet.google.com/*)                      │
│                                                                 │
│  ┌───────────┐   ┌────────────┐   ┌─────────────┐              │
│  │  utils.js │◄──│selectors.js│   │  tracker.js │              │
│  │  (lib/)   │   │ (content/) │   │  (content/) │              │
│  └───────────┘   └─────┬──────┘   └──────┬──────┘              │
│        ▲               │                  │                     │
│        └───────────────▼──────────────────▼──────────────────┐  │
│                    content.js (content/)                      │  │
│                    heartbeat 5s → storage + badge             │  │
│                                                               │  │
└───────────────────────────────┬───────────────────────────────┘  │
                                │ chrome.storage.local              │
                    ┌───────────▼──────────┐                        │
                    │    background.js     │ (service worker)       │
                    │  mapeia Meet tabs    │                        │
                    └──────────┬───────────┘                        │
                               │ chrome.runtime / tabs messages     │
                    ┌──────────▼───────────┐                        │
                    │     popup/popup.js   │                        │
                    │  UI + export + maps  │                        │
                    └──────────────────────┘                        │
```

**Fluxo principal de dados:**
```
DOM do Meet → selectors.js → tracker.js → content.js
    → chrome.storage.local (mp_meeting_{code})
    → popup.js → tabela + CSV/JSON
```

---

## 3. Mapa de Arquivos

| Arquivo | Papel | Funções-chave |
|---------|-------|---------------|
| `manifest.json` | Configuração da extensão MV3 | — |
| `lib/utils.js` | Utilitários puros (sem DOM) | `normalizeName`, `extractEmails`, `parseEmailMapCsv`, `buildEmailLookup`, `applyEmailMap`, `findApproximateEmail`, `formatDurationHMS`, `formatDateTimeBR` |
| `content/selectors.js` | Scraping de participantes do DOM do Meet | `collectParticipants`, `isLikelyNoiseName`, `cleanName`, `findPeoplePanelButton` |
| `content/tracker.js` | Lógica de timing e sessões (sem DOM) | `createTracker`, `tracker.tick`, `tracker.getState` |
| `content/content.js` | Script principal injetado na página | heartbeat 5s, badge, `MP_GET_LIVE`, `MP_OPEN_PEOPLE_PANEL` |
| `content/content.css` | Estilos do badge ao vivo | — |
| `background.js` | Service worker da extensão | `meetTabs` Map, `MP_GET_TAB` |
| `popup/popup.js` | Interface do popup | `refresh`, `onExportCsv`, `onExportJson`, `onFileImported`, `applyEmailMapToCurrentMeeting` |
| `popup/popup.html` | HTML do popup | — |
| `popup/popup.css` | Estilos do popup | — |
| `tests/utils.test.js` | Testes de utils.js | — |
| `tests/tracker.test.js` | Testes de tracker.js | — |

---

## 4. Chaves de Storage (`chrome.storage.local`)

| Chave | Tipo | Descrição |
|-------|------|-----------|
| `mp_index` | `object[]` | Índice das últimas 50 reuniões: `{ code, startedAt, participantCount }` |
| `mp_active` | `object` | Reunião em andamento: `{ code, updatedAt }` |
| `mp_meeting_{code}` | `object` | Dados completos de uma reunião (ver esquema abaixo) |
| `mp_email_maps_v2` | `object[]` | Arquivos de turma salvos (ver esquema abaixo) |
| `mp_active_email_map_id` | `string` | ID do arquivo de turma selecionado |
| `mp_min_dwell_minutes` | `number` | Filtro de tempo mínimo em minutos |
| `mp_email_map` | `object[]` | **Legado v1.x** — migrado automaticamente para `mp_email_maps_v2` |

### Esquema de `mp_meeting_{code}`

```json
{
  "code": "abc-defg-hij",
  "startedAt": "2026-09-15T14:05:00.000Z",
  "lastActivityAt": "2026-09-15T15:42:00.000Z",
  "state": {
    "participants": {
      "pid:xyz123": {
        "key": "pid:xyz123",
        "name": "João Silva",
        "email": "joao@escola.com",
        "firstSeenAt": "2026-09-15T14:05:30.000Z",
        "lastSeenAt": "2026-09-15T15:42:18.000Z",
        "accumulatedSec": 5808,
        "sessions": 2,
        "present": false,
        "_lastAccrualMs": 1726407738000
      }
    }
  }
}
```

### Esquema de um item em `mp_email_maps_v2`

```json
{
  "id": "map_1726407738000_abc123",
  "name": "Turma EDN 2026",
  "entries": [
    { "name": "João Silva", "email": "joao@escola.com" },
    { "name": "Maria Santos", "email": "maria@escola.com" }
  ],
  "createdAt": "2026-09-15T14:00:00.000Z",
  "updatedAt": "2026-09-15T14:00:00.000Z",
  "lastUsedAt": "2026-09-15T15:30:00.000Z"
}
```

---

## 5. Protocolo de Mensagens

As mensagens são enviadas via `chrome.runtime.sendMessage` (popup → background)
e `chrome.tabs.sendMessage` (popup → content, identificado pelo tabId).

| Mensagem | Remetente | Destinatário | Payload enviado | Resposta |
|----------|-----------|--------------|-----------------|----------|
| `MP_GET_TAB` | popup.js | background.js | `{ type }` | `{ tabId: number \| null }` |
| `MP_GET_LIVE` | popup.js | content.js | `{ type }` | `{ active, code, participants[] }` |
| `MP_OPEN_PEOPLE_PANEL` | popup.js | content.js | `{ type }` | `{ ok: boolean }` |

**Notas importantes:**
- O service worker (`background.js`) **perde estado ao ser reiniciado**. O mapa
  `meetTabs` (tabId → reunião) é reconstruído via evento `chrome.tabs.onUpdated`
  quando o Meet abre uma aba. Se o background reiniciar entre a aba abrir e o
  popup ser aberto, `MP_GET_TAB` pode retornar `null`.
- `MP_GET_LIVE` retorna `{ active: false }` se o content script não estiver em
  reunião ativa. O popup trata isso voltando para os dados do storage.

---

## 6. Máquina de Estados do Participante

Cada participante no `tracker.js` segue este ciclo:

```
                     tick() vê participante
                            ↓
[Não visto] ──────────────► [Presente]
                               │    ▲
              tick() NÃO vê    │    │ tick() vê de novo
              por N ticks      │    │ (grace period)
                               ▼    │
                          [Grace Period]
                               │
              grace esgotado   │
                               ▼
                           [Ausente]
                               │
              tick() vê        │
              de novo          │
                               ▼
                    [Presente] (nova sessão++)
```

**Parâmetros de timing (content.js):**
- Heartbeat: **5 segundos** (intervalo do setInterval)
- Grace period: **3 ticks** = 15 segundos de ausência antes de marcar como saído
- Cada tick acumula `tickIntervalMs` segundos no participante (anti-supercontagem)

**Anti-supercontagem:** `tracker.js` limita o acúmulo por tick a no máximo
`tickIntervalMs` segundos, mesmo que o participante tenha ficado mais tempo
entre ticks (ex: tab em background, janela minimizada).

---

## 7. Algoritmo de Correspondência de Nomes (name matching)

Implementado em `lib/utils.js`, usado por `applyEmailMap`.

### Passos de normalização
1. Converter para minúsculas
2. Remover acentos (NFD + strip diacritics)
3. Substituir múltiplos espaços por um único
4. Remover palavras duplicadas consecutivas (ex: "amanda amanda" → "amanda")
5. Trim

### Estratégias de correspondência (em ordem de prioridade)

| Prioridade | Estratégia | Exemplo |
|-----------|-----------|---------|
| 1 | Exata (normalizado) | "Ana Lima" ↔ "ANA LIMA" |
| 2 | Substring bidirecional | "Ana Lima Santos" ↔ "Ana Lima" |
| 3 | Score de tokens comuns | "Vagner Hernandes" ↔ "Vagner Santana Hernandes" |
| 4 | Score de similaridade de tokens | "Vagner Herna" ↔ "Vagner Hernandes" |

A função `findApproximateEmail(name, lookup)` percorre essas estratégias e
retorna o e-mail do melhor match encontrado, ou `null` se nenhum superar o
limiar mínimo.

---

## 8. Formatos CSV

### CSV de importação (arquivo de turma)

```
Nome;E-mail
João Silva;joao.silva@escola.com
Maria Santos;maria.santos@escola.com
```

- Separador: `;` ou `,` (detectado automaticamente)
- Codificação: UTF-8 (com ou sem BOM)
- Primeira linha pode ser cabeçalho ou já ser dado
- Cabeçalhos reconhecidos: `nome`, `name`, `email`, `e-mail`, `mail`
- Colunas mínimas: 2 (nome + email)

### CSV de exportação (v1.6.0)

```
Nome;E-mail;Data
João Silva;joao.silva@escola.com;15/09/2026
Maria Santos;maria.santos@escola.com;15/09/2026
Pedro Oliveira;;15/09/2026
```

- Separador: `;`
- Codificação: UTF-8 com BOM (`\uFEFF`) para compatibilidade Excel
- Linha 1: cabeçalho fixo `Nome;E-mail;Data`
- Participantes **com e-mail** aparecem primeiro (ordenados por maior tempo)
- Participantes **sem e-mail** aparecem depois (e-mail = coluna vazia)
- E-mail vazio quando o participante não foi vinculado ao arquivo de turma
- Data = data do dia da exportação (`toLocaleDateString('pt-BR')`)
- Filtro de tempo mínimo aplicado (se configurado)

> **Mudança v1.5.x → v1.6.0:**  
> Versão 1.5.x exportava apenas `E-mail;Data` (2 colunas, somente quem tinha
> e-mail). A v1.6.0 exporta `Nome;E-mail;Data` (3 colunas) incluindo todos os
> participantes, com coluna de e-mail vazia para quem não foi vinculado.

### JSON de exportação

```json
{
  "reuniao": "abc-defg-hij",
  "dataExportacao": "15/09/2026",
  "participantes": [
    {
      "nome": "João Silva",
      "email": "joao.silva@escola.com",
      "primeiraEntrada": "15/09/2026, 14:05:32",
      "ultimaSaida": "15/09/2026, 15:42:18",
      "tempoPermanencia": "1h 36min 46s"
    }
  ]
}
```

---

## 9. Pipeline de Enriquecimento de E-mails

Quando o popup exibe ou exporta participantes, os e-mails são preenchidos em
duas etapas (função `enrichRowsWithEmails` em `popup.js`):

```
Linhas brutas (do storage ou ao vivo)
    ↓
1. E-mails persistidos no mp_meeting_{code}
   (vinculados por chave exata do participante — mais confiável)
    ↓
2. Arquivo de turma selecionado via dropdown
   (fuzzy matching de nome — via buildEmailLookup + applyEmailMap)
    ↓
Linhas enriquecidas → tabela / exportação
```

A etapa 1 usa a chave exata (`data-participant-id` ou `name:{normalizado}`).
A etapa 2 usa o matching de nomes descrito na seção 7.

---

## 10. Cenários Comuns de Modificação

### 10.1 — O Meet mudou a interface e participantes não são capturados

**Arquivo:** `content/selectors.js`

**O que fazer:**
1. Abra o DevTools na página do Meet (`F12`)
2. Inspecione os tiles de vídeo e o painel de pessoas
3. Verifique quais atributos identificam participantes (`data-participant-id`,
   `aria-label`, etc.)
4. Atualize `collectFromTiles` (seletor CSS) ou `collectFromPanel`
   (seletor do contêiner e dos itens)
5. Se novos textos de UI estiverem sendo capturados como nome, adicione-os a
   `NOISE_ONLY_RE` ou `NOISE_FRAGMENT_RE`

### 10.2 — Adicionar uma nova coluna ao CSV exportado

**Arquivo:** `popup/popup.js`

**O que fazer:**
1. Verifique se o dado existe em `buildExportRows()` — o objeto já contém
   `nome`, `email`, `primeiraEntrada`, `ultimaSaida`, `tempoHms`, `tempoSeg`,
   `sessoes`, `presenteAgora`, `reuniao`
2. Se precisar de um campo novo, adicione-o em `buildExportRows()`
3. Em `onExportCsv()`, adicione o campo no array mapeado por coluna e no
   cabeçalho `header`
4. Atualize o README com o novo formato

### 10.3 — Mudar o intervalo do heartbeat

**Arquivo:** `content/content.js`

**O que fazer:**
1. Altere `TICK_INTERVAL_MS` (default: 5000ms)
2. O mesmo valor é passado para `tracker.tick()` — não precisa mudar o tracker
3. Lembre que o grace period é em ticks, não em segundos (ver `tracker.js`
   constante `GRACE_TICKS`)

### 10.4 — Aumentar o limite de reuniões salvas

**Arquivo:** `content/content.js`

**O que fazer:**
1. Altere a constante `MAX_MEETINGS_IN_INDEX` (default: 50)
2. Não há custo de performance — as reuniões antigas são simplesmente
   sobrescritas no índice

### 10.5 — Adicionar novos arquivos de turma ou mudar o limite máximo

**Arquivo:** `popup/popup.js`

**O que fazer:**
1. Altere `MAX_SAVED_EMAIL_MAPS` (default: 30)

### 10.6 — Melhorar a correspondência de nomes (nome matching)

**Arquivo:** `lib/utils.js`

**O que fazer:**
1. Leia as funções `tokenizeNormalizedName`, `tokenSimilarityScore`,
   `countCommonTokenScore`, `findApproximateEmail`
2. Ajuste os limiares de score (variáveis locais dentro de `findApproximateEmail`)
3. Execute os testes após qualquer mudança: `node --test tests/`

### 10.7 — Adicionar suporte a novo separador no CSV de importação

**Arquivo:** `lib/utils.js`, função `parseEmailMapCsv`

**O que fazer:**
1. A função já detecta `;` e `,` automaticamente por heurística de contagem
2. Para adicionar `\t` (tab), inclua na regex de detecção

### 10.8 — Executar os testes

```bash
cd /home/ubuntu/meet_presenca
node --test tests/
```

Os testes cobrem `utils.js` (normalização, matching, CSV parse, e-mail) e
`tracker.js` (acumulação de tempo, grace period, sessões). Rodar após qualquer
alteração nestes dois arquivos.

---

## 11. Dependências e Compatibilidade

| Item | Detalhe |
|------|---------|
| Manifest version | MV3 (obrigatório Chrome 88+, Edge 88+) |
| JavaScript | ES2020 (sem transpilação — extensão MV3 roda no V8 do navegador) |
| CSS | Vanilla, sem preprocessador |
| Storage | `chrome.storage.local` — limite 10MB por extensão |
| Permissions | `storage` + `host_permissions: meet.google.com/*` |
| Publicação | Não publicada na Chrome Web Store — instalação manual |

---

## 12. Glossário

| Termo | Significado |
|-------|-------------|
| **tick** | Execução do heartbeat do `content.js` (a cada 5s) |
| **grace period** | Janela de tolerância (3 ticks = 15s) antes de marcar participante como ausente |
| **key** | Identificador único do participante naquela reunião (prefixo `pid:` ou `name:`) |
| **roster** / arquivo de turma | CSV com pares Nome;E-mail importado pelo usuário |
| **lookup** | Índice construído pelo `buildEmailLookup` para busca rápida de e-mail por nome |
| **enrich** | Processo de completar e-mails ausentes usando o roster ou dados persistidos |
| **stale** | Registro considerado desatualizado (não atualizado nos últimos 15s) |
| **fuzzy matching** | Correspondência aproximada de nomes com tolerância a variações |
