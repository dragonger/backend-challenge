import { useState } from 'react';

import { api, type ApiResult, type TransactionView } from '../api/client';
import { formatMoney, shortId } from '../lib/format';
import type { TxRecord } from '../lib/session';
import { Card, ErrorBox, HttpBadge, JsonBlock, StatusBadge } from './common';

interface Props {
  transactions: TxRecord[];
  walletId: string | null;
  onStatus: (transactionId: string, status: TxRecord['status'], failureCode?: string) => void;
}

export function TransactionHistory({ transactions, walletId, onStatus }: Props) {
  const [onlySelected, setOnlySelected] = useState(true);
  const [detail, setDetail] = useState<ApiResult<TransactionView> | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const rows =
    onlySelected && walletId ? transactions.filter((tx) => tx.walletId === walletId) : transactions;

  const lookup = async (transactionId: string) => {
    setLoadingId(transactionId);
    const response = await api.getTransaction(transactionId);

    setDetail(response);
    setLoadingId(null);

    if (response.data) {
      onStatus(transactionId, response.data.status, response.data.failureCode);
    }
  };

  return (
    <Card
      title="Histórico da sessão"
      actions={
        <label className="check small">
          <input
            type="checkbox"
            checked={onlySelected}
            onChange={(e) => setOnlySelected(e.target.checked)}
          />
          só a carteira selecionada
        </label>
      }
    >
      {rows.length === 0 ? (
        <p className="muted">Nenhuma transação enviada ainda.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Hora</th>
                <th>Tipo</th>
                <th>Valor</th>
                <th>externalId</th>
                <th>HTTP</th>
                <th>Status</th>
                <th>failureCode</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((tx) => (
                <tr key={tx.transactionId}>
                  <td>{new Date(tx.sentAt).toLocaleTimeString('pt-BR')}</td>
                  <td>{tx.body.kind}</td>
                  <td className="num">{formatMoney(tx.body.money)}</td>
                  <td className="mono" title={tx.body.externalTransactionId}>
                    {tx.body.externalTransactionId}
                  </td>
                  <td>
                    <HttpBadge status={tx.httpStatus} />
                  </td>
                  <td>
                    <StatusBadge status={tx.status} />
                  </td>
                  <td className="mono">{tx.failureCode ?? ''}</td>
                  <td>
                    <button
                      className="secondary small"
                      disabled={loadingId === tx.transactionId}
                      onClick={() => void lookup(tx.transactionId)}
                      title={tx.transactionId}
                    >
                      Consultar {shortId(tx.transactionId).slice(0, 8)}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail?.data ? (
        <>
          <h3>GET /wagering/transactions/{shortId(detail.data.transactionId)}</h3>
          <JsonBlock value={detail.data} />
        </>
      ) : null}
      {detail?.error ? <ErrorBox error={detail.error} status={detail.status} /> : null}
    </Card>
  );
}
