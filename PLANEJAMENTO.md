# Planejamento: Distributed Wagering Processor

Documento de planejamento escrito antes da implementação (as 3 etapas foram implementadas em 2026-11-06; decisões finais e divergências estão em `ARCHITECTURE.md`). Fonte dos requisitos: `docs/ENUNCIADO.md` (enunciado do desafio Jungle Gaming, antes em `README.md`). Citações de código usam o formato `api/src/...:linha`.

Stack obrigatória: Bun 1.x (runtime, gerenciador de pacotes e test runner), TypeScript estrito, NestJS, PostgreSQL, SQS via LocalStack/MiniStack, Docker Compose, migrations reversíveis, MikroORM.

Avaliação (100 pts): correção financeira 20, concorrência 20, idempotência 15, mensageria e falhas 15, modelagem 10, testes 10, observabilidade 5, documentação 5.

Eliminatórias: `number` para dinheiro; saldo negativo por race; débito ou crédito duplicado; idempotência só em memória; correto só com uma instância; publicar antes do commit; ausência de ledger auditável; testes com mocks no lugar de PostgreSQL/SQS.

---

## 1. Avaliação do estado atual

### 1.1 Resumo

Existe um núcleo promissor, mas estreito: o tipo `Money` com decimal.js e string, um schema PostgreSQL com invariantes fortes (3 migrations) e um `WageringService` que processa apenas apostas (`BET`). Não há endpoints HTTP reais (só o Hello World), nenhuma mensageria, nenhuma outbox/inbox, nenhum teste que realmente execute e nenhuma documentação. Os pontos fortes estão no banco, que é onde o enunciado quer as invariantes; os pontos fracos estão em tudo o que fica ao redor.

### 1.2 Tabela por área

| Área | Status | Evidência |
|---|---|---|
| Dinheiro (Money) | Parcial | `api/src/domain/money/money.ts` usa decimal.js e string; aceita 0 ou 1 casa decimal na entrada, escala 2 ainda não normalizada. |
| Schema e constraints | Feito (base) | `api/src/infrastructure/database/migrations/`: CHECK balance>=0, UNIQUE (player_id,currency), UNIQUE idempotency_key, UNIQUE (provider_id, external_transaction_id), CHECK aritmético `balance_after = before ± amount`, UNIQUE (wallet_id, transaction_id), trigger que bloqueia UPDATE/DELETE no ledger. |
| Lock de wallet | Feito | `api/src/application/wagering/wagering.service.ts:89-93` (`PESSIMISTIC_WRITE` em :92). |
| Idempotência por hash | Parcial | `wagering.service.ts:74` (SHA-256 com ordem de chaves fixa, não ordenada), conflito em `:119-120`. Checagens ocorrem após o lock e sem tratar unique violation. |
| Tipos de transação | Parcial | Só `BET`. WIN, LOSS, REFUND, ROLLBACK, PENDING_REFERENCE não existem. |
| Domínio | Parcial | `api/src/domain/wallet/wallet.ts` existe mas não é usado pelo service; sem version, playerId, rehydrate. Regras estão duplicadas no service. |
| Replay de REJECTED | Parcial | `wagering.service.ts:154` ("Temporary") devolve saldo atual em vez do observado na rejeição. |
| Erros e validação | Parcial | `throw new Error(...)` genérico (`wagering.service.ts:66,136`; `wallet.ts:19,23,50,54`; `money.ts:20,27,88`) vira HTTP 500; sem DTO nem failureCode. |
| API HTTP | Não iniciado | Só `GET /` (`api/src/app.controller.ts`). |
| Mensageria (SQS, inbox, outbox, DLQ) | Não iniciado | Sem SDK, sem tabelas. |
| Testes | Quebrado | `money.test.ts` e `wallet.test.ts` usam `bun:test`, mas o script `test` roda vitest com include `*.spec.ts`: nunca executam. Nenhum teste de integração. |
| Build | Parcial | `tsconfig.build.json` não exclui `*.test.ts`. |
| Infra local | Parcial | `docker-compose.yml` só com postgres; sem script de migrations; `.env.example` sem `PORT` e sem chaves do Observe. |
| Observabilidade | Não iniciado | `@nestjs/observe` com fallback silencioso `'YOUR_APP_KEY'` (SaaS externo, não pedido). Sem logs estruturados nem métricas. |
| Documentação | Não iniciado | Sem README de setup nem ARCHITECTURE.md. |
| Versionamento | Crítico | Só o enunciado está commitado; `api/`, compose, `.env.example` e `.gitignore` estão não rastreados. |

### 1.3 Problemas encontrados, por prioridade

Prioridade alta (afetam eliminatórias ou invalidam a avaliação):

1. Código não versionado: um acidente apaga todo o trabalho.
2. Race de idempotência: duas requisições com a mesma chave para wallets diferentes não são serializadas pelo lock da wallet; a violação de UNIQUE vira 500 em vez de replay ou conflito (`wagering.service.ts:74-93` e `:119-120`).
3. Testes nunca rodam (vitest x `bun:test`): na prática, zero cobertura, e o enunciado exige Bun como test runner.
4. Ausência de outbox/inbox: sem elas, "publicar antes do commit" ou perder eventos é inevitável quando a mensageria chegar. Precisam ser gravadas atomicamente desde o início.
5. Domínio anêmico: a classe `Wallet` não é usada; regras vivem no service e não são testáveis isoladamente.

Prioridade média:

6. Replay de REJECTED devolve saldo atual (`wagering.service.ts:154`): resposta não é fiel à original.
7. Erros genéricos viram 500; sem taxonomia de `failureCode`; sem validação de entrada.
8. Colunas de referência sem CHECK nem FK; sem proteção de banco contra reversão dupla.
9. `@nestjs/observe` com fallback silencioso e dependência de SaaS não pedido.

Prioridade baixa:

10. `.env.example` incompleto, sem script de migrations, `tsconfig.build.json` incluindo testes, compose sem LocalStack.

### 1.4 Quanto da nota está coberto hoje

Uma pequena parte de correção financeira e de idempotência (Money com decimal e schema com constraints), e quase nada do resto: concorrência só tem o lock, sem prova por teste; mensageria, testes, observabilidade e documentação estão praticamente em zero.

---

## 2. Pré-requisito antes da Etapa 1: versionar o estado atual

Recomendação (não executar sem decisão do autor): criar uma branch (por exemplo `chore/baseline`) e commitar o estado atual de `api/`, `docker-compose.yml`, `.env.example` e `.gitignore`, após conferir que `.env` está no `.gitignore` e não entra no commit. Motivos: o trabalho existente só está no disco; cada tarefa seguinte deve poder ser revertida por commit; o histórico de migrations precisa de base estável para decidir sobre a tarefa 1.4. Commits pequenos por tarefa (1.1, 1.2, ...) facilitam a revisão e mostram evolução ao avaliador.

---

## 3. Visão geral das 3 etapas

| Etapa | Foco | Critérios da avaliação cobertos | Pronto quando |
|---|---|---|---|
| 1 | Fundação e núcleo financeiro à prova de concorrência | Correção financeira (20), concorrência (20), idempotência (15), modelagem (10), parte de testes (10) | Cenário 100/80/80 e 50 requisições iguais em paralelo passam em PostgreSQL real; invariante `balance == soma do ledger` verificada; todas as eliminatórias de dinheiro, concorrência e idempotência eliminadas; `bun test` roda de verdade. |
| 2 | Regras completas de negócio e API HTTP | Correção financeira, modelagem, idempotência (HTTP), testes | Os 5 tipos de transação funcionam; PENDING_REFERENCE persistido; todos os endpoints respondem com códigos mapeados; reconciliação e health disponíveis; testes HTTP com Postgres real passam. |
| 3 | Assíncrono, resiliência, observabilidade e entrega | Mensageria e falhas (15), observabilidade (5), documentação (5), testes de resiliência | Consumo SQS com inbox, outbox publisher com SKIP LOCKED, DLQ, worker de pendentes, logs e métricas, teste com 3+ instâncias, README e ARCHITECTURE.md completos. |

Lógica da ordem: a Etapa 1 elimina primeiro todas as eliminatórias de dinheiro, concorrência e idempotência antes de crescer em largura, porque qualquer funcionalidade nova construída sobre um núcleo incorreto herda o defeito e o custo de corrigir cresce a cada tipo de transação adicionado. A Etapa 2 completa o domínio e a API sobre um núcleo já provado por testes contra PostgreSQL real, de modo que os novos tipos (WIN, LOSS, REFUND, ROLLBACK) reaproveitam o mesmo caso de uso transacional. A Etapa 3 adiciona o assíncrono, que depende de inbox e outbox já gravadas atomicamente na mesma transação desde a Etapa 1: o consumidor SQS e o publisher apenas leem e escrevem tabelas que o núcleo já alimenta, sem exigir refatoração do caminho crítico.

---

## 4. Etapa 1: Fundação e núcleo financeiro à prova de concorrência

### Tarefa 1.1: Ferramental de testes e build

- **O que**: padronizar em `bun test`, remover vitest, criar scripts `test`, `test:unit` e `test:integration`, excluir `*.test.ts` do build.
- **Onde no código**: alterar `api/package.json` (scripts e dependências), `api/tsconfig.build.json` (exclude `**/*.test.ts`, `test/**`), remover config do vitest e `api/src/app.controller.spec.ts` (ou migrá-lo para `.test.ts`). Novos: `api/bunfig.toml` (preload e timeout), `api/test/` para integração.
- **Por quê**: o enunciado exige Bun como test runner; hoje `money.test.ts` e `wallet.test.ts` (`bun:test`) nunca rodam. Critério: testes (10) e base para todas as eliminatórias comprovadas por teste.
- **Por que esta é a melhor alternativa**: é o único caminho que usa exatamente o runner exigido, sem camada de compatibilidade, e os testes já escritos passam a funcionar sem reescrita. `bun test` também é o mais rápido para suítes com banco real, onde o tempo é dominado por I/O.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Manter vitest rodando sob Bun | `bunx vitest` com config atual | Ecossistema conhecido, UI | Perde aderência ao requisito; dois runners; mocks de módulos divergentes | Se o projeto já tivesse centenas de specs em vitest |
| Jest | ts-jest ou swc | Padrão histórico do Nest | Mais lento, config ESM trabalhosa, não é o runner exigido | Projeto Node sem exigência de Bun |

- **Pronto quando**: `bun run test:unit` executa `money.test.ts` e `wallet.test.ts` e reporta a contagem esperada; `bun run build` gera `dist/` sem nenhum `*.test.js`.

### Tarefa 1.2: Infra local e migrations

- **O que**: docker-compose com postgres e LocalStack (SQS); script que cria `wager-transactions.fifo` e `wager-transactions-dlq.fifo` com redrive (maxReceiveCount); scripts `migration:create`, `migration:up`, `migration:down` com o CLI do MikroORM; completar `.env.example` (incluindo `PORT`); tornar a chave do Observe opcional ou remover `@nestjs/observe`.
- **Onde no código**: alterar `docker-compose.yml`, `.env.example`, `api/package.json`, `api/src/infrastructure/database/mikro-orm.config.ts` (lê variáveis, `:21` já falha em variável ausente), `api/src/app.module.ts` (remover Observe). Novos: `scripts/localstack-init.sh` (montado em `/etc/localstack/init/ready.d/`), `api/src/infrastructure/messaging/sqs.config.ts`.
- **Por quê**: o enunciado exige Docker Compose, SQS local e migrations reversíveis. Critérios: mensageria (infra), modelagem, documentação (setup reproduzível). O fallback silencioso `'YOUR_APP_KEY'` esconde configuração errada, e o Observe é SaaS externo não pedido.
- **Por que esta é a melhor alternativa**: LocalStack é a opção citada no enunciado, tem suporte documentado a FIFO, DLQ e redrive, e o script de init torna `docker compose up` suficiente para subir tudo. Criar as filas já agora evita retrabalho na Etapa 3 e permite testar o `/health/ready` cedo.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| MiniStack | Emulador AWS leve | Menor consumo | Menos maduro e documentado | Máquina com pouca RAM |
| ElasticMQ | Servidor só de SQS | Leve, compatível com a API | Não é a opção citada; sem S3/SNS futuros | Se só SQS bastasse e LocalStack fosse pesado |
| Testcontainers por suíte | Sobe containers via código de teste | Isolamento forte | Mais lento; exige Docker no teste | Complemento nos testes de integração, não substituto do compose |

- **Pronto quando**: `docker compose up -d` deixa postgres e LocalStack saudáveis e as duas filas criadas (`aws sqs list-queues` via endpoint local); `bun run migration:up` e `migration:down` rodam em banco vazio sem erro, ida e volta.

### Tarefa 1.3: Modelo de domínio puro

- **O que**: finalizar `Money` (normalizar para escala 2; decidir e documentar se aceita `"10"` ou exige `"10.00"`); `Wallet` como raiz com `open`, `rehydrate`, `debit`, `credit` retornando o `WalletLedgerEntry` gerado e incrementando `version` só quando o saldo muda; `WagerTransaction` com máquina de estados e `InvalidTransactionStateError`; `WalletLedgerEntry` imutável; enum documentado de `failureCode` (INSUFFICIENT_BALANCE, REVERSAL_WOULD_OVERDRAW, REFERENCE_NOT_FOUND, REFERENCE_MISMATCH, REFERENCE_ALREADY_REVERSED, CURRENCY_MISMATCH, WALLET_PLAYER_MISMATCH, INVALID_REFERENCE_KIND, AMOUNT_MISMATCH e outros que surgirem). Separar entidades de domínio das entidades MikroORM com mappers.
- **Onde no código**: alterar `api/src/domain/money/money.ts` (`:20,:27,:88` trocar `Error` por erros de domínio tipados) e `api/src/domain/wallet/wallet.ts` (`:19,:23,:50,:54`). Novos: `api/src/domain/wager-transaction/wager-transaction.ts`, `api/src/domain/wallet/wallet-ledger-entry.ts`, `api/src/domain/errors/` (erros e `failure-code.ts`), `api/src/infrastructure/database/mappers/`.
- **Por quê**: o enunciado exige domínio sem dependência de ORM e regras testáveis. Critérios: correção financeira (20), modelagem (10), testes (10).
- **Por que esta é a melhor alternativa**: domínio puro permite testes de unidade rápidos sem banco e deixa o caso de uso (1.7) apenas orquestrar. A `Wallet` que devolve o ledger gerado garante que saldo e ledger nunca divergem por construção. Mappers custam código, mas isolam o ORM, que é justamente a peça de maior risco de compatibilidade (ver seção 7).

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Entidades MikroORM como modelo de domínio | Regras nas próprias entidades persistentes | Menos código | Acopla domínio ao ORM; o enunciado exige domínio sem ORM | Protótipo descartável |
| Modelo anêmico com regras no service | Estado atual (`wagering.service.ts`) | Rápido de escrever | Regras duplicadas, não testáveis isoladamente, difícil reusar no consumidor | Nunca neste desafio |

- **Pronto quando**: testes de unidade cobrem Money (escala, arredondamento, moeda diferente), Wallet (débito, crédito, saldo insuficiente, version só muda com saldo) e WagerTransaction (transições válidas e inválidas); `bun test src/domain` não importa nada de `@mikro-orm`.

### Tarefa 1.4: Schema completo

- **O que**: nova migration com: snapshot do resultado na transação (`balance_after`/saldo observado e `failure_code`) para replay fiel inclusive de REJECTED; CHECK `kind IN ('REFUND','ROLLBACK')` implica `reference_external_transaction_id NOT NULL`; FK `reference_transaction_id`; índice único parcial `UNIQUE (reference_transaction_id, kind) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')`; tabela `inbox_messages` com PK `(consumer_name, message_id)` e `payload_hash`; tabela `outbox_messages` com `attempts`, `next_attempt_at`, `published_at` e índice parcial em pendentes; coluna ou sequence de ordenação no ledger para paginação.
- **Onde no código**: novo `api/src/infrastructure/database/migrations/Migration<timestamp>.ts` (com `down()` reversível); alterar entidades em `api/src/infrastructure/database/entities/` (`wager-transaction.entity.ts`, `wallet-ledger-entry.entity.ts`); novas `inbox-message.entity.ts` e `outbox-message.entity.ts`.
- **Por quê**: a restrição 9 do README exige invariantes no banco, não só no código. Critérios: modelagem (10), idempotência (15), concorrência (reversão dupla), mensageria (inbox e outbox).
- **Por que esta é a melhor alternativa**: o índice parcial impede reversão duplicada mesmo com bug na aplicação ou duas instâncias concorrentes, sem custo para os demais tipos. Gravar o snapshot na transação torna o replay uma simples leitura, sem recomputar. Inbox e outbox no mesmo schema permitem a atomicidade exigida pelos requisitos 6, 10 e 11. Observação: como nada foi entregue, seria aceitável reescrever as 3 migrations numa única inicial, mas uma migration nova preserva o histórico e a reversibilidade; a escolha é a nova migration.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Garantir só no código | Checagens no service | Simples | Proibido pelo enunciado; frágil sob concorrência | Nunca |
| Reescrever tudo numa migration inicial única | Apaga as 3 migrations atuais | Histórico mais limpo | Reescreve histórico; arrisca divergência com ambientes já migrados | Se o repositório fosse novo e sem ambientes migrados |
| Tabela separada de snapshot de resultado | `transaction_results` 1:1 | Transações magras | Join extra em todo replay | Se o snapshot crescesse muito |

- **Pronto quando**: `migration:up` e `migration:down` completos; testes de integração provam que o banco rejeita (a) REFUND sem referência, (b) segunda reversão do mesmo tipo e (c) inbox duplicada.

### Tarefa 1.5: Estratégia de concorrência

- **O que**: lock pessimista por linha da wallet (`SELECT ... FOR UPDATE` via `LockMode.PESSIMISTIC_WRITE` dentro de `em.transactional()`), escopo = `walletId`, ordem de aquisição fixa (por id) quando houver mais de uma linha, `lock_timeout` configurado e erro de lock tratado como transitório (503).
- **Onde no código**: alterar `api/src/application/wagering/wagering.service.ts:89-93` (hoje já usa `PESSIMISTIC_WRITE`; mover para o caso de uso da 1.7); novos `api/src/infrastructure/database/lock-timeout.ts` (`SET LOCAL lock_timeout`) e `api/src/infrastructure/database/transient-errors.ts` (SQLSTATE 55P03, 40001, 40P01).
- **Por quê**: requisitos de concorrência do README (cenário 100/80/80, N instâncias). Critério: concorrência (20); elimina "saldo negativo por race" e "correto só com uma instância".
- **Por que esta é a melhor alternativa**: serializa apenas operações da mesma wallet, funciona com N instâncias porque o lock vive no PostgreSQL, é simples de provar por teste e mantém a regra de domínio em TypeScript. O CHECK `balance >= 0` é a última barreira caso o lock falhe. A contenção em hot wallets é tratada por `lock_timeout` e métrica, não por retry cego.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Optimistic locking (version + retry limitado) | UPDATE com `WHERE version = x`; retry em conflito | Bom em baixa contenção, sem locks longos | No cenário 100/80/80 e em hot wallets gera muitos conflitos e retries; mais métricas e complexidade | Wallets raramente concorrentes |
| UPDATE atômico condicionado | `UPDATE wallets SET balance = balance - $1, version = version + 1 WHERE id=$2 AND balance >= $1 RETURNING ...` | Máxima vazão | Ledger precisa de `balance_before` (exige RETURNING cuidadoso); regras de domínio migram para SQL | Alto volume de débitos simples sem regras |
| Advisory lock `pg_advisory_xact_lock(hash(walletId))` | Lock lógico por hash | Não exige linha existente | Colisões de hash, menos visível em diagnóstico | Serializar algo sem linha (ex.: criação de wallet por player) |
| Fila particionada por wallet (MessageGroupId) | FIFO serializa por grupo | Ordenação natural | Proibido como única garantia pelo enunciado; não cobre HTTP | Apenas como otimização complementar |

- **Pronto quando**: teste de integração com saldo 100.00 e duas apostas de 80.00 em paralelo (conexões reais distintas) resulta em exatamente uma PROCESSED, uma REJECTED por INSUFFICIENT_BALANCE, saldo final 20.00 e um único débito no ledger; sob timeout de lock simulado o caso de uso lança um erro classificado como transitório (que a tarefa 2.4 mapeia para 503).

### Tarefa 1.6: Idempotência persistente

- **O que**: UNIQUE no banco como fonte da verdade (`idempotency_key` e `(provider_id, external_transaction_id)`); `payloadHash` = SHA-256 de JSON canônico com chaves ordenadas recursivamente e Money serializado como string, só com campos de negócio. Fluxo: dentro da transação, travar a wallet, buscar por chave; se existir, comparar hash (igual = replay com snapshot, diferente = conflito); na inserção, capturar unique violation (SQLSTATE 23505), fazer rollback e reler para devolver replay ou conflito.
- **Onde no código**: alterar `wagering.service.ts:74` (cálculo do hash) e `:119-120` (comparação); novos `api/src/application/idempotency/canonical-json.ts`, `payload-hash.ts` e `api/src/infrastructure/database/unique-violation.ts`.
- **Por quê**: seção de idempotência do README. Critério: idempotência (15); elimina "idempotência só em memória" e débito duplicado. Corrige a race atual: o lock da wallet não protege duas requisições com a mesma chave para wallets diferentes, e hoje a violação vira 500.
- **Por que esta é a melhor alternativa**: o UNIQUE do banco é a única garantia que vale sob N instâncias; o tratamento do 23505 fecha a janela entre o "buscar" e o "inserir". O JSON canônico torna o hash independente da ordem de chaves enviada pelo cliente.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Tabela `idempotency_keys` com reserva prévia (padrão Stripe) | Reserva a chave com estado "em andamento" antes de processar | Bom para HTTP genérico, cobre respostas arbitrárias | Mais uma tabela e um estado intermediário a limpar | API genérica com muitos endpoints idempotentes |
| Advisory lock por idempotency key | `pg_advisory_xact_lock(hash(key))` | Serializa mesma chave | Colisões de hash; o UNIQUE continua necessário | Reduzir erros 23505 em alta duplicidade |
| Redis SETNX | Chave com TTL em Redis | Rápido | Proibido como única garantia (perda de cache, não transacional com o commit) | Apenas como otimização de curto-circuito |

- **Pronto quando**: 50 requisições iguais em paralelo produzem um único débito e 49 replays idênticos; mesma chave com payload diferente retorna conflito; mesma chave em wallets diferentes em paralelo nunca gera 500; teste do hash prova independência da ordem das chaves.

### Tarefa 1.7: Caso de uso transacional único `ProcessWagerTransaction`

- **O que**: caso de uso que substitui `WageringService.processBet`, recebe um comando independente de HTTP e SQS e, em UMA transação, grava transação, ledger, saldo, linha de inbox (quando vem da fila) e linhas de outbox. Inclui `OpenWallet` (OPENING + CREDIT no ledger + outbox).
- **Onde no código**: novos `api/src/application/wagering/process-wager-transaction.usecase.ts`, `api/src/application/wallet/open-wallet.usecase.ts`, `api/src/application/wagering/commands.ts`; remover ou reduzir `api/src/application/wagering/wagering.service.ts`; ajustar `api/src/app.module.ts`.
- **Por quê**: requisitos 6, 10 e 11 do README (atomicidade e reuso pelo consumidor). Critérios: concorrência, mensageria (não publicar antes do commit), modelagem.
- **Por que esta é a melhor alternativa**: um único ponto de verdade para HTTP e SQS elimina divergência de regras entre canais, e gravar outbox/inbox na mesma transação é o que impede "publicar antes do commit" e perda de evento.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Um service por canal (HTTP e SQS) | Dois fluxos paralelos | Independência | Duplicação e risco de divergência de regras | Canais com regras genuinamente distintas |
| Event sourcing puro com saldo projetado | Eventos como fonte, saldo derivado | Auditabilidade máxima | O enunciado pede saldo materializado consistente; complexidade muito maior | Domínio com necessidade forte de reconstrução temporal |

- **Pronto quando**: um teste de integração injeta falha após o ledger e antes do commit e verifica que nada foi gravado (nem outbox); `OpenWallet` cria wallet, ledger OPENING e evento na outbox numa só transação.

### Tarefa 1.8: Testes da Etapa 1 com PostgreSQL real

- **O que**: unidade de Money, Wallet e WagerTransaction; integração de constraints e do trigger de imutabilidade do ledger; cenário 100/80/80 com conexões paralelas reais; mesma aposta 50 vezes em paralelo resulta em um débito; wallets distintas em paralelo; helper de invariante final `balance == soma do ledger` aplicado em todos os testes.
- **Onde no código**: novos `api/test/helpers/db.ts` (aplica migrations e limpa tabelas com `TRUNCATE ... CASCADE`, porque o trigger de imutabilidade bloqueia `DELETE` no ledger; `TRUNCATE` não dispara triggers de linha), `api/test/helpers/invariants.ts`, `api/test/integration/concurrency.test.ts`, `idempotency.test.ts`, `constraints.test.ts`, `ledger-immutability.test.ts`; testes de unidade ao lado do código em `api/src/domain/**`.
- **Por quê**: o enunciado elimina testes com mocks no lugar de PostgreSQL/SQS. Critério: testes (10) e prova das demais eliminatórias.
- **Por que esta é a melhor alternativa**: só um PostgreSQL real exercita lock, CHECK, UNIQUE e trigger; o helper de invariante transforma cada teste em verificação de consistência global.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Mocks do repositório | Repositórios falsos | Rápido | Eliminatório; não prova nada de concorrência | Nunca para o núcleo financeiro |
| SQLite em memória | Banco embutido | Sem Docker | Semântica de lock e constraints diferente; não prova nada | Nunca para este desafio |
| Testcontainers | Postgres efêmero por suíte | Isolamento | Mais lento | Se o compose não estiver disponível no CI |

- **Pronto quando**: `bun run test:integration` passa 10 execuções seguidas sem flakiness; todos os testes terminam chamando o helper de invariante.

---

## 5. Etapa 2: Regras de negócio completas e API HTTP

### Tarefa 2.1: WIN, LOSS, REFUND e ROLLBACK com resolução de referência

- **O que**: implementar os quatro tipos restantes e a resolução de referência por `(providerId, referenceExternalTransactionId)` com validação de provider, player, wallet, moeda e rodada; valor igual ao da referência; REFUND só de BET; ROLLBACK de BET, WIN ou REFUND; uma reversão por tipo por referência (índice parcial da 1.4); reversão que deixaria saldo negativo resulta em REJECTED com `REVERSAL_WOULD_OVERDRAW`, auditável. Documentar interpretações (por exemplo, WIN sem BET é aceito? decidir e registrar).
- **Onde no código**: novos `api/src/application/wagering/handlers/{bet,win,loss,refund,rollback}.handler.ts`, `api/src/application/wagering/reference-resolver.ts`; ajustes em `process-wager-transaction.usecase.ts` e no domínio (`wager-transaction.ts`).
- **Por quê**: seção de regras de negócio do README. Critérios: correção financeira (20), modelagem (10).
- **Por que esta é a melhor alternativa**: um handler por `kind` dentro do mesmo caso de uso mantém regras isoladas e testáveis sem duplicar a infraestrutura transacional; o índice parcial garante a regra "uma vez por tipo" mesmo sob concorrência.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Strategy/handler por kind (escolhida) | Um handler por tipo, selecionado pelo caso de uso | Regras isoladas, fácil de testar | Mais arquivos | Padrão para este desafio |
| Switch único no caso de uso | Um `switch(kind)` grande | Simples no início | Cresce e mistura regras | Se houvesse só 2 tipos |
| Regras em triggers do banco | Lógica em PL/pgSQL | Garantia máxima | Difícil de testar e versionar; regras de negócio fora do TypeScript | Apenas para invariantes simples (já cobertas por CHECK) |

- **Pronto quando**: testes de unidade por regra e por kind; teste de integração prova que duas reversões simultâneas do mesmo tipo geram uma PROCESSED e uma REJECTED; decisões de interpretação listadas em ARCHITECTURE.md (rascunho).

### Tarefa 2.2: Referência ausente vira PENDING_REFERENCE

- **O que**: quando a referência de REFUND ou ROLLBACK ainda não existe, persistir a transação como `PENDING_REFERENCE` com `next_attempt_at` e `attempts` (o worker que reprocessa fica na Etapa 3).
- **Onde no código**: `reference-resolver.ts` e `process-wager-transaction.usecase.ts`; colunas na entidade `wager-transaction.entity.ts` (migration da 1.4 ou complementar).
- **Por quê**: o requisito 7.8 do README exige tolerar ordem de chegada trocada. Critérios: mensageria e falhas (15), correção.
- **Por que esta é a melhor alternativa**: persistir o pedido mantém auditoria e idempotência (a chave já está reservada) e não depende de comportamento do broker.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Rejeitar imediatamente | REJECTED com REFERENCE_NOT_FOUND | Simples | Viola o requisito 7.8 | Nunca |
| Devolver a mensagem à fila com delay | Visibility timeout ou delay | Sem estado no banco | Depende do broker; perde auditoria; não cobre HTTP | Complemento para pequenas esperas |

- **Pronto quando**: ROLLBACK antes da BET fica `PENDING_REFERENCE` com `attempts=0`; resposta HTTP 202; nenhum efeito no saldo.

### Tarefa 2.3: Endpoints HTTP

- **O que**: `POST /wallets`, `GET /wallets/:id`, `GET /wallets/:id/ledger` com paginação keyset e cursor opaco (base64url de `(sequence)` ou `(created_at,id)`), `GET /wagering/transactions/:id`, `GET /providers/:p/wagering/transactions/:ext`, `POST /wagering/transactions` com header `Idempotency-Key` obrigatório.
- **Onde no código**: novos `api/src/interfaces/http/{wallets,wagering}/*.controller.ts`, `api/src/interfaces/http/pagination/cursor.ts`; alterar `api/src/app.module.ts`; remover o Hello World (`api/src/app.controller.ts`, `app.service.ts`).
- **Por quê**: seção de API do README. Critérios: modelagem, idempotência (header), testes.
- **Por que esta é a melhor alternativa**: keyset é estável sob inserções concorrentes no ledger e usa índice (custo constante por página); cursor opaco permite mudar a ordenação interna sem quebrar clientes.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Offset/limit | `OFFSET n LIMIT m` | Simples | Instável com inserções, lento em páginas profundas | Tabelas pequenas e estáticas |
| Cursor = id cru | Cliente envia o último id | Simples | Não opaco; acopla o cliente ao formato | Uso estritamente interno |

- **Pronto quando**: contrato dos 6 endpoints coberto por testes HTTP; paginar um ledger com inserções concorrentes não repete nem pula entradas.

### Tarefa 2.4: Validação de entrada e mapeamento de erros

- **O que**: DTOs validados com zod (schemas estritos, strings decimais, sem coerção) num pipe próprio; exception filter global mapeando 400 (payload inválido), 409 (conflito de idempotência ou duplicidade), 422 (rejeição de negócio com `failureCode`), 202 (pendente), 503 (falha transitória: lock timeout, DB ou SQS fora) e 404 (não encontrado).
- **Onde no código**: novos `api/src/interfaces/http/validation/zod.pipe.ts`, `api/src/interfaces/http/dto/*.ts`, `api/src/interfaces/http/filters/domain-exception.filter.ts`; o filtro substitui o 500 genérico dos `throw new Error(...)` atuais.
- **Por quê**: o enunciado exige respostas distinguíveis para erro de cliente, rejeição de negócio e falha transitória. Critérios: correção, mensageria (classificação de erro reaproveitada pelo consumidor), testes.
- **Por que esta é a melhor alternativa**: zod não faz coerção implícita (importante para dinheiro em string), gera tipos TypeScript a partir do schema e é independente de decorators, o que reduz risco com Bun. 422 para rejeição de negócio distingue de forma consistente "pedido inválido" de "negócio recusou"; é uma escolha defensável, e deve ser documentada porque 200 com status REJECTED no corpo também é razoável.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| class-validator + class-transformer | Decorators em DTOs | Padrão do Nest | Coerções implícitas, verbosidade, dependência de decorators/reflect-metadata | Projeto Nest tradicional sem dinheiro em string |
| TypeBox/ajv | JSON Schema | Muito rápido | Menos idiomático no Nest; mensagens menos amigáveis | API com contratos JSON Schema/OpenAPI-first |
| 200 com `status: REJECTED` no corpo (para rejeição) | Sempre 200 para negócio | Cliente trata um só caminho | Mistura sucesso técnico com recusa de negócio | Clientes legados que não tratam 4xx |

- **Pronto quando**: tabela de mapeamento coberta por testes (um caso por código); nenhum `Error` genérico chega ao cliente como 500.

### Tarefa 2.5: Reconciliação

- **O que**: `POST /wallets/:id/reconciliation` soma o ledger em SQL, compara com o saldo, nunca corrige, loga a divergência e incrementa métrica.
- **Onde no código**: novos `api/src/application/wallet/reconcile-wallet.usecase.ts` e rota em `api/src/interfaces/http/wallets/`.
- **Por quê**: requisito de auditoria do README. Critérios: correção financeira, observabilidade.
- **Por que esta é a melhor alternativa**: somar no banco evita carregar o ledger inteiro, e não corrigir automaticamente preserva a trilha de auditoria (corrigir sem investigar esconderia o bug).

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Job periódico | Reconciliação agendada | Detecção proativa | Não substitui a rota sob demanda | Complemento em produção |
| Checksum encadeado (hash chain) no ledger | Cada entrada inclui hash da anterior | Auditabilidade forte, detecta adulteração | Custo por escrita e complexidade | Requisito regulatório de não repúdio |

- **Pronto quando**: teste cria divergência artificial com um `UPDATE wallets SET balance = ...` direto (o ledger fica intacto, então não há trigger a contornar) e a rota reporta `consistent: false` e a `difference` correta, sem alterar dados.

### Tarefa 2.6: Health checks

- **O que**: `/health/live` sem dependências; `/health/ready` testando `SELECT 1` e `GetQueueAttributes` no SQS.
- **Onde no código**: novo `api/src/interfaces/http/health/health.controller.ts` e indicadores em `api/src/infrastructure/health/`.
- **Por quê**: requisito operacional do README. Critério: observabilidade (5).
- **Por que esta é a melhor alternativa**: `@nestjs/terminus` já padroniza o formato e o tratamento de timeout dos indicadores, reduz código próprio e é conhecido por quem avalia projetos Nest.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Controller próprio | Duas rotas com consultas diretas | Sem dependência extra | Reimplementa timeout e formato | Se terminus conflitasse com Bun |
| Terminus (escolhida) | Indicadores prontos | Padrão e testado | Uma dependência a mais | Padrão |

- **Pronto quando**: com o postgres parado, `/health/ready` responde 503 e `/health/live` continua 200.

### Tarefa 2.7: Autenticação (apenas ponto de extensão)

- **O que**: não implementar autenticação; criar `ProviderIdentityPort` e um `AuthGuard` no-op, e documentar no ARCHITECTURE.md (não vale pontos).
- **Onde no código**: novos `api/src/application/ports/provider-identity.port.ts` e `api/src/interfaces/http/auth/auth.guard.ts`.
- **Por quê**: mostra consciência do tema sem gastar tempo fora dos critérios de nota.
- **Por que esta é a melhor alternativa**: o custo é mínimo e a troca futura por uma implementação real não toca o domínio.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Keycloak no compose | IdP completo | Realista | Pesado; fora do escopo e dos critérios | Se autenticação fosse requisito |
| Zitadel | IdP mais leve | Moderno | Ainda infra extra sem pontos | Idem |

- **Pronto quando**: o guard está registrado globalmente e há um teste provando que a porta pode ser substituída.

### Tarefa 2.8: Testes da Etapa 2

- **O que**: unidade por regra e por kind; integração HTTP com supertest e PostgreSQL real; ROLLBACK e REFUND antes da referência; replay idêntico com `idempotentReplay: true`; mesma chave com payload diferente retorna 409.
- **Onde no código**: novos `api/test/e2e/*.test.ts` (usando `bun:test` com supertest) e `api/src/application/wagering/handlers/*.test.ts`.
- **Por quê**: critério de testes (10) e prova de que a API respeita o mapeamento da 2.4.
- **Por que esta é a melhor alternativa**: testar pela camada HTTP com banco real exercita validação, filtro, caso de uso e constraints juntos, o que é o que o avaliador exercitaria.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Só testes de unidade | Mocks | Rápidos | Eliminatório sem integração | Nunca sozinho |
| Testes de contrato com Pact | Contratos de consumidor | Bom entre times | Overhead para um serviço único | Vários consumidores externos |

- **Pronto quando**: cobertura de todos os códigos HTTP da 2.4 e de cada `failureCode` por pelo menos um teste; suíte inteira verde.

---

## 6. Etapa 3: Processamento assíncrono, resiliência, observabilidade e entrega

### Tarefa 3.1: Consumidor SQS

- **O que**: consumidor com `@aws-sdk/client-sqs` e long polling que chama o MESMO caso de uso da 1.7; deduplicação por inbox `(consumer_name, message_id)` na mesma transação; ack (DeleteMessage) só após o commit; classificação de erro: negócio = ack (já persistido como REJECTED), transitório = não ack com `ChangeMessageVisibility` em backoff, permanente ou veneno = deixar o `maxReceiveCount` do redrive mandar para a DLQ; SIGTERM: parar de buscar, terminar o que está em andamento e devolver a visibilidade das não iniciadas.
- **Onde no código**: novos `api/src/infrastructure/messaging/sqs-consumer.ts`, `message-classifier.ts`, `api/src/interfaces/messaging/wager-transaction.consumer.ts`; ajustes em `api/src/main.ts` (shutdown hooks) e `api/src/app.module.ts`.
- **Por quê**: seção de mensageria do README. Critério: mensageria e falhas (15); evita ack antes do commit (que perderia a mensagem se o processo morresse) e débito duplicado por redelivery.
- **Por que esta é a melhor alternativa**: controle explícito de ack, visibilidade e shutdown é o núcleo do critério de mensageria; uma biblioteca esconderia justamente os pontos avaliados. A inbox torna a entrega at-least-once do SQS segura.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| `sqs-consumer` | Biblioteca de polling | Pronta e testada | Menos controle de shutdown e de visibilidade por mensagem | Consumo simples sem classificação fina |
| `@ssut/nestjs-sqs` | Decorators Nest | Integração idiomática | Abstrai demais; dificulta ack condicional | Projeto sem requisitos de falha |
| Transport customizado do NestJS microservices | Strategy própria | Integra com pipes e filtros do Nest | Mais código e curva de aprendizado | Se o time padronizasse tudo em microservices Nest |

- **Pronto quando**: mensagem duplicada não gera efeito duplicado; mensagem inválida chega à DLQ após `maxReceiveCount`; SIGTERM durante processamento não perde nem duplica mensagem.

### Tarefa 3.2: Publisher da outbox

- **O que**: worker em cada instância que faz `SELECT ... FOR UPDATE SKIP LOCKED LIMIT n` em mensagens pendentes com `next_attempt_at <= now()`, publica e marca `published_at`; falha incrementa `attempts` e aplica backoff exponencial com jitter; duplicatas são possíveis (at-least-once) e seguras porque o consumidor deduplica por `eventId`.
- **Onde no código**: novos `api/src/infrastructure/outbox/outbox-publisher.ts`, `outbox.repository.ts`, `api/src/infrastructure/messaging/sqs-publisher.ts`.
- **Por quê**: requisito de publicação confiável do README. Critério: mensageria (15); elimina "publicar antes do commit" e "correto só com uma instância".
- **Por que esta é a melhor alternativa**: `SKIP LOCKED` permite N publishers sem coordenação e sem fila de eventos perdida; a infra é só o PostgreSQL que já existe.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| CDC com Debezium lendo o WAL | Captura de mudanças | Sem polling, latência baixa | Infra pesada (Kafka Connect) | Alto volume e infra madura |
| LISTEN/NOTIFY | Acorda o worker no commit | Latência menor | Não garante entrega; é só complemento | Reduzir latência sobre o polling |
| Lease com `locked_until` | Coluna de arrendamento em vez de lock de linha | Sem transação longa durante a publicação | Mais estado e limpeza de leases vencidos | Publicação lenta ou externa demorada |

- **Pronto quando**: dois publishers sobre a mesma outbox não publicam a mesma linha em paralelo; SQS indisponível acumula pendentes e, ao voltar, publica tudo sem perda.

### Tarefa 3.3: IntegrationEvent e eventos

- **O que**: `IntegrationEvent<T>` abstrato seguindo o envelope do enunciado (`eventId`, `aggregateId`, `correlationId`, `causationId?`, `occurredAt`, `data`, `eventType` e `version` abstratos, `toJSON()`) e os eventos `WagerTransactionProcessed` (inclusive LOSS), `WagerTransactionRejected`, `WalletBalanceChanged` (só quando o saldo muda) e `WagerTransactionPendingReference`, com `data` usando `MoneyProps` em string (nunca `Money`) e `eventId` gerado na gravação da outbox, portanto estável entre republicações.
- **Onde no código**: novos `api/src/domain/events/*.ts` e `api/src/application/events/event-serializer.ts`.
- **Por quê**: seção de eventos do README. Critérios: mensageria, modelagem.
- **Por que esta é a melhor alternativa**: um envelope simples e versionado cobre o requisito sem infraestrutura extra, e o `eventId` estável permite deduplicação do consumidor.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Envelope CloudEvents | Padrão aberto | Interoperável | Um pouco mais verboso | Integração com terceiros |
| Schema registry/Avro | Contratos binários versionados | Evolução controlada | Exagero para o escopo | Muitos consumidores independentes |

- **Pronto quando**: teste de contrato valida que cada evento serializa Money como string e inclui todos os campos do envelope (`eventId`, `eventType`, `version`, `aggregateId`, `correlationId`, `occurredAt`); LOSS gera `WagerTransactionProcessed` e não gera `WalletBalanceChanged`.

### Tarefa 3.4: Worker de referências pendentes

- **O que**: worker com `SKIP LOCKED` sobre `PENDING_REFERENCE` vencidas, backoff exponencial, limite de tentativas E TTL (recomendado: os dois, porque tentativas protegem contra loops rápidos e o TTL garante prazo absoluto de resolução); esgotado resulta em REJECTED `REFERENCE_NOT_FOUND` e evento.
- **Onde no código**: novos `api/src/infrastructure/workers/pending-reference.worker.ts` e `api/src/application/wagering/reprocess-pending.usecase.ts` (reutiliza o caso de uso da 1.7).
- **Por quê**: requisito 7.8 do README. Critérios: mensageria e falhas (15), correção.
- **Por que esta é a melhor alternativa**: reprocessar dentro do mesmo caso de uso mantém as regras em um só lugar e o `SKIP LOCKED` permite várias instâncias.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Gatilho reativo | Ao processar a BET, procurar pendentes que a referenciam | Reduz latência | Não cobre referência que nunca chega; só complemento | Complemento do worker |
| Agendador externo (cron/EventBridge) | Dispara o reprocessamento | Sem worker no processo | Infra extra e menos controle fino | Ambiente já baseado em agendadores |

- **Pronto quando**: ROLLBACK pendente é resolvido após a chegada da BET; sem a BET, vira REJECTED depois do TTL, com evento na outbox.

### Tarefa 3.5: Observabilidade

- **O que**: logs JSON com `nestjs-pino`, `AsyncLocalStorage` propagando `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, redaction de payload financeiro sensível; métricas `prom-client` em `/metrics` (transações por status, duplicatas, retries, DLQ, conflitos e timeouts de lock, lag da outbox, histograma de latência); remover `@nestjs/observe`.
- **Onde no código**: novos `api/src/infrastructure/observability/{logger,context,metrics}.ts`, `metrics.controller.ts`; alterar `api/src/main.ts` e `api/src/app.module.ts`; remover a dependência e o fallback `'YOUR_APP_KEY'`.
- **Por quê**: seção de observabilidade do README. Critério: observabilidade (5).
- **Por que esta é a melhor alternativa**: pino é o logger mais rápido do ecossistema com saída JSON padronizada; prom-client é o padrão de métricas e dispensa SaaS externo.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| OpenTelemetry SDK completo | Traces e métricas | Padrão aberto, correlação entre serviços | Mais setup; opcional no enunciado | Ambiente com coletor OTel |
| winston | Logger tradicional | Flexível | Mais lento, JSON menos padronizado | Projeto legado |

- **Pronto quando**: cada requisição e cada mensagem geram log JSON com `correlationId`; `/metrics` expõe as métricas listadas e elas mudam durante os testes de resiliência.

### Tarefa 3.6: Testes de resiliência e multi-instância

- **O que**: 3 ou mais processos reais (`Bun.spawn` ou compose com réplicas) consumindo a mesma fila; worker morto após o commit e antes do ack (kill no meio, verificar redelivery sem efeito duplicado); dois publishers na mesma outbox; retry e DLQ no LocalStack; reinício com consistência final; invariante `balance == ledger` ao final de todos.
- **Onde no código**: novos `api/test/resilience/*.test.ts`, `api/test/helpers/spawn-instance.ts`, `api/test/helpers/sqs.ts`.
- **Por quê**: elimina "correto só com uma instância" e comprova mensageria e falhas. Critérios: testes (10), mensageria (15), concorrência (20).
- **Por que esta é a melhor alternativa**: processos reais com um banco e um broker reais são o único meio de provar o comportamento distribuído; matar o processo no ponto exato (entre commit e ack) valida a inbox na prática.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| Várias "instâncias" na mesma thread | Vários consumidores em um processo | Simples | Não prova isolamento de processo nem kill real | Smoke test rápido |
| Chaos tooling (toxiproxy, pumba) | Injeta falhas de rede | Realista | Infra extra | Pipeline de CI dedicado a caos |

- **Pronto quando**: a suíte de resiliência passa repetidamente; ao final, para cada wallet tocada, saldo igual à soma do ledger e nenhum débito duplicado.

### Tarefa 3.7: Documentação

- **O que**: `README.md` de setup (comandos bun, compose, migrations, testes) e `ARCHITECTURE.md` com escolha do ORM, mapeamento de Money (`numeric(20,2)` para string), estratégia transacional e de lock, algoritmo do `payloadHash`, taxonomia de `failureCode`, mapeamento HTTP, interpretações de regras, limitações e trade-offs.
- **Onde no código**: mover o enunciado atual para `docs/ENUNCIADO.md` e reescrever `README.md` com setup e comandos (o critério de avaliação cita explicitamente o `README.md`, então um `SETUP.md` separado não atende); novo `ARCHITECTURE.md` na raiz.
- **Por quê**: critério de documentação (5) e transparência sobre decisões.
- **Por que esta é a melhor alternativa**: documentar as decisões que o avaliador procura (lock, idempotência, outbox) numa só página reduz o risco de perder pontos por decisões corretas mas invisíveis.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| ADRs separados por decisão | Um arquivo por decisão | Histórico claro | Disperso para um desafio curto | Projeto de longa duração |
| Apenas comentários no código | Sem docs externas | Perto do código | Não atende o critério de documentação | Nunca sozinho |

- **Pronto quando**: alguém sem contexto sobe o projeto e roda todas as suítes seguindo apenas o README; ARCHITECTURE.md responde às perguntas da seção 7 deste documento.

### Tarefa 3.8 (opcional, diferencial): Teste de carga

- **O que**: `bun run test:load` com k6: cenários, thresholds e percentis p50/p95/p99; medir vazão, latência, erros, conflitos de lock e lag da outbox.
- **Onde no código**: novos `load/k6/wagering.js` e script em `api/package.json`.
- **Por quê**: diferencial sugerido pelo enunciado; evidência de desempenho sob concorrência.
- **Por que esta é a melhor alternativa**: k6 entrega cenários, thresholds e percentis prontos, o que economiza tempo frente a um script próprio.

| Alternativa | Como funciona | Prós | Contras | Quando escolheria |
|---|---|---|---|---|
| autocannon | Benchmark HTTP em Node | Simples | Só HTTP; sem cenários ricos | Medição rápida de uma rota |
| Script próprio em Bun | Loop com `fetch` | Controle total | Mais trabalho para percentis e relatórios | Cenário muito específico |

- **Pronto quando**: relatório com p50/p95/p99 e taxa de erro, e a invariante de saldo continua válida depois da carga.

---

## 7. Riscos e pontos em aberto

- Interpretações de regra a decidir e registrar: WIN sem BET (aceitar ou rejeitar), LOSS referenciando BET (obrigatório ou opcional, e efeito no saldo), ROLLBACK de ROLLBACK (proibido por padrão), REFUND depois de WIN da mesma rodada.
- Tamanho de lote da outbox (começar com algo como 50 a 100 e medir) e intervalo de polling.
- TTL do `PENDING_REFERENCE` e número máximo de tentativas (definir valores iniciais e torná-los configuráveis por ambiente).
- Compatibilidade de versões: Bun x NestJS 12 x MikroORM 7; validar logo na tarefa 1.1 e 1.2 com um teste de fumaça de bootstrap.
- Decorators com Bun: confirmar `experimentalDecorators` e `emitDecoratorMetadata` com o transpilador do Bun (a injeção de dependência do Nest depende de metadados); alternativa de contingência é injetar por token explícito.
- Escolha do status HTTP para rejeição de negócio (422) precisa ser comunicada claramente na documentação.
- Contenção em hot wallets: lock pessimista serializa; medir na 3.8 e avaliar o UPDATE atômico condicionado apenas se a medição exigir.
- LocalStack: comportamento de FIFO e redrive pode diferir da AWS; registrar limitações no ARCHITECTURE.md.
- Segredos: nunca commitar `.env`; manter apenas `.env.example` com valores fictícios.

---

## 8. Resumo das decisões

| Tema | Escolha | Principal alternativa |
|---|---|---|
| Test runner | `bun test`, vitest removido | vitest sob Bun |
| Infra local | Compose com postgres e LocalStack | MiniStack ou ElasticMQ |
| Domínio | Puro, separado do ORM, com mappers | Entidades MikroORM como domínio |
| Schema | Nova migration com índices parciais, inbox e outbox | Migration inicial única reescrita |
| Concorrência | `SELECT FOR UPDATE` por wallet | Optimistic locking com retry |
| Idempotência | UNIQUE no banco, hash canônico, tratamento de 23505 | Tabela `idempotency_keys` com reserva |
| Caso de uso | Único, transacional, com outbox e inbox | Um service por canal |
| Referência ausente | `PENDING_REFERENCE` persistido | Rejeitar imediatamente |
| Paginação | Keyset com cursor opaco | Offset/limit |
| Validação | zod com pipe próprio | class-validator |
| Rejeição de negócio | HTTP 422 com `failureCode` | HTTP 200 com status REJECTED |
| Health | `@nestjs/terminus` | Controller próprio |
| Consumo SQS | `@aws-sdk/client-sqs` com controle manual | `sqs-consumer` |
| Publicação | Outbox com `SKIP LOCKED` | CDC com Debezium |
| Eventos | `IntegrationEvent` versionado | CloudEvents |
| Observabilidade | pino e prom-client | OpenTelemetry completo |
| Carga | k6 | autocannon |
