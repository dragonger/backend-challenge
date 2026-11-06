import { useEffect, useState } from 'react';

import { api, type ApiResult, type ReconciliationResult } from '../api/client';
import { formatMoney } from '../lib/format';
import { Card, ErrorBox } from './common';

interface Props {
  walletId: string | null;
}

export function ReconciliationPanel({ walletId }: Props) {
  const [result, setResult] = useState<ApiResult<ReconciliationResult> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setResult(null);
  }, [walletId]);

  const run = async () => {
    if (!walletId) {
      return;
    }

    setBusy(true);
    setResult(await api.reconcile(walletId));
    setBusy(false);
  };

  const data = result?.data;

  return (
    <Card title="Reconciliação">
      <p className="muted">
        Compara o saldo armazenado com o saldo recalculado a partir do ledger. Apenas audita, nunca corrige.
      </p>
      <button disabled={!walletId || busy} onClick={() => void run()}>
        {busy ? 'Verificando…' : 'Reconciliar carteira'}
      </button>
      {data ? (
        <div className="result">
          <div className="result-head">
            <span className={`badge ${data.consistent ? 'ok' : 'bad'}`}>
              {data.consistent ? 'consistente' : 'inconsistente'}
            </span>
            <span className="muted small">{data.checkedEntries} lançamentos conferidos</span>
          </div>
          <dl className="kv">
            <dt>stored</dt>
            <dd>
              {formatMoney(data.storedBalance)} <span className="mono muted">({data.storedBalance.amount})</span>
            </dd>
            <dt>calculated</dt>
            <dd>
              {formatMoney(data.calculatedBalance)}{' '}
              <span className="mono muted">({data.calculatedBalance.amount})</span>
            </dd>
            <dt>difference</dt>
            <dd>
              {formatMoney(data.difference)} <span className="mono muted">({data.difference.amount})</span>
            </dd>
          </dl>
        </div>
      ) : null}
      {result?.error ? <ErrorBox error={result.error} status={result.status} /> : null}
    </Card>
  );
}
