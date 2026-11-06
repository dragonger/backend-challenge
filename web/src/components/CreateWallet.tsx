import { useState, type FormEvent } from 'react';

import { api, type ApiResult, type Wallet } from '../api/client';
import { newUuid } from '../lib/format';
import type { SessionWallet } from '../lib/session';
import { Card, ErrorBox, Field, HttpBadge, JsonBlock } from './common';

interface Props {
  onCreated: (wallet: SessionWallet) => void;
}

export function CreateWallet({ onCreated }: Props) {
  const [playerId, setPlayerId] = useState(newUuid());
  const [amount, setAmount] = useState('1000.00');
  const [currency, setCurrency] = useState('BRL');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApiResult<Wallet> | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);

    const response = await api.createWallet({
      playerId: playerId.trim(),
      initialBalance: { amount: amount.trim(), currency: currency.trim().toUpperCase() },
    });

    setResult(response);
    setBusy(false);

    if (response.data) {
      onCreated({
        id: response.data.id,
        playerId: response.data.playerId,
        currency: response.data.balance.currency,
        createdAt: new Date().toISOString(),
      });
      setPlayerId(newUuid());
    }
  };

  return (
    <Card title="Criar carteira">
      <form onSubmit={(event) => void submit(event)} className="form">
        <Field label="playerId" hint="UUID do jogador. Uma carteira por jogador e moeda.">
          <div className="row">
            <input value={playerId} onChange={(e) => setPlayerId(e.target.value)} className="mono" />
            <button type="button" className="secondary" onClick={() => setPlayerId(newUuid())}>
              Gerar UUID
            </button>
          </div>
        </Field>
        <div className="row">
          <Field label="Saldo inicial" hint="Texto decimal, até 2 casas.">
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Moeda">
            <input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} />
          </Field>
        </div>
        <button type="submit" disabled={busy}>
          {busy ? 'Criando…' : 'Criar carteira'}
        </button>
      </form>
      {result ? (
        <div className="result">
          <div className="result-head">
            <HttpBadge status={result.status} />
          </div>
          {result.data ? <JsonBlock value={result.data} /> : null}
          {result.error ? <ErrorBox error={result.error} status={result.status} /> : null}
        </div>
      ) : null}
    </Card>
  );
}
