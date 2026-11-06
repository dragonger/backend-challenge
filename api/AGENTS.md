# AGENTS.md

Orientações para quem (pessoa ou agente) altera esta API. Visão geral e decisões: `../README.md` e `../ARCHITECTURE.md`.

## Stack e comandos (a partir de `api/`)
- Bun + NestJS 12 + MikroORM 7 (PostgreSQL) + SQS (LocalStack). Infra local: `docker compose up -d` na raiz.
- `bun run typecheck`, `bun run lint` (oxlint), `bun run build`, `bun run start`.
- Testes: `bun run test` (tudo), `test:unit`, `test:integration`, `test:e2e`, `test:resilience`. Todos usam o banco `*_test` e nunca o de desenvolvimento. Carga: `bun run test:load`.
- Migrations são SQL escrito à mão em `src/infrastructure/database/migrations` (`bun run migration:up`).

## Camadas (dependências apontam para dentro)
- `domain/`: puro (Money, Wallet, WagerTransaction, regras de referência). Sem Nest, sem ORM.
- `application/`: casos de uso, eventos de integração, idempotência. `ProcessWagerTransaction` é o ÚNICO caminho de escrita financeira (HTTP e SQS). `ResolvePendingTransaction` reprocessa pendentes.
- `infrastructure/`: banco (entidades, mappers, `TransactionRunner`), SQS, outbox, workers, métricas, logs.
- `interfaces/`: HTTP (controllers, DTOs zod, filtro de erros) e mensageria (consumidor SQS).

## Regras que não se quebram
- Dinheiro nunca é `number`: `Money` (decimal.js) no domínio, `numeric(20,2)` no banco, string no JSON.
- Toda mutação financeira acontece numa transação SQL com a wallet travada (`FOR UPDATE`); inbox, transação, ledger, saldo e outbox commitam juntos.
- Ack do SQS só depois do commit. Publicação de evento só via outbox.
- Rejeição de negócio é persistida (REJECTED) e responde 422/ack; erro transitório vira `TransientInfrastructureError` (503 / retry com backoff).
- Saldo == soma do ledger (`test/helpers/invariants.ts` é verificada ao fim dos testes).

## Observabilidade
- Logs JSON via `nestjs-pino`; o contexto (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`) vem de `AsyncLocalStorage` (`infrastructure/observability`). Não logue payload financeiro nem headers de autenticação.
- Métricas Prometheus em `GET /metrics` (`MetricsService`, registry próprio). Nova métrica entra em `infrastructure/metrics/metrics.service.ts`.

## Segredos e config
- Nunca commitar `.env`. Novas variáveis vão para `../.env.example` com valor fictício e default seguro; leitura tipada em `src/config/env.ts`.
- Workers (`SQS_CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, `PENDING_WORKER_ENABLED`) ficam desligados por padrão com `NODE_ENV=test`.

## Testes de resiliência
- Usam filas isoladas (sufixo por execução) criadas e apagadas pelo teste, e processos reais (`Bun.spawn` de `bun src/main.ts`). O seam `TEST_CRASH_AFTER_COMMIT=1` só funciona com `NODE_ENV=test`.
