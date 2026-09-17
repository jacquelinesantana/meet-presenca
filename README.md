# Meet Presença

## O que é
**Meet Presença** é uma extensão MV3 (Chrome/Edge) para acompanhar presença em reuniões do Google Meet durante a live.

Ela registra, por participante:
- Nome exibido no Meet
- E-mail (somente quando aparecer no DOM, em melhor esforço)
- Primeira entrada
- Última visualização/saída
- Tempo total de permanência (acumulado, inclusive em reconexões)
- Número de sessões de presença

Também oferece:
- Selo ao vivo na página da reunião
- Popup com lista atualizada em tempo real
- **Exportação CSV** (Nome;E-mail;Data) — inclui todos os participantes; e-mail em branco para quem não foi vinculado
- Exportação JSON completa (todos os dados)
- Armazenamento de múltiplos arquivos de turma (**Nome;E-mail**) no navegador, com seleção rápida (ex.: Turma 1, Turma 2)
- **Filtro de tempo mínimo de permanência** configurável

## Requisitos
- Google Chrome ou Microsoft Edge em versão atual (base Chromium)
- Instalação manual da extensão em modo desenvolvedor
- Projeto **não publicado** na loja

## Instalação no Google Chrome
1. Abra `chrome://extensions`
2. Ative **Modo do desenvolvedor**
3. Clique em **Carregar sem compactação**
4. Selecione a pasta `meet_presenca`

## Instalação no Microsoft Edge
1. Abra `edge://extensions`
2. Ative **Modo de desenvolvedor**
3. Clique em **Carregar descompactada**
4. Selecione a pasta `meet_presenca`

## Guia passo-a-passo completo

### Passo 1: Preparar o arquivo de turma (Nome;E-mail)

Antes da primeira aula, prepare um arquivo CSV com os dados da sua turma:

1. Crie um arquivo de texto simples (`.csv` ou `.txt`)
2. Use o formato: `Nome;E-mail` (separados por ponto-e-vírgula)
3. Exemplo de conteúdo:

```
Nome;E-mail
João Silva;joao.silva@escola.com
Maria Santos;maria.santos@escola.com
Pedro Oliveira;pedro.oliveira@escola.com
```

**Dicas importantes:**
- A primeira linha pode ser o cabeçalho (`Nome;E-mail`) ou já começar com os dados
- Os nomes devem corresponder ao nome que o aluno usa no Google Meet
- O separador pode ser `;` (ponto-e-vírgula) ou `,` (vírgula) — a extensão detecta automaticamente
- Salve o arquivo com codificação UTF-8

### Passo 2: Salvar o arquivo de turma na extensão

Esta etapa é feita **uma única vez por turma**:

1. Clique no ícone da extensão **Meet Presença** na barra do navegador
2. Na seção **Arquivo de turma salvo**, clique no botão **Subir novo arquivo**
3. Digite um nome para identificar a turma (ex.: `Turma 301 - Manhã`, `Engenharia 2024`)
4. Selecione o arquivo CSV que você preparou
5. Clique em **OK** para confirmar

A extensão salva o arquivo no navegador. Você pode salvar até 30 turmas diferentes.

**Para atualizar uma turma existente:**
- Basta subir novamente com o mesmo nome e confirmar a substituição

### Passo 3: Durante a aula ao vivo

1. Entre na reunião do Google Meet (a URL deve conter um código, ex.: `https://meet.google.com/abc-defg-hij`)
2. A captura de presença **inicia automaticamente**
3. **Recomendado:** clique no botão **Pessoas** do Meet para abrir o painel lateral
   - Isso garante que todos os participantes sejam capturados, mesmo os que não aparecem na grade de vídeo
   - Ou use o botão **Abrir painel de participantes** no popup da extensão
4. Acompanhe o contador no canto da tela: `Meet Presença • N participante(s)`
5. Clique no ícone da extensão para ver a lista atualizada em tempo real

### Passo 4: Aplicar o arquivo de turma (vincular e-mails)

⚠️ **IMPORTANTE:** Execute este passo **DURANTE a aula**, depois que a extensão já tiver capturado os participantes!

Para que o CSV final contenha os e-mails dos alunos:

1. **Aguarde alguns segundos** após entrar na reunião para que a extensão capture os participantes
2. Clique no ícone da extensão **Meet Presença**
3. **Verifique a tabela de participantes** — deve haver nomes listados (ex: 4 participantes)
4. Na seção **Arquivo de turma salvo**, selecione a turma no menu dropdown
5. Clique no botão **Aplicar arquivo selecionado**
6. **Leia o feedback detalhado:**
   - ✅ `"Arquivo aplicado — 4 e-mail(s) preenchido(s). Total: 4/4 com e-mail"` → Sucesso!
   - ⚠️ `"Arquivo aplicado — 0 e-mail(s) preenchido(s)"` → Os nomes não correspondem (veja troubleshooting)
   - ⚠️ `"Nenhum participante capturado ainda"` → Aguarde mais alguns segundos

**O que acontece:**
- A extensão vincula os e-mails do arquivo aos nomes **já capturados** no Meet
- O vínculo funciona por correspondência normalizada (sem diferenciar maiúsculas/minúsculas e sem acentos) e também por nome aproximado quando houver sobrenome extra ou abreviado
- Exemplos:
  - `Vagner hernandes` pode casar com `Vagner Santana Hernandes`
  - `Vagner herna` pode casar com `Vagner Hernandes`
- E-mails que já existiam não são sobrescritos

> 💡 **A partir da versão 1.5.0** o arquivo selecionado no dropdown é aplicado **automaticamente** na tabela e na exportação — mesmo durante a aula ao vivo. Basta ter o arquivo de turma **selecionado** no dropdown antes de exportar. O botão "usar o arquivo selecionado" continua funcionando para gravar os e-mails no registro da reunião, mas não é mais obrigatório para o CSV sair preenchido.

### Passo 5: Configurar tempo mínimo de permanência (opcional)

Se você deseja filtrar participantes que ficaram pouco tempo:

1. No popup da extensão, localize o campo **Tempo mínimo para presença**
2. Digite o tempo em minutos (ex.: `5` para 5 minutos)
3. A tabela e as exportações mostrarão apenas quem ficou pelo menos esse tempo
4. O contador exibe: `(N excluídos)` indicando quantos foram filtrados

**Exemplo:** configurando `5 minutos`, um aluno que entrou e saiu em 2 minutos não aparecerá no CSV.

### Passo 6: Exportar a lista de presença em CSV

Ao final da aula (ou a qualquer momento):

1. Clique no ícone da extensão **Meet Presença**
2. Verifique se a reunião correta está selecionada no dropdown **Reunião**
3. Clique no botão **Exportar CSV**
4. O arquivo será baixado automaticamente com o nome: `presenca_abc-defg-hij_20260915_143022.csv`

**Formato do CSV gerado (v1.6.0):**
```
Nome;E-mail;Data
João Silva;joao.silva@escola.com;15/09/2026
Maria Santos;maria.santos@escola.com;15/09/2026
Pedro Oliveira;;15/09/2026
```

**Deduplicação automática:** se a mesma pessoa aparecer mais de uma vez (ex: reconexão com nome diferente), o CSV mantém apenas a linha com o **maior tempo de permanência**. A extensão informa quantas duplicatas foram removidas.

**Importante:**
- **Todos os participantes** que atendem ao filtro de tempo mínimo são incluídos
- Participantes com e-mail vinculado aparecem primeiro; sem e-mail, depois (coluna vazia)
- A data é sempre a data do dia da exportação (não da reunião)
- O filtro de tempo mínimo é aplicado (se configurado)

### Passo 7: Exportar dados completos em JSON (opcional)

Se você precisa dos dados completos para análise:

1. Clique no botão **Exportar JSON**
2. O arquivo JSON contém: nome, e-mail, horários de entrada/saída e tempo de permanência

**Formato do JSON:**
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

## Recursos adicionais

### Gerenciar arquivos de turma salvos

- **Visualizar turmas salvas:** use o dropdown na seção "Arquivo de turma salvo"
- **Excluir uma turma:** selecione a turma e clique em "Excluir arquivo salvo"
- **Limite:** a extensão armazena até 30 arquivos de turma

## Sobre os e-mails (importante)
O Google Meet normalmente **não expõe e-mails no DOM do navegador** durante a reunião. Por isso:
- A extensão captura e-mails somente em **melhor esforço** quando alguma string de e-mail estiver visível
- A forma prática de completar os dados é importar uma lista **Nome;E-mail** no popup

Exemplo de fonte da lista:
- lista de convidados de evento no Google Agenda (copiar/exportar e converter para CSV)

Alternativas oficiais para e-mails confiáveis:
- Relatório nativo de presença do Google Workspace (planos pagos)
- API oficial do Google Meet

## Privacidade e LGPD
- 100% local/offline: sem chamadas de rede, sem CDN, sem telemetria
- Todos os dados ficam em `chrome.storage.local` no navegador do anfitrião
- Não há envio para servidor externo
- Avise os participantes e obtenha consentimento quando exigido por política interna/legislação
- Use a ferramenta apenas para finalidades legítimas

## Solução de problemas

### CSV exportado vazio ou sem e-mails
**Problema:** O CSV tem apenas o cabeçalho, ou todos os participantes aparecem sem e-mail (coluna vazia).

**Causa mais comum:** O arquivo foi aplicado **ANTES** de capturar os participantes, ou aplicado **fora da reunião**.

**Diagnóstico rápido:**
1. Abra o popup da extensão
2. Olhe a **tabela de participantes** — tem nomes listados?
3. Olhe a **coluna "E-mail"** — está vazia (—) para todos?

**Se a tabela está vazia:**
- Você não está em uma reunião ativa do Meet, ou
- A reunião ainda não foi iniciada, ou
- Aguarde alguns segundos para a captura começar

**Se a tabela tem nomes, mas a coluna E-mail está vazia (—):**
- O arquivo de turma não foi aplicado, OU
- Foi aplicado antes de capturar os participantes

**Solução:**
1. **Entre em uma reunião do Google Meet** (ou use uma reunião salva para testar)
2. **Aguarde 5-10 segundos** — abra o popup e confirme que há participantes na tabela
3. **Selecione o arquivo de turma** no dropdown
4. **Clique em "Aplicar arquivo selecionado"**
5. **Leia o feedback:**
   - ✅ `"4 e-mail(s) preenchido(s). Total: 4/4 com e-mail"` → Sucesso! Agora pode exportar CSV
   - ⚠️ `"0 e-mail(s) preenchido(s)"` → Os nomes não correspondem (veja abaixo)
   - ⚠️ `"Nenhum participante capturado"` → Aguarde mais ou verifique se está em uma reunião

**Se 0 e-mails foram preenchidos (nomes não correspondem):**
- Verifique se os **nomes no CSV correspondem** aos nomes que aparecem na tabela do popup
- Exemplo: arquivo tem "João da Silva" mas o Meet mostra "João Silva" → não faz match
- A extensão normaliza automaticamente: remove acentos, converte para minúsculas, remove nomes duplicados
- Ajuste o arquivo CSV para corresponder aos nomes exatos do Meet

**Dica:** A extensão detecta automaticamente nomes duplicados no CSV (ex: "AMANDA AMANDA" → "Amanda")

### Outros problemas
- **Selo não aparece:** recarregue a página da reunião e confira se a URL contém código de reunião
- **Contagem parece menor que o esperado:** abra o painel **Pessoas** para melhorar a cobertura da captura
- **Google mudou a interface:** ajuste os seletores em `content/selectors.js` (arquivo centralizado e documentado com JSDoc para manutenção rápida)
- **Dados muito antigos:** o índice mantém até 50 reuniões (as mais antigas são descartadas)

## Estrutura do projeto
```text
meet_presenca/
├── manifest.json
├── background.js
├── ARCHITECTURE.md     ← guia completo: arquitetura, storage, mensagens, cenários
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── lib/
│   └── utils.js
├── content/
│   ├── selectors.js
│   ├── tracker.js
│   ├── content.js
│   └── content.css
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── tests/
│   ├── utils.test.js
│   └── tracker.test.js
└── README.md
```

## Testes
Execute na pasta do projeto:

```bash
node --test tests/
```

## Limitações conhecidas
- E-mails: geralmente indisponíveis no DOM do Meet
- Fechamento abrupto da aba pode encerrar a sessão sem novo tick de confirmação
- Sem `data-participant-id`, pessoas com nomes idênticos podem ser mescladas por nome normalizado
