import { useCallback, useEffect, useState } from 'react';

import type { SubmitResult, SubmitTransactionBody, TransactionStatus } from '../api/client';

export interface SessionWallet {
  id: string;
  playerId: string;
  currency: string;
  createdAt: string;
}

export interface TxRecord {
  transactionId: string;
  walletId: string;
  body: SubmitTransactionBody;
  idempotencyKey: string;
  httpStatus: number;
  status: TransactionStatus;
  failureCode?: string;
  balanceAmount?: string;
  idempotentReplay: boolean;
  sentAt: string;
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);

    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be blocked or full; the panel keeps working in memory.
  }
}

/** useState backed by localStorage; every access is wrapped in try/catch. */
export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => readStorage(key, initial));

  useEffect(() => {
    writeStorage(key, value);
  }, [key, value]);

  return [value, setValue] as const;
}

export function useSession() {
  const [wallets, setWallets] = usePersistentState<SessionWallet[]>('wagering.wallets', []);
  const [transactions, setTransactions] = usePersistentState<TxRecord[]>('wagering.txs', []);
  const [selectedId, setSelectedId] = usePersistentState<string | null>(
    'wagering.selected',
    null,
  );
  const [refreshKey, setRefreshKey] = useState(0);

  const addWallet = useCallback(
    (wallet: SessionWallet) => {
      setWallets((current) =>
        current.some((item) => item.id === wallet.id) ? current : [wallet, ...current],
      );
    },
    [setWallets],
  );

  /** One row per transactionId: a replay updates the row instead of duplicating it. */
  const recordTransaction = useCallback(
    (record: TxRecord) => {
      setTransactions((current) => {
        const without = current.filter((item) => item.transactionId !== record.transactionId);

        return [record, ...without].slice(0, 200);
      });
    },
    [setTransactions],
  );

  const updateStatus = useCallback(
    (transactionId: string, status: TransactionStatus, failureCode?: string) => {
      setTransactions((current) =>
        current.map((item) => {
          if (item.transactionId !== transactionId) {
            return item;
          }

          const { failureCode: _previous, ...rest } = item;

          return { ...rest, status, ...(failureCode ? { failureCode } : {}) };
        }),
      );
    },
    [setTransactions],
  );

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  return {
    wallets,
    transactions,
    selectedId,
    setSelectedId,
    refreshKey,
    refresh,
    addWallet,
    recordTransaction,
    updateStatus,
  };
}

export function toTxRecord(
  body: SubmitTransactionBody,
  idempotencyKey: string,
  httpStatus: number,
  result: SubmitResult,
): TxRecord {
  return {
    transactionId: result.transactionId,
    walletId: body.walletId,
    body,
    idempotencyKey,
    httpStatus,
    status: result.status,
    ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    balanceAmount: result.balance.amount,
    idempotentReplay: result.idempotentReplay,
    sentAt: new Date().toISOString(),
  };
}
