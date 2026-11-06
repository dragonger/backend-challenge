/** Contracts of the wagering API. Money is ALWAYS a decimal string. */

export interface Money {
  amount: string;
  currency: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiResult<T> {
  /** HTTP status; 0 when the request never reached the API. */
  status: number;
  ok: boolean;
  /** Parsed body when it is not an error envelope (may exist on 422 and 503). */
  data: T | null;
  error: ApiError | null;
  retryAfter: string | null;
}

export type TransactionKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export const TRANSACTION_KINDS: readonly TransactionKind[] = [
  'BET',
  'WIN',
  'LOSS',
  'REFUND',
  'ROLLBACK',
];

export type TransactionStatus =
  | 'PROCESSED'
  | 'REJECTED'
  | 'PENDING_REFERENCE'
  | 'PENDING'
  | 'FAILED';

export interface DependencyStatus {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: { database: DependencyStatus; sqs: DependencyStatus };
}

export interface Wallet {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
}

export interface CreateWalletBody {
  playerId: string;
  initialBalance: Money;
}

export interface SubmitTransactionBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: TransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface SubmitResult {
  transactionId: string;
  status: TransactionStatus;
  balance: Money;
  idempotentReplay: boolean;
  failureCode?: string;
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  status: TransactionStatus;
  failureCode?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  balance?: Money;
  attempts: number;
  nextAttemptAt?: string;
  createdAt: string;
  processedAt?: string;
}

export interface LedgerItem {
  id: string;
  transactionId: string;
  direction: string;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerItem[];
  nextCursor: string | null;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

const BASE = '/api';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toApiError = (value: unknown): ApiError | null => {
  if (!isRecord(value) || !isRecord(value.error)) {
    return null;
  }

  const { code, message, details } = value.error;

  return {
    code: typeof code === 'string' ? code : 'UNKNOWN',
    message: typeof message === 'string' ? message : 'Erro sem mensagem',
    ...(details !== undefined ? { details } : {}),
  };
};

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

/** Never throws: network failures and HTTP errors come back as a value. */
async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  let response: Response;

  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (cause) {
    return {
      status: 0,
      ok: false,
      data: null,
      error: {
        code: 'NETWORK_ERROR',
        message: `Não foi possível falar com a API (${
          cause instanceof Error ? cause.message : 'erro de rede'
        }). Confira se ela está rodando.`,
      },
      retryAfter: null,
    };
  }

  const retryAfter = response.headers.get('retry-after');
  const text = await response.text();
  let parsed: unknown = null;

  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  const envelope = toApiError(parsed);

  if (envelope) {
    return { status: response.status, ok: false, data: null, error: envelope, retryAfter };
  }

  if (parsed === null) {
    return {
      status: response.status,
      ok: response.ok,
      data: null,
      error: response.ok
        ? null
        : {
            code: `HTTP_${response.status}`,
            message:
              'Resposta sem corpo JSON. Se o status for 500 ou 502, a API provavelmente está fora do ar.',
          },
      retryAfter,
    };
  }

  return { status: response.status, ok: response.ok, data: parsed as T, error: null, retryAfter };
}

export const api = {
  ready: () => call<ReadinessReport>('GET', '/health/ready'),

  createWallet: (body: CreateWalletBody) => call<Wallet>('POST', '/wallets', { body }),

  getWallet: (walletId: string) => call<Wallet>('GET', `/wallets/${encodeURIComponent(walletId)}`),

  ledger: (walletId: string, cursor: string | null, limit = 20) => {
    const query = new URLSearchParams({ limit: String(limit) });

    if (cursor) {
      query.set('cursor', cursor);
    }

    return call<LedgerPage>(
      'GET',
      `/wallets/${encodeURIComponent(walletId)}/ledger?${query.toString()}`,
    );
  },

  reconcile: (walletId: string) =>
    call<ReconciliationResult>('POST', `/wallets/${encodeURIComponent(walletId)}/reconciliation`),

  submitTransaction: (body: SubmitTransactionBody, idempotencyKey: string) =>
    call<SubmitResult>('POST', '/wagering/transactions', {
      body,
      headers: idempotencyKey.length > 0 ? { 'Idempotency-Key': idempotencyKey } : {},
    }),

  getTransaction: (transactionId: string) =>
    call<TransactionView>('GET', `/wagering/transactions/${encodeURIComponent(transactionId)}`),
};
