import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { api, type ApiResult, type Wallet } from '../api/client';
import { formatMoney, shortId } from '../lib/format';
import type { SessionWallet } from '../lib/session';
import { Card, ErrorBox, Field } from './common';

interface Props {
  wallets: SessionWallet[];
  selectedId: string | null;
  refreshKey: number;
  onSelect: (id: string | null) => void;
  onOpened: (wallet: SessionWallet) => void;
}

export function WalletPanel({ wallets, selectedId, refreshKey, onSelect, onOpened }: Props) {
  const [manualId, setManualId] = useState('');
  const [result, setResult] = useState<ApiResult<Wallet> | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    const response = await api.getWallet(id);

    setResult(response);
    setLoading(false);

    return response;
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setResult(null);

      return;
    }

    void load(selectedId);
  }, [selectedId, refreshKey, load]);

  const open = async (event: FormEvent) => {
    event.preventDefault();
    const id = manualId.trim();

    if (!id) {
      return;
    }

    const response = await load(id);

    if (response.data) {
      onOpened({
        id: response.data.id,
        playerId: response.data.playerId,
        currency: response.data.balance.currency,
        createdAt: new Date().toISOString(),
      });
      onSelect(response.data.id);
      setManualId('');
    }
  };

  const wallet = result?.data;

  return (
    <Card
      title="Carteira"
      actions={
        selectedId ? (
          <button className="secondary small" disabled={loading} onClick={() => void load(selectedId)}>
            {loading ? 'Atualizando…' : 'Atualizar'}
          </button>
        ) : null
      }
    >
      <form onSubmit={(event) => void open(event)} className="form">
        <Field label="Abrir carteira por id">
          <div className="row">
            <input
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              placeholder="UUID da carteira"
              className="mono"
            />
            <button type="submit" className="secondary">
              Abrir
            </button>
          </div>
        </Field>
      </form>

      {wallets.length > 0 ? (
        <Field label="Carteiras desta sessão">
          <select value={selectedId ?? ''} onChange={(e) => onSelect(e.target.value || null)}>
            <option value="">Selecione…</option>
            {wallets.map((item) => (
              <option key={item.id} value={item.id}>
                {shortId(item.id)} · {item.currency}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <p className="muted">Nenhuma carteira nesta sessão ainda. Crie uma ou abra por id.</p>
      )}

      {wallet ? (
        <div className="balance-box">
          <span className="muted small">Saldo</span>
          <strong className="balance">{formatMoney(wallet.balance)}</strong>
          <dl className="kv">
            <dt>amount (string)</dt>
            <dd className="mono">{wallet.balance.amount}</dd>
            <dt>Moeda</dt>
            <dd>{wallet.balance.currency}</dd>
            <dt>walletId</dt>
            <dd className="mono">{wallet.id}</dd>
            <dt>playerId</dt>
            <dd className="mono">{wallet.playerId}</dd>
            <dt>version</dt>
            <dd>{wallet.version}</dd>
          </dl>
        </div>
      ) : null}
      {result?.error ? <ErrorBox error={result.error} status={result.status} /> : null}
    </Card>
  );
}
