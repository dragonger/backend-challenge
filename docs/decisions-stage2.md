# Decisoes da Etapa 2 (insumo para o ARCHITECTURE.md)

## Regras de negocio (2.1)
- Referencia resolvida por (providerId, referenceExternalTransactionId), na mesma transacao SQL, com a wallet travada (FOR UPDATE). Regra pura em `domain/wager-transaction/reference-rules.ts`; um handler por kind em `application/wagering/handlers/`.
- REFUND e ROLLBACK exigem referencia. WIN e LOSS: referencia opcional; se vier, deve ser uma BET da mesma rodada. WIN sem BET e aceito.
- Ordem das verificacoes (respostas definitivas primeiro): mesmo provider/player/wallet/moeda/rodada (`REFERENCE_MISMATCH`), tipo permitido (`INVALID_REFERENCE_KIND`), referencia ainda nao resolvida (espera, PENDING_REFERENCE), referencia REJECTED/FAILED (`REFERENCE_NOT_PROCESSED`), valor igual so em REFUND/ROLLBACK (`AMOUNT_MISMATCH`), ja revertida (`REFERENCE_ALREADY_REVERSED`), saldo (`REVERSAL_WOULD_OVERDRAW`).
- REFUND referencia so BET. ROLLBACK referencia BET, WIN ou REFUND (ROLLBACK de ROLLBACK, LOSS ou OPENING e proibido).
- Uma transacao e revertida UMA vez no total (REFUND ou ROLLBACK). Checagem na aplicacao sob o lock da wallet; o indice unico parcial e a ultima barreira. REFUND/ROLLBACK de uma BET que ja teve WIN, ou WIN apos o REFUND da BET, nao sao bloqueados (fora do escopo; documentar como limitacao).
- ROLLBACK de BET credita; de WIN ou REFUND debita. Debito que deixaria saldo negativo: REJECTED `REVERSAL_WOULD_OVERDRAW`, persistido, sem ledger, evento `WagerTransactionRejected`. A rejeicao nao consome a reversao (um novo pedido pode ter sucesso depois).
- LOSS: PROCESSED sem mexer no saldo, sem ledger, `version` inalterada; gera `WagerTransactionProcessed` e nao `WalletBalanceChanged`.

## PENDING_REFERENCE (2.2)
- Referencia inexistente ou ainda pendente: persiste PENDING_REFERENCE com `attempts = 0`, `next_attempt_at = now + backoff inicial` e evento `WagerTransactionPendingReference`. `attempts` conta tentativas de resolucao que falharam.
- Backoff exponencial (1s inicial, teto 60s, jitter +/-20%). Desiste quando QUALQUER limite for atingido: 10 tentativas OU 15 min desde created_at (interpretacao de "E" como "o que vier primeiro", para manter o conjunto pendente finito). Esgotado: REJECTED `REFERENCE_NOT_FOUND` + `WagerTransactionRejected`. Config por env (`PENDING_REFERENCE_*`).
- Replay de pendente: status PENDING_REFERENCE, `idempotentReplay: true` e saldo ATUAL da wallet (o snapshot da linha pendente e so o saldo da ultima tentativa).
- `ResolvePendingTransaction.execute(id, {now?})`: trava a wallet, recarrega a linha apos o lock, reaplica a regra no mesmo caminho do submit; saidas NOT_FOUND, NOT_PENDING, RESCHEDULED, PROCESSED, REJECTED. Seguro sob concorrencia (o perdedor ve NOT_PENDING). `PendingTransactionsRepository.findDueIds(limit, now)` usa `FOR UPDATE SKIP LOCKED`. O loop agendado e da Etapa 3.

## HTTP (2.3, 2.4)
| Situacao | Status |
|---|---|
| Payload/header/query/param invalido, JSON malformado, cursor invalido, regra de dominio de entrada | 400 |
| Wallet ou transacao inexistente | 404 |
| Mesma key com payload diferente, provider id reutilizado, wallet duplicada (playerId+currency) | 409 |
| Transacao nova PROCESSED | 201 |
| Replay idempotente PROCESSED | 200 |
| REJECTED por regra de negocio (novo ou replay), corpo com resultado e `failureCode` | 422 |
| PENDING_REFERENCE (novo ou replay) | 202 |
| Falha transitoria (lock timeout, deadlock, banco fora) com `Retry-After: 1` | 503 |
| FAILED (nao gerado nesta etapa) e erro inesperado | 500 (mensagem generica, stack so no log) |
- Filtro global `@Catch()` via APP_FILTER, corpo de erro `{error: {code, message, details?}}`. Validacao com zod (`strictObject`, sem coercao, amount string); `limit` do ledger fora de 1..200 e rejeitado (nao ajustado).
- Ledger: keyset por `sequence`, ordem crescente, cursor opaco `base64url("v1:<sequence>")`, `nextCursor` nulo na ultima pagina. Dentro de uma wallet a ordem de `sequence` e a ordem de commit (escritas serializadas pelo lock), entao nao ha pulo nem repeticao. Cuidado de implementacao: no SQL, `ORDER BY` precisa usar a coluna qualificada (`l.sequence`), pois o alias de saida em texto ordenaria lexicograficamente.
- `Idempotency-Key` obrigatorio; `X-Correlation-Id` opcional (`[A-Za-z0-9._:-]{1,128}`), repassado e devolvido no header.

## Reconciliacao (2.5)
- Um unico SELECT (snapshot unico) compara `wallets.balance` com creditos menos debitos do ledger, tudo em `numeric` no PostgreSQL. Nunca corrige; divergencia gera log warn e incrementa `wallet_reconciliation_mismatches_total` (registry proprio do prom-client em `MetricsService`). Resposta sempre 200.

## Health (2.6) e Auth (2.7)
- Controller proprio (sem terminus). `/health/live` sempre 200. `/health/ready`: `select 1` e `GetQueueAttributes` na fila principal, timeout curto (2s), 503 com detalhe por dependencia. Config SQS reutilizavel em `infrastructure/sqs` (defaults locais: LocalStack em localhost:4566 com credenciais ficticias fora de producao).
- `ProviderIdentityPort` + `AuthGuard` global no-op; rotas `@Public()` (health, futuro /metrics). Para ativar: implementar a porta (OIDC/JWT de Keycloak ou Zitadel) e trocar o provider `PROVIDER_IDENTITY`.

## Testes
- Unidade (regras, handlers, politica de backoff, cursor, DTOs, mapeamento de erros), integracao com PostgreSQL real (regras, pendentes, concorrencia de reversoes, reconciliacao) e e2e HTTP com a app Nest real; 503 provocado por lock timeout real. Invariante saldo == ledger ao fim de cada teste.
