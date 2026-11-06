# Wagering API

API de wagering em **NestJS 12 + Bun + MikroORM (PostgreSQL) + SQS**. Processa apostas e movimentações de saldo de provedores de jogos com saldo exato (`numeric(20,2)`), ledger imutável, idempotência persistente, inbox/outbox transacionais e suporte a várias instâncias concorrentes.

- Enunciado original: [docs/ENUNCIADO.md](docs/ENUNCIADO.md)
- Decisões, trade-offs e limitações: [ARCHITECTURE.md](ARCHITECTURE.md)
- Resultados do teste de carga: [docs/LOAD_TEST.md](docs/LOAD_TEST.md)
- Orientações para quem altera o código: [api/AGENTS.md](api/AGENTS.md)

## Visão geral

```
HTTP POST /wagering/transactions ─┐
                                  ├─> ProcessWagerTransaction ─> PostgreSQL (1 transação: inbox, transação, ledger, saldo, outbox)
SQS wager-transactions.fifo ──────┘
PendingReferenceWorker (referências fora de ordem) ─> ResolvePendingTransaction
OutboxPublisher ─> wagering-events.fifo
```

Cada instância executa a API HTTP, o consumidor SQS, o publisher da outbox e o worker de pendentes; cada parte liga/desliga por variável de ambiente.

## Pré-requisitos

- [Bun](https://bun.sh) 1.4 ou superior
- Docker com Compose v2 (PostgreSQL 17 e LocalStack 3.8 rodam em containers; o teste de carga usa a imagem `grafana/k6`)
- Portas livres: `5433` (PostgreSQL), `4566` (LocalStack), `3000` (API)

## Subindo o ambiente

```bash
cp .env.example .env            # ajuste se quiser (valores de exemplo funcionam localmente)
docker compose up -d            # PostgreSQL + LocalStack (cria as filas e o banco de testes)
cd api
bun install
bun run migration:up            # aplica as migrations no banco de desenvolvimento
```

As filas `wager-transactions.fifo` (com redrive para `wager-transactions-dlq.fifo` após 5 recebimentos) e `wagering-events.fifo` são criadas pelo script de inicialização do LocalStack. Se o seu LocalStack já estava de pé antes de existir a fila de eventos, crie-a uma vez:

```bash
docker exec jungle-localstack awslocal sqs create-queue --queue-name wagering-events.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'
```

## Rodando a aplicação e os workers

```bash
cd api
bun run start        # API + consumidor SQS + publisher da outbox + worker de pendentes
bun run start:dev    # idem com --watch
```

Verificações rápidas:

```bash
curl -i localhost:3000/health/ready   # 200 quando PostgreSQL e SQS respondem
curl -s localhost:3000/metrics | head # métricas Prometheus
```

Papéis por instância (todos ligados por padrão fora de `NODE_ENV=test`):

```bash
# Instância só de API HTTP
PORT=3001 SQS_CONSUMER_ENABLED=false OUTBOX_PUBLISHER_ENABLED=false PENDING_WORKER_ENABLED=false bun run start
# Instância só de workers
PORT=3002 bun run start
```

Várias instâncias na mesma máquina: use portas diferentes (`PORT=3001 bun run start`, `PORT=3002 bun run start`, ...). Todas são seguras em paralelo.

Opcional, em containers (migração + 3 réplicas nas portas 3000 a 3002):

```bash
docker compose --profile app up -d --build
```

Enviar uma mensagem de teste à fila (use o `id` e o `playerId` de uma wallet criada via API):

```bash
bun scripts/send-sample-message.ts <walletId> <playerId> 30.00 BET
```

## Testes

Todos os testes de integração usam o banco `jungle_wagering_test` (criado e migrado automaticamente) e filas isoladas; nunca tocam o banco de desenvolvimento. Requerem `docker compose up -d`.

```bash
cd api
bun run typecheck && bun run lint && bun run build
bun run test              # tudo: unidade, integração, e2e HTTP e resiliência
bun run test:unit         # só unidade (sem infra)
bun run test:integration  # PostgreSQL real: constraints, atomicidade, concorrência
bun run test:e2e          # app Nest real via HTTP
bun run test:resilience   # LocalStack + processos reais (kill após commit, 3 instâncias, reinício, DLQ, outbox)
bun run test:load         # teste de carga com k6 em docker (ver docs/LOAD_TEST.md)
```

A suíte de resiliência leva cerca de 1 minuto: cria filas com sufixo por execução, sobe processos `bun src/main.ts` e remove tudo ao final. O teste de carga usa a imagem `grafana/k6` (baixada na primeira execução) e também o banco `*_test`.

## Endpoints

Autenticação não está implementada (ver ARCHITECTURE.md, seção 13). Respostas de erro: `{ "error": { "code", "message", "details"? } }`.

```bash
# Criar wallet (saldo inicial gera lançamento CREDIT no ledger)
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" } }'

# Consultas
curl -s localhost:3000/wallets/<walletId>
curl -s "localhost:3000/wallets/<walletId>/ledger?limit=50"          # cursor opaco em nextCursor
curl -s localhost:3000/wagering/transactions/<transactionId>
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123

# Submeter uma operação (BET, WIN, LOSS, REFUND, ROLLBACK)
curl -i -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -H 'X-Correlation-Id: demo-1' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<walletId>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" } }'
# 201 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}

# Reversão: referencia a transação original pelo id externo
curl -i -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:refund-1' -d '{
    "providerId": "provider-a", "externalTransactionId": "refund-1",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", "walletId": "<walletId>",
    "roundId": "round-987", "gameId": "fortune-chimp", "kind": "REFUND",
    "referenceExternalTransactionId": "transaction-123",
    "money": { "amount": "25.00", "currency": "BRL" } }'

# Reconciliação (saldo armazenado x ledger; nunca corrige em silêncio)
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation

# Saúde e métricas
curl -s localhost:3000/health/live
curl -s localhost:3000/health/ready
curl -s localhost:3000/metrics
```

Status de `POST /wagering/transactions`:

| Status | Significado |
|---|---|
| 201 / 200 | Processada agora / replay idempotente |
| 202 | `PENDING_REFERENCE`: a referência ainda não chegou, será reprocessada |
| 400 | Payload, header ou valor inválido (nunca reenviar igual) |
| 404 | Wallet inexistente |
| 409 | Mesma `Idempotency-Key` com payload diferente |
| 422 | Rejeitada por regra de negócio, com `failureCode` no corpo |
| 503 | Falha transitória (`Retry-After: 1`); reenviar com a mesma chave |

Mensagem SQS (`wager-transactions.fifo`, `MessageGroupId` = `walletId`):

```json
{ "messageId": "msg-123", "type": "WagerTransactionRequested", "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": { "providerId": "provider-a", "externalTransactionId": "transaction-123",
            "idempotencyKey": "provider-a:transaction-123", "playerId": "...", "walletId": "...",
            "roundId": "round-987", "gameId": "fortune-chimp", "kind": "BET",
            "money": { "amount": "25.00", "currency": "BRL" } } }
```

## Variáveis de ambiente

Todas têm default seguro; o modelo completo está em [`.env.example`](.env.example). Nunca commite o `.env`.

| Variável | Default | Descrição |
|---|---|---|
| `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` | ver `.env.example` | Conexão PostgreSQL (o compose lê as mesmas) |
| `DB_NAME_TEST` | `jungle_wagering_test` | Banco usado pelos testes (deve terminar em `_test`) |
| `DB_POOL_MAX` | `20` | Tamanho do pool |
| `LOCK_TIMEOUT_MS` | `5000` | `lock_timeout` de cada transação financeira |
| `PORT` | `3000` | Porta HTTP |
| `LOG_LEVEL` | `info` (`silent` em teste) | Nível do pino |
| `AWS_REGION` `AWS_ENDPOINT_URL` `AWS_ACCESS_KEY_ID` `AWS_SECRET_ACCESS_KEY` | LocalStack, credenciais fictícias | Em `NODE_ENV=production` não há endpoint padrão |
| `SQS_QUEUE_NAME` `SQS_DLQ_NAME` `SQS_EVENTS_QUEUE_NAME` | `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wagering-events.fifo` | Filas |
| `SQS_QUEUE_URL` | vazio | Atalho opcional para pular o `GetQueueUrl` da fila principal |
| `SQS_MAX_RECEIVE_COUNT` | `5` | Recebimentos antes do redrive para a DLQ |
| `SQS_REQUEST_TIMEOUT_MS` / `READINESS_TIMEOUT_MS` | `2000` | Timeouts do cliente SQS e do readiness |
| `SQS_CONSUMER_ENABLED` | `true` (`false` em teste) | Liga o consumidor |
| `SQS_CONSUMER_CONCURRENCY` | `10` | Mensagens simultâneas por instância |
| `SQS_WAIT_TIME_SECONDS` | `5` | Long polling (0 a 20); também a latência máxima de shutdown |
| `SQS_RETRY_BASE_SECONDS` / `SQS_RETRY_MAX_SECONDS` | `2` / `60` | Backoff de erro transitório |
| `OUTBOX_PUBLISHER_ENABLED` | `true` (`false` em teste) | Liga o publisher da outbox |
| `OUTBOX_POLL_INTERVAL_MS` / `OUTBOX_BATCH_SIZE` | `500` / `50` | Intervalo ocioso e linhas por transação |
| `OUTBOX_BACKOFF_BASE_MS` / `OUTBOX_BACKOFF_MAX_MS` | `1000` / `60000` | Backoff de falha de publicação |
| `OUTBOX_GAUGE_INTERVAL_MS` | `2000` | Atualização de `outbox_lag_seconds` e `outbox_pending` |
| `PENDING_WORKER_ENABLED` | `true` (`false` em teste) | Liga o worker de pendentes |
| `PENDING_WORKER_INTERVAL_MS` / `_BATCH_SIZE` / `_CONCURRENCY` | `1000` / `50` / `5` | Cadência do worker |
| `PENDING_REFERENCE_INITIAL_BACKOFF_MS` / `_MAX_BACKOFF_MS` | `1000` / `60000` | Backoff das pendentes |
| `PENDING_REFERENCE_MAX_ATTEMPTS` / `_TTL_MS` | `10` / `900000` | Desiste no que vier primeiro |
| `TEST_CRASH_AFTER_COMMIT` | vazio | **Só testes**: com `NODE_ENV=test` e valor `1`, o processo morre após o commit e antes do ack |

## Estrutura

```
api/src/domain          regras puras (Money, Wallet, WagerTransaction)
api/src/application     casos de uso, eventos, idempotência
api/src/infrastructure  banco, SQS, outbox, workers, métricas, logs
api/src/interfaces      HTTP e consumidor SQS
api/test                integration, e2e, resilience, helpers
api/load                cenário k6
docs                    enunciado, decisões da etapa 2, resultados de carga
```

## Painel web (opcional)

Em `web/` há um painel de demonstração (Vite + React + TypeScript) para criar carteiras, enviar transações, ver ledger, reconciliar e rodar o cenário de disputa de saldo. É um extra, **fora do escopo avaliado**: a API não depende dele.

```bash
cd web
bun install
bun run dev          # http://localhost:5173 (proxy /api/* -> http://localhost:3000)
bun run typecheck && bun run build
```

Detalhes e a variável `VITE_API_URL` em [web/README.md](web/README.md).
