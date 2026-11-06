# Teste de carga

Comando: `cd api && bun run test:load` (script `api/scripts/load-test.ts`, cenário k6 em `api/load/k6/wagering.js`). Resultado bruto da última execução: `api/load/.out/result.json` (ignorado pelo git).

## Ambiente da medição

| Item | Valor |
|---|---|
| Máquina | Windows 11 Pro, AMD Ryzen 7 5700X (8 núcleos, 16 threads), 32 GB de RAM |
| Containers | Docker Desktop (16 CPUs, 16 GB), PostgreSQL 17-alpine e LocalStack 3.8.1 sem ajuste de configuração |
| Aplicação | 3 processos `bun src/main.ts` (Bun 1.4.3) na máquina host, pool de 20 conexões cada, `lock_timeout` de 5 s, publisher da outbox ligado nos 3, consumidor SQS e worker de pendentes desligados |
| Gerador de carga | `grafana/k6` (latest) em container, alcançando o host por `host.docker.internal`, VUs distribuídas entre as 3 instâncias |
| Banco | `jungle_wagering_test` (truncado antes da corrida) |
| Data | 2026-11-06 |

Tudo roda na mesma máquina: aplicação, PostgreSQL, LocalStack e k6 disputam CPU e o resultado é menor que o de um ambiente com recursos separados. Os números servem para comparar cenários entre si e para checar correção sob carga, não como capacidade de produção.

## Metodologia

1. O script prepara o banco (migrations e `TRUNCATE`), cria uma fila FIFO de eventos descartável e sobe as instâncias.
2. O k6 roda dois cenários **em sequência**, cada um com 32 VUs por 30 s (`constant-vus`), com 5 s de intervalo:
   - `distinct_wallets`: cada VU aposta na **sua própria** wallet (sem contenção de lock).
   - `hot_wallet`: as 32 VUs apostam na **mesma** wallet (pior caso para o lock pessimista).
3. Cada iteração envia uma `BET` de 1,00 BRL com `Idempotency-Key` e `externalTransactionId` únicos (`POST /wagering/transactions`, esperado 201). Uma iteração em cada 10 reenvia a requisição anterior (esperado 200 com `idempotentReplay: true`), exercitando o caminho de replay. Não há think time: as VUs disparam em loop fechado.
4. Durante a corrida, o script lê `GET /metrics` das 3 instâncias a cada 1 s (`outbox_lag_seconds`, `outbox_pending`) e, ao final, soma os contadores (`lock_conflicts_total`, `wager_processing_duration_seconds`, etc.).
5. Depois do k6, espera a outbox esvaziar e verifica no SQL: saldo de toda wallet igual ao ledger, nenhuma wallet negativa, e uma linha de débito no ledger por `BET` `PROCESSED`.
6. Vazão = requisições do cenário dividido pela duração do cenário (o `rate` do k6 divide pelo tempo total do teste, então não é usado). Percentis vêm do k6 (`http_req_duration` filtrado por cenário).

## Resultados (uma execução de referência)

| Cenário | Requisições | Vazão (req/s) | p50 | p95 | p99 | Máx | Erros |
|---|---|---|---|---|---|---|---|
| Wallets distintas | 16.156 | 538 | 59 ms | 99 ms | 123 ms | 287 ms | 0 % |
| Wallet quente (mesma wallet) | 4.009 | 134 | 24 ms | 1.961 ms | 2.344 ms | 2.992 ms | 0 % |

Lado do servidor (soma das 3 instâncias):

| Métrica | Valor |
|---|---|
| Conflitos de lock (`lock_conflicts_total`: lock timeout + deadlock) | 0 |
| Replays idempotentes | 1.999 |
| Latência média de processamento no servidor (histograma) | 89,8 ms (média dos dois cenários) |
| Eventos publicados / falhas de publicação | 36.398 / 0 |
| `outbox_lag_seconds` máximo (amostrado a cada 1 s) | 3,2 s |
| `outbox_pending` máximo | 360 linhas |
| Tempo para esvaziar a outbox depois do fim da carga | menos de 1 s |

Invariantes após a carga: 0 wallets com saldo diferente do ledger; 18.166 `BET` processadas = 18.166 débitos no ledger; 0 eventos sem publicar.

## Análise

- **Wallets distintas** escalam bem: cerca de 540 req/s com p99 abaixo de 125 ms, sem erros, em 3 instâncias disputando um único PostgreSQL. A latência (p50 de 59 ms) é dominada pelo custo da transação (várias escritas: transação, wallet, ledger e 2 linhas de outbox, mais a consulta de idempotência) e pela competição por CPU na mesma máquina.
- **Wallet quente** mostra o custo esperado do lock pessimista: a vazão cai para cerca de 134 req/s (uma transação por vez na wallet) e o p95/p99 sobe para 2 a 2,3 s, porque 32 requisições esperam na fila de lock. O p50 de 24 ms engana: ele inclui os replays (que não precisam do lock) e requisições que pegam o lock rápido; a distribuição é bimodal e a cauda é injusta (o PostgreSQL não garante FIFO estrito nos waiters). Nenhuma requisição estourou o `lock_timeout` de 5 s (a pior ficou em 3 s), por isso `lock_conflicts_total` ficou em 0 e não houve 503. Com mais VUs ou um `LOCK_TIMEOUT_MS` menor, os 503 com `Retry-After` apareceriam, e a métrica os contaria.
- **Alternativa se a wallet quente fosse requisito:** o `UPDATE` atômico condicionado (`balance = balance - x WHERE balance >= x`) reduziria o tempo sob o lock. Ele não foi adotado porque o ledger com `balance_before/after`, o snapshot do resultado e as regras de referência dependem do estado lido sob lock (ARCHITECTURE.md, seção 5). Esta medição é a evidência para reavaliar a decisão se necessário.
- **Outbox:** com 3 publishers e lote de 50, o publisher acompanhou a taxa de escrita (cerca de 500 linhas/s, 2 a 3 eventos por `BET`) com poucas centenas de linhas pendentes. O lag de 2 a 3 s observado na fase de wallet quente é em grande parte artefato de medição: `created_at` da linha da outbox é carimbado pela aplicação no **início** da transação, e na wallet quente a transação passa até 3 s esperando o lock antes de commitar. O atraso real entre o commit e a publicação é menor que o valor reportado. Depois do fim da carga a outbox esvaziou em menos de 1 s.
- **Limitações do experimento:** uma única execução por configuração (sem barras de erro), tudo na mesma máquina, VUs em loop fechado (sem taxa de chegada fixa, logo sem coordinated omission tratado), sem tráfego SQS e sem o worker de pendentes ligados, banco local sem tuning. Repetir com `LOAD_INSTANCES`, `LOAD_VUS` e `LOAD_DURATION_S` (variáveis de ambiente do script) para outras configurações.
