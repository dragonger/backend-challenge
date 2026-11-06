# ARCHITECTURE

Decisões, trade-offs e limitações da API de wagering. Setup e comandos estão no [README.md](README.md); o enunciado original está em [docs/ENUNCIADO.md](docs/ENUNCIADO.md) (as seções citadas abaixo, como "seção 8", referem-se a ele).

## 1. Visão geral

Uma wallet por jogador e moeda. Provedores de jogos enviam operações (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) por HTTP ou por uma fila SQS. As duas entradas chamam **o mesmo caso de uso**, que muda o saldo e grava um ledger imutável, tudo numa transação SQL. Eventos de integração saem por uma outbox transacional.

```
 HTTP  POST /wagering/transactions ─┐
                                    ├─> ProcessWagerTransaction ──> PostgreSQL (uma transação)
 SQS   wager-transactions.fifo ─────┘     (inbox, transação, ledger, saldo, outbox)
                                                         │
 PendingReferenceWorker ──> ResolvePendingTransaction ───┤
                                                         ▼
                                  OutboxPublisher ──> wagering-events.fifo
```

Cada instância da aplicação roda tudo: API HTTP, consumidor SQS, publisher da outbox e worker de pendentes. Cada peça liga e desliga por variável de ambiente, e todas são seguras com N instâncias concorrentes (a coordenação é do PostgreSQL).

## 2. Arquitetura em camadas

| Camada | Pasta | Conteúdo | Pode depender de |
|---|---|---|---|
| Domínio | `src/domain` | `Money`, `Wallet`, `WagerTransaction`, regras de referência, `FailureCode`. Sem Nest, sem ORM | nada |
| Aplicação | `src/application` | Casos de uso (`ProcessWagerTransaction`, `ResolvePendingTransaction`, `OpenWallet`, `ReconcileWallet`, consultas), eventos de integração, hash de idempotência, porta de identidade | domínio |
| Infraestrutura | `src/infrastructure` | Entidades e mappers MikroORM, `TransactionRunner`, repositório de pendentes, SQS, outbox, workers, métricas, logs | domínio, aplicação |
| Interfaces | `src/interfaces` | Controllers HTTP, DTOs zod, filtro de erros, guard de autenticação, consumidor SQS | todas as anteriores |

O domínio é puro e testável sem banco. As entidades do ORM são **separadas** das classes de domínio e convertidas por mappers (`infrastructure/database/mappers`): o schema não vaza para as regras e o domínio não depende de decorators. As invariantes vivem nas classes (`Wallet` recusa saldo negativo, `WagerTransaction` controla suas transições, `Money` normaliza escala), e o banco repete as mais importantes como segunda barreira (CHECK, UNIQUE, FK, trigger).

## 3. MikroORM

Escolhido por ter `FOR UPDATE` e transações explícitas por `EntityManager` fork, migrations com SQL escrito à mão (necessário para CHECK, índices parciais e trigger) e suporte a `execute` com SQL cru onde o ORM atrapalharia (inbox, `SKIP LOCKED`, agregados de reconciliação). Alternativas consideradas:

| Alternativa | Por que não |
|---|---|
| Prisma | Sem `SELECT ... FOR UPDATE` nativo e sem controle fino de índices parciais e triggers |
| TypeORM | Decorators e transações funcionam, mas o suporte a Bun e a versões novas do Nest é menos previsível |
| Kysely/knex puro | Mais controle, porém mais código de mapeamento e sem unit of work |

Cada operação usa um `EntityManager` **fork** com sua própria transação e uma conexão do pool (`TransactionRunner`), então operações paralelas rodam em conexões diferentes.

## 4. Money

- Domínio: `Money` imutável sobre `decimal.js`, escala fixa 2, moeda ISO de 3 letras. Nunca `number`.
- Entrada: string decimal simples (`"10"`, `"10.5"`, `"10.50"` viram `10.50`). Rejeita notação científica, sinal, vírgula, mais de 2 casas decimais e **mais de 18 dígitos inteiros**.
- Banco: `numeric(20,2)` (18 inteiros + 2 decimais). O limite de 18 dígitos no `Money` garante que um valor grande demais vire **400 `INVALID_MONEY`** (ou `INVALID_COMMAND` na fila) em vez de um 500 de overflow do PostgreSQL. A soma também é verificada: um crédito que estourasse `numeric(20,2)` falha com a mesma regra.
- Mapeamento: o driver devolve `numeric` como string; o mapper converte para `Money` e de volta. Somas e comparações de reconciliação acontecem em `numeric` no PostgreSQL.
- JSON: sempre `{ "amount": "25.00", "currency": "BRL" }` (`MoneyProps`), inclusive nos eventos.

## 5. Estratégia transacional e de concorrência

A unidade de concorrência é a **wallet** (seção 8 do enunciado).

Fluxo de `ProcessWagerTransaction` (uma transação SQL):

1. Validação e cálculo do `payloadHash` (fora da transação).
2. Se veio da fila: `INSERT` na inbox (`ON CONFLICT DO NOTHING`); se já existia, é redelivery: devolve o resultado original sem efeito.
3. Consulta por idempotência (chave e identidade do provedor) sem lock: se já existe, é replay ou conflito.
4. `SELECT ... FOR UPDATE` da wallet (lock pessimista). Reconsulta idempotência (outra transação pode ter commitado enquanto esperávamos).
5. Aplica a regra do `kind` (handlers), grava transação, atualiza saldo e `version`, grava ledger, outbox e marca `processed_at` da inbox.
6. Commit. Só depois disso o consumidor SQS faz o ack.

**Por que lock pessimista por wallet.** Operações sobre a mesma wallet são serializadas pelo PostgreSQL, então não existe lost update nem saldo negativo por race, mesmo com N instâncias, sem loop de retry na aplicação. O custo é a serialização numa wallet quente (ver [docs/LOAD_TEST.md](docs/LOAD_TEST.md)); wallets diferentes não se bloqueiam.

**`lock_timeout`.** Toda transação começa com `set_config('lock_timeout', '<LOCK_TIMEOUT_MS>ms', true)` (default 5 s). Quem espera demais recebe `55P03`, que vira `TransientInfrastructureError` (HTTP 503 com `Retry-After: 1`, ou retry com backoff na fila). Deadlock (`40P01`) e falhas de serialização/conexão seguem o mesmo caminho. Lock timeouts e deadlocks são contados em `lock_conflicts_total`.

**Alternativas consideradas:**

| Alternativa | Prós | Contras | Veredito |
|---|---|---|---|
| Lock otimista (`version` + retry) | Sem espera em wallet fria | Retry limitado sob contenção, risco de starvation, mais código; o `version` continua existindo para auditoria | Descartada para o caminho de escrita |
| `UPDATE ... SET balance = balance - x WHERE balance >= x` | Lock mínimo, bom para hot wallet | As regras de referência, o ledger com `balance_before/after` e o snapshot do resultado precisam do estado lido sob lock; as duas coisas ficariam em dois caminhos | Fica como otimização futura se a medição de carga exigir |
| `SERIALIZABLE` | Garantia declarativa | Abortos frequentes e retry em tudo | Descartada |
| Advisory lock por wallet | Não depende de linha | Perde a garantia de que o lock é o mesmo dado que se altera | Descartada |
| Fila FIFO como garantia | Ordem por wallet | O enunciado pede que o banco seja a garantia final | Só otimização (ver seção 9) |

Rede de segurança no banco: `CHECK (balance >= 0)`, UNIQUE de idempotência, índice único parcial de reversão, trigger que impede UPDATE/DELETE no ledger.

## 6. Idempotência

- **No banco, não na memória.** `wager_transactions` tem `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`. A verificação na aplicação é uma otimização; quem decide a corrida é o UNIQUE. Se duas requisições iguais correm em paralelo, uma recebe `23505`, a transação é desfeita e o caso de uso **roda de novo do zero**, agora enxergando a vencedora (replay ou conflito). São no máximo 3 tentativas.
- **Header obrigatório.** `Idempotency-Key` é a fonte da verdade na API HTTP. Na fila, a chave vem de `data.idempotencyKey`.
- **`payloadHash`** = `hex(SHA-256(JSON canônico))`. O JSON canônico ordena as chaves recursivamente (por unidade de código UTF-16), mantém a ordem de arrays, descarta `undefined` e não emite espaços. Campos incluídos (apenas negócio): `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money {amount (escala 2), currency}` e `referenceExternalTransactionId` (somente quando presente). **Não entram**: a própria chave de idempotência, headers, `X-Correlation-Id`, `messageId`, `occurredAt`. Implementação: `src/application/idempotency`.
- **Resultado do replay.** Mesma chave e mesmo hash: devolve o resultado original (status, `failureCode`, saldo observado na época), com `idempotentReplay: true`. Exceção: `PENDING_REFERENCE` devolve o saldo **atual** da wallet.
- **Conflito.** Mesma chave com payload diferente, ou o mesmo `(providerId, externalTransactionId)` com outra chave, ou chave e identidade apontando para transações diferentes: `IdempotencyConflictError` (HTTP 409, ack na fila). Nunca é tratado como replay.
- **Inbox.** Para a fila, a tabela `inbox_messages (consumer_name, message_id)` deduplica a mensagem física. O `payload_hash` da inbox é o SHA-256 do corpo canônico inteiro: o mesmo `messageId` com corpo diferente é conflito.

## 7. Inbox, outbox e garantias de entrega

**Inbox.** O `INSERT` da inbox acontece **dentro** da transação de negócio. Se a transação falha, a linha da inbox some junto: a mensagem pode ser reprocessada. Se commita, qualquer redelivery encontra a linha e responde sem efeito.

**Outbox.** Os eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`) são linhas em `outbox_messages` gravadas na mesma transação do saldo e do ledger: ou tudo commita, ou nada. Nunca se publica antes do commit. Regras: `WalletBalanceChanged` somente quando o saldo muda (`LOSS` não gera); `aggregateId` é sempre a `walletId`; `data` leva `MoneyProps` em string. O `eventId` é o `id` da linha, portanto estável entre republicações.

**Publisher** (`OutboxPublisher`, um por instância). Cada ciclo é uma transação:

```sql
SELECT ... FROM outbox_messages
 WHERE published_at IS NULL AND next_attempt_at <= now()
 ORDER BY sequence LIMIT n FOR UPDATE SKIP LOCKED
```

Publica em `wagering-events.fifo` (`MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`, corpo = envelope JSON) com `SendMessageBatch` (10 por chamada) e marca `published_at`. Falha de uma linha: `attempts + 1`, `last_error` e `next_attempt_at` com backoff exponencial e jitter (1 s base, teto 60 s, ±20%). Com publishers concorrentes, `SKIP LOCKED` faz cada um pegar linhas distintas, então a mesma linha não é publicada por dois ao mesmo tempo.

**Garantias.**
- **At-least-once.** Se o processo morre depois do commit e antes de publicar, a linha continua pendente e outra instância publica (cenário 1 a 5 da seção 11). Se morre depois do `SendMessage` e antes do commit do `published_at`, o evento é enviado de novo.
- **Duplicatas são aceitáveis e seguras:** a fila FIFO descarta o mesmo `eventId` dentro da janela de 5 minutos, e o consumidor deve deduplicar por `eventId` para o que escapar da janela.
- **Ordem.** Dentro de um lote a ordem é a da `sequence`; a fila FIFO preserva a ordem por wallet na entrega. Entre publishers e em falhas parciais a ordem por wallet é de melhor esforço (uma linha que falhou é reenviada depois das seguintes). Consumidores que precisem de ordem estrita usam `walletVersion` (em `WalletBalanceChanged`) e `occurredAt`.
- **Métricas.** `outbox_published_total`, `outbox_publish_failures_total`, `outbox_pending` e `outbox_lag_seconds` (idade da linha pendente mais antiga, medida no início de cada ciclo).

Alternativas: CDC com Debezium (infra pesada), `LISTEN/NOTIFY` (não garante entrega; serviria só para reduzir latência), lease com `locked_until` (evita transação aberta durante o envio, mais estado para limpar). A transação aberta durante o `SendMessageBatch` é o custo do desenho simples; o timeout curto do cliente SQS limita a janela.

## 8. Consumidor SQS e classificação de erros

Implementação própria sobre `@aws-sdk/client-sqs` (long polling, concorrência configurável, controle explícito de ack, visibilidade e shutdown). Uma biblioteca esconderia justamente esses pontos.

Mensagem (seção 10): `{ messageId, type: "WagerTransactionRequested", occurredAt, data { ... } }`, validada com zod. O `messageId` do corpo é a chave da inbox; `payloadHash` é o SHA-256 do corpo canônico.

| Classe | Exemplos | Ação |
|---|---|---|
| **Negócio** (resultado terminal) | `PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay, `IdempotencyConflictError`, `WalletNotFoundError` | `DeleteMessage` (ack), log e métrica. A rejeição já foi persistida como `REJECTED` |
| **Transitório** | `TransientInfrastructureError` (lock timeout, deadlock, banco fora), erro de rede ou do SQS, **qualquer erro desconhecido** | Não faz ack. `ChangeMessageVisibility` com `base * 2^(ApproximateReceiveCount - 1)` (base 2 s, teto 60 s, ±20% de jitter). Ao esgotar `maxReceiveCount` (5), a **redrive policy** da fila move a mensagem para a DLQ |
| **Permanente** | JSON inválido, tipo desconhecido, schema inválido, comando inválido (ex.: valor acima de 18 dígitos) | Copia para `wager-transactions-dlq.fifo` com os atributos `FailureReason`, `FailureDetail`, `OriginalSqsMessageId` e `ReceiveCount`, e só então apaga da fila principal. `sqs_dlq_total{reason}` |

Decisões:
- Erro desconhecido é tratado como transitório: um bug nunca descarta mensagem; o limite de recebimentos a leva para a DLQ.
- Se a cópia para a DLQ falhar, a mensagem cai no caminho de retry (nunca se perde).
- Falha no `DeleteMessage` após o commit é inofensiva: a redelivery é absorvida pela inbox.
- Mensagens da mesma `MessageGroupId` (a wallet) num mesmo lote são tratadas em ordem; se uma não é concluída, as seguintes do grupo são devolvidas (visibilidade 0) para preservar a ordem.
- **Shutdown.** `enableShutdownHooks` no SIGTERM/SIGINT. No `onModuleDestroy` (antes de fechar ORM e cliente SQS): para de buscar, devolve com visibilidade 0 as mensagens recebidas e ainda não iniciadas, e aguarda as em andamento. A latência máxima é o `SQS_WAIT_TIME_SECONDS` (long poll), pois a requisição de recebimento não é abortada (abortar poderia perder mensagens já entregues pelo servidor).

## 9. PENDING_REFERENCE

`REFUND` e `ROLLBACK` (e `WIN`/`LOSS` que informam referência) podem chegar antes da `BET` (a fila não garante ordem entre wallets nem entre provedores). Quando a referência não existe, a transação é **persistida** como `PENDING_REFERENCE` (HTTP 202), com `attempts = 0`, `next_attempt_at = agora + backoff inicial` e o evento `WagerTransactionPendingReference`.

- **Worker** (`PendingReferenceWorker`): a cada ciclo `findDueIds` (`FOR UPDATE SKIP LOCKED`) pega os vencidos e chama `ResolvePendingTransaction` para cada um. O caso de uso trava a wallet, recarrega a linha e reaplica a regra pelo mesmo caminho do submit. Duas instâncias resolvendo o mesmo id: a perdedora vê `NOT_PENDING`.
- **Backoff:** exponencial, 1 s inicial, teto 60 s, jitter ±20% (`PENDING_REFERENCE_*`).
- **Limite:** desiste quando **qualquer** um for atingido, o que vier primeiro: 10 tentativas **ou** 15 minutos desde `created_at`. Interpretamos o "E" do enunciado como "o que vier primeiro": as tentativas protegem de loops rápidos e o TTL garante prazo absoluto, mantendo o conjunto de pendentes finito mesmo se o worker estiver lento.
- **Esgotado:** `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`.
- Se a referência existe mas ainda está pendente, o dependente também espera (a resolução ocorre em cascata nos ciclos seguintes).

## 10. Taxonomia de `failureCode`

Todo `REJECTED` carrega um código estável. Orientação ao provedor na última coluna.

| Código | Quando | O provedor deve |
|---|---|---|
| `INSUFFICIENT_BALANCE` | `BET` maior que o saldo | Não reenviar igual; pode tentar outro valor com nova chave |
| `REVERSAL_WOULD_OVERDRAW` | `REFUND`/`ROLLBACK` deixaria o saldo negativo (distinto da aposta sem saldo) | Tratar como caso operacional; a rejeição não consome a reversão |
| `REFERENCE_NOT_FOUND` | Referência nunca chegou (limite de tentativas ou TTL) | Conferir se a transação original foi enviada |
| `REFERENCE_MISMATCH` | Referência de outro provider, player, wallet, moeda ou rodada | Corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | Referência existe mas foi rejeitada ou falhou (não mexeu no saldo) | Desistir |
| `REFERENCE_ALREADY_REVERSED` | A referência já foi revertida (uma vez no total) | Desistir |
| `INVALID_REFERENCE_KIND` | Tipo de referência não permitido (ver seção 11) | Corrigir o payload |
| `AMOUNT_MISMATCH` | Valor da reversão diferente do da referência | Corrigir o valor |
| `CURRENCY_MISMATCH` | Moeda diferente da moeda da wallet | Corrigir a moeda |
| `WALLET_PLAYER_MISMATCH` | A wallet não pertence ao `playerId` informado | Corrigir o payload |
| `MISSING_REFERENCE` | `REFUND`/`ROLLBACK` sem `referenceExternalTransactionId` | Corrigir o payload |
| `WALLET_NOT_FOUND` | Reservado; wallet inexistente é HTTP 404 e não é persistida | Corrigir o `walletId` |
| `INTERNAL_ERROR` | Falha técnica permanente (`FAILED`); não gerada hoje | Contatar o suporte |

## 11. Interpretações de regra

Decisões onde o enunciado deixa espaço (sempre aplicadas sob o lock da wallet):

- Referência resolvida por `(providerId, referenceExternalTransactionId)` e deve ter o mesmo provider, player, wallet, moeda e rodada.
- **Ordem das verificações** (respostas definitivas primeiro): consistência da referência (`REFERENCE_MISMATCH`), tipo permitido (`INVALID_REFERENCE_KIND`), referência ainda não resolvida (espera), referência `REJECTED`/`FAILED` (`REFERENCE_NOT_PROCESSED`), valor igual só em `REFUND`/`ROLLBACK` (`AMOUNT_MISMATCH`), já revertida (`REFERENCE_ALREADY_REVERSED`), saldo (`REVERSAL_WOULD_OVERDRAW`).
- `REFUND` referencia somente `BET`. `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`.
- **Uma reversão por referência no total** (`REFUND` ou `ROLLBACK`, não uma de cada). Checada na aplicação sob o lock; o índice único parcial `wager_transactions_one_reversal_per_reference` é a última barreira. A rejeição de uma reversão **não** consome a vez.
- **`ROLLBACK` de `ROLLBACK` é proibido** (`INVALID_REFERENCE_KIND`), assim como referenciar `LOSS` ou `OPENING`.
- **`WIN` e `LOSS` aceitam referência opcional.** Se vier, deve ser uma `BET` da mesma rodada; `WIN` sem `BET` é aceito.
- `WIN` credita. `LOSS` é `PROCESSED` sem tocar no saldo, sem ledger, `version` inalterada; gera `WagerTransactionProcessed` e não `WalletBalanceChanged`.
- `ROLLBACK` de `BET` credita; de `WIN` ou `REFUND` debita.
- Reversão parcial está fora de escopo (valor igual ao da referência).
- **Rejeição de negócio é HTTP 422** com o resultado e o `failureCode` no corpo (não 200): o provedor decide pelo status, sem interpretar mensagem. Replays de rejeição também devolvem 422.
- Operação `OPENING` (saldo inicial) é interna, gera ledger `CREDIT` e não é submetível.

## 12. Mapeamento HTTP

Erros: corpo `{ "error": { "code", "message", "details"? } }`, produzido por um único filtro global.

| Situação | Status |
|---|---|
| Payload, header, query, param ou cursor inválido; JSON malformado; valor monetário inválido (inclusive acima de 18 dígitos); regra de domínio de entrada | 400 |
| Wallet ou transação inexistente | 404 |
| Mesma chave com payload diferente; `(provider, externalId)` com outra chave; wallet duplicada (`playerId` + moeda) | 409 |
| Transação nova `PROCESSED` | 201 |
| Replay idempotente `PROCESSED` | 200 |
| `REJECTED` por regra de negócio (novo ou replay) | 422 |
| `PENDING_REFERENCE` (novo ou replay) | 202 |
| Falha transitória (lock timeout, deadlock, banco fora) | 503 com `Retry-After: 1` |
| `FAILED` e erro inesperado | 500 (mensagem genérica; stack só no log) |
| Sem credencial (quando uma `ProviderIdentityPort` real for instalada) | 401 |

A distinção que o provedor precisa fazer: **4xx não reenviar igual (400, 409, 422)**, **202 aguardar**, **503 reenviar com a mesma chave** (seguro por causa da idempotência).

## 13. Autenticação

Fora do escopo (seção 2 do enunciado), mas com ponto de extensão pronto: um `AuthGuard` global consulta a porta `ProviderIdentityPort`; a implementação padrão (`AnonymousProviderIdentity`) aceita todos. Rotas marcadas com `@Public()` (health, `/metrics`) pulam o guard. Para ativar: implementar a porta (OIDC/JWT com Keycloak ou Zitadel, por exemplo) e trocar o provider `PROVIDER_IDENTITY` em `HttpModule`. Há teste provando que a porta é substituível.

## 14. Observabilidade

- **Logs JSON** com `nestjs-pino`. O contexto (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`) é mantido em `AsyncLocalStorage` e anexado a **toda** linha (requisição e mensagem) por um `mixin` do pino. O `correlationId` é o `X-Correlation-Id` do chamador (se válido), o `messageId` na fila, ou um UUID. Os casos de uso acrescentam `walletId`, `providerId` e `transactionId` assim que os conhecem, e o `correlationId` vai também para os eventos da outbox.
- **Dados sensíveis.** Corpos de requisição nunca são logados; só ids. Redaction de `authorization`, `cookie`, `set-cookie` e de campos `money`/`balance`/`payload` como segunda linha de defesa.
- **Métricas** (`GET /metrics`, público, registry próprio do prom-client): `wager_transactions_total{kind,status,channel}`, `idempotent_replays_total{channel}`, `idempotency_conflicts_total`, `sqs_messages_total{outcome}`, `sqs_retries_total`, `sqs_dlq_total{reason}`, `lock_conflicts_total`, `outbox_published_total`, `outbox_publish_failures_total`, `outbox_lag_seconds`, `outbox_pending`, `wager_processing_duration_seconds{channel}` (histograma), `wallet_reconciliation_mismatches_total`, além das métricas padrão do processo. `channel` é `http`, `sqs` ou `worker`.
- **Health.** `/health/live` (processo vivo, sem dependências) e `/health/ready` (PostgreSQL e SQS alcançáveis, timeout curto, 503 com detalhe por dependência). Sem autenticação.
- **Reconciliação.** `POST /wallets/:id/reconciliation` compara saldo armazenado e ledger num único SELECT; divergência nunca é corrigida em silêncio (log, métrica e sinal na resposta).

## 15. Testes

| Suíte | O que prova | Infra real |
|---|---|---|
| Unidade (`src`) | Money, wallet, regras por kind, política de backoff, hash, DTOs, mapeamento de erros, classificação da fila | nenhuma |
| Integração (`test/integration`) | Migrations e constraints, atomicidade wallet+ledger+inbox+outbox, idempotência, 50 requisições paralelas, disputa de saldo, reversões concorrentes, reconciliação | PostgreSQL |
| E2E HTTP (`test/e2e`) | Todos os códigos HTTP, replay, 409, pendentes, 503 por lock timeout real, `/metrics` | PostgreSQL |
| Resiliência (`test/resilience`) | Redelivery, retry e DLQ, ROLLBACK antes da BET, shutdown, dois publishers, SQS fora do ar, **processo morto entre commit e ack**, **3 processos** com centenas de mensagens e wallet quente, reinício | PostgreSQL, LocalStack, processos `bun src/main.ts` |
| Carga (`bun run test:load`) | Vazão, latência, conflitos de lock, lag da outbox, invariantes após a carga | todos |

Todos terminam verificando `wallet.balance == saldo do ledger` (e encadeamento do ledger). O seam `TEST_CRASH_AFTER_COMMIT=1` só funciona com `NODE_ENV=test`. As filas dos testes de resiliência têm sufixo por execução e são apagadas ao final.

## 16. Limitações conhecidas

- **`WIN` depois de `REFUND` da mesma `BET` não é bloqueado** (nem `REFUND`/`ROLLBACK` de uma `BET` que já teve `WIN`). A regra de negócio entre rodada, aposta e prêmio está fora do escopo; a reversão "uma por referência" vale por referência, não por rodada.
- **LocalStack não é a AWS.** O comportamento FIFO (bloqueio de grupo enquanto há mensagem em voo, janela de deduplicação, redrive por contagem de recebimentos, contadores aproximados de profundidade) pode diferir em detalhes. Os testes usam apenas o que o LocalStack suporta de forma estável, e os contadores de profundidade só são lidos por polling.
- **Ordem dos eventos por wallet é de melhor esforço** entre publishers concorrentes e em falhas parciais (seção 7).
- **Publisher com transação aberta durante o envio.** Simples e correto, mas segura uma conexão pelo tempo do `SendMessageBatch`; uma outbox muito grande com SQS lento exigiria o desenho com lease.
- **Wallet quente serializa.** O throughput de uma única wallet é limitado pelo tempo de uma transação sob o lock; sob contenção alta a latência de cauda cresce e podem ocorrer `503` por `lock_timeout`.
- **Sem autenticação** (ponto de extensão apenas) e sem TLS/rate limit.
- **Reversão parcial, multi-moeda por wallet e estorno de `OPENING`** não são suportados.
- **Graceful shutdown no Windows.** `SIGTERM` não é entregue como sinal; o fluxo de shutdown é exercitado nos testes chamando a mesma sequência (`stop()` do consumidor) e funciona com SIGINT/SIGTERM em Linux e containers.
- Retenção e limpeza de `inbox_messages` e de `outbox_messages` publicadas não estão implementadas (job de purge por idade seria o próximo passo).

## 17. Trade-offs resumidos

| Tema | Escolha | Principal alternativa |
|---|---|---|
| Concorrência | `FOR UPDATE` por wallet | Lock otimista com retry |
| Idempotência | UNIQUE no banco + hash canônico | Tabela de reserva de chaves |
| Entrega | Outbox + `SKIP LOCKED`, at-least-once | CDC (Debezium) |
| Mensageria | SDK direto, ack manual | `sqs-consumer` |
| Erros da fila | Negócio ack, transitório backoff + redrive, permanente DLQ explícita | Tudo pelo redrive |
| Rejeição de negócio | HTTP 422 | HTTP 200 com status no corpo |
| Referência ausente | Persistir como pendente e reprocessar | Rejeitar de imediato |
| Observabilidade | pino + prom-client | OpenTelemetry completo |
| Domínio | Puro, mappers separados | Entidades do ORM como domínio |
