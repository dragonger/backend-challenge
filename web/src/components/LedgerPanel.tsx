import { useCallback, useEffect, useState } from 'react';

import { api, type ApiError, type LedgerItem } from '../api/client';
import { formatDate, formatMoney, shortId } from '../lib/format';
import { Card, ErrorBox } from './common';

interface Props {
  walletId: string | null;
  refreshKey: number;
}

export function LedgerPanel({ walletId, refreshKey }: Props) {
  const [items, setItems] = useState<LedgerItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ error: ApiError; status: number } | null>(null);

  const loadFirst = useCallback(async (id: string) => {
    setLoading(true);
    const response = await api.ledger(id, null);

    setLoading(false);
    setError(response.error ? { error: response.error, status: response.status } : null);

    if (response.data) {
      setItems(response.data.items);
      setCursor(response.data.nextCursor);
    }
  }, []);

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setError(null);

    if (walletId) {
      void loadFirst(walletId);
    }
  }, [walletId, refreshKey, loadFirst]);

  const loadMore = async () => {
    if (!walletId || !cursor) {
      return;
    }

    setLoading(true);
    const response = await api.ledger(walletId, cursor);

    setLoading(false);
    setError(response.error ? { error: response.error, status: response.status } : null);

    if (response.data) {
      const page = response.data;

      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    }
  };

  return (
    <Card title="Ledger">
      {!walletId ? (
        <p className="muted">Selecione uma carteira.</p>
      ) : (
        <>
          {items.length === 0 && !loading && !error ? (
            <p className="muted">Sem lançamentos.</p>
          ) : null}
          {items.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Data</th>
                    <th>Direção</th>
                    <th>Valor</th>
                    <th>Saldo antes</th>
                    <th>Saldo depois</th>
                    <th>transactionId</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => (
                    <tr key={item.id}>
                      <td>{index + 1}</td>
                      <td>{formatDate(item.createdAt)}</td>
                      <td>
                        <span className={`badge ${item.direction === 'CREDIT' ? 'ok' : 'bad'}`}>
                          {item.direction}
                        </span>
                      </td>
                      <td className="num">{formatMoney(item.money)}</td>
                      <td className="num">{formatMoney(item.balanceBefore)}</td>
                      <td className="num">{formatMoney(item.balanceAfter)}</td>
                      <td className="mono" title={item.transactionId}>
                        {shortId(item.transactionId)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {error ? <ErrorBox error={error.error} status={error.status} /> : null}
          <div className="row">
            {cursor ? (
              <button className="secondary" disabled={loading} onClick={() => void loadMore()}>
                {loading ? 'Carregando…' : 'Carregar mais'}
              </button>
            ) : null}
            {loading && !cursor ? <span className="muted">Carregando…</span> : null}
          </div>
        </>
      )}
    </Card>
  );
}
