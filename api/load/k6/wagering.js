// k6 scenario for POST /wagering/transactions. Driven by scripts/load-test.ts.
//
// Two scenarios run one after the other, each for DURATION:
//   distinct_wallets  every VU bets on its OWN wallet (no lock contention)
//   hot_wallet        every VU bets on the SAME wallet (worst case for the lock)
//
// Every 10th iteration resends the previous request (same Idempotency-Key and
// payload) to exercise the replay path (expects 200 instead of 201).
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URLS = (__ENV.BASE_URLS || 'http://localhost:3000').split(',');
const VUS = Number(__ENV.VUS || 32);
const DURATION_S = Number(__ENV.DURATION_S || 30);
const GAP_S = 5;

const created = new Counter('wager_created');
const replays = new Counter('wager_replays');
const unavailable = new Counter('wager_503');

export const options = {
  scenarios: {
    distinct_wallets: {
      executor: 'constant-vus',
      vus: VUS,
      duration: `${DURATION_S}s`,
      exec: 'distinct',
    },
    hot_wallet: {
      executor: 'constant-vus',
      vus: VUS,
      duration: `${DURATION_S}s`,
      startTime: `${DURATION_S + GAP_S}s`,
      exec: 'hot',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Generous limits: they exist to create the per-scenario sub-metrics in the
  // summary, and to fail the run on a clearly broken system.
  thresholds: {
    'http_req_duration{scenario:distinct_wallets}': ['p(99)<10000'],
    'http_req_duration{scenario:hot_wallet}': ['p(99)<10000'],
    'http_req_failed{scenario:distinct_wallets}': ['rate<0.05'],
    'http_req_failed{scenario:hot_wallet}': ['rate<0.05'],
    'http_reqs{scenario:distinct_wallets}': ['count>0'],
    'http_reqs{scenario:hot_wallet}': ['count>0'],
  },
};

const hex = (n) => {
  let out = '';
  for (let i = 0; i < n; i += 1) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
};
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function setup() {
  const open = (baseUrl) => {
    const playerId = uuid();
    const response = http.post(
      `${baseUrl}/wallets`,
      JSON.stringify({ playerId, initialBalance: { amount: '1000000000.00', currency: 'BRL' } }),
      { headers: JSON_HEADERS, tags: { phase: 'setup' } },
    );
    if (response.status !== 201) {
      throw new Error(`could not create wallet: ${response.status} ${response.body}`);
    }
    return { walletId: response.json('id'), playerId };
  };

  const distinct = [];
  for (let i = 0; i < VUS; i += 1) {
    distinct.push(open(BASE_URLS[0]));
  }
  return { distinct, hot: open(BASE_URLS[0]) };
}

let previous = null;

function bet(wallet, baseUrl) {
  // Replay of the previous request every 10th iteration.
  if (previous && __ITER % 10 === 9) {
    const replay = http.post(baseUrl + '/wagering/transactions', previous.body, previous.params);
    check(replay, { 'replay is 200': (r) => r.status === 200 });
    replays.add(1);
    previous = null;
    return;
  }

  const externalTransactionId = `k6-${__VU}-${__ITER}-${hex(8)}`;
  const body = JSON.stringify({
    providerId: 'provider-load',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: `round-${__VU}`,
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '1.00', currency: 'BRL' },
  });
  const params = {
    headers: { ...JSON_HEADERS, 'Idempotency-Key': `provider-load:${externalTransactionId}` },
  };
  const response = http.post(baseUrl + '/wagering/transactions', body, params);

  if (response.status === 503) {
    unavailable.add(1);
  }
  if (check(response, { 'created (201)': (r) => r.status === 201 })) {
    created.add(1);
  }
  previous = { body, params };
}

export function distinct(data) {
  bet(data.distinct[(__VU - 1) % data.distinct.length], BASE_URLS[__VU % BASE_URLS.length]);
}

export function hot(data) {
  bet(data.hot, BASE_URLS[__VU % BASE_URLS.length]);
}
