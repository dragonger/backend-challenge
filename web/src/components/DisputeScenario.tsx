import { useState } from 'react';

import {
  api,
  type ApiError,
  type ApiResult,
  type SubmitResult,
  type SubmitTransactionBody,
  type Wallet,
} from '../api/client';
import { formatMoney, newExternalId, newUuid } from '../lib/format';
import { toTxRecord, type SessionWallet, type TxRecord } from '../lib/session';
import { Card, ErrorBox, HttpBadge, StatusBadge } from './common';

interface Props {
  onWalletCreated: (wallet: SessionWallet) => void;
  onRecord: (record: TxRecord) => void;
  onSelect: (walletId: string) => void;
}

interface Outcome {
  results: ApiResult<SubmitResult>[];
  finalWallet: Wallet | null;
  setupError: { error: ApiError; status: number } | null;
}

const EXPECTED_FINAL = '20.00';

export function DisputeScenario({ onWalletCreated, onRecord, onSelect }: Props) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const run = async () => {
    setBusy(true);
    setOutcome(null);

    const playerId = newUuid();
    const created = await api.createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    if (!created.data) {
      setOutcome({
        results: [],
        finalWallet: null,
        setupError: created.error ? { error: created.error, status: created.status } : null,
      });
      setBusy(false);

      return;
    }

    const wallet = created.data;

    onWalletCreated({
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.balance.currency,
      createdAt: new Date().toISOString(),
    });
    onSelect(wallet.id);

    const roundId = `dispute-${newExternalId()}`;
    const bodies: SubmitTransactionBody[] = [0, 1].map(() => ({
      providerId: 'demo-provider',
      externalTransactionId: newExternalId(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId,
      gameId: 'demo-game',
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
    }));

    // Both requests leave at the same time; the wallet lock decides the winner.
    const results = await Promise.all(
      bodies.map((body) =>
        api.submitTransaction(body, `${body.providerId}:${body.externalTransactionId}`),
      ),
    );

    results.forEach((result, index) => {
      const body = bodies[index];

      if (result.data && body) {
        onRecord(
          toTxRecord(body, `${body.providerId}:${body.externalTransactionId}`, result.status, result.data),
        );
      }
    });

    const finalWallet = (await api.getWallet(wallet.id)).data;

    setOutcome({ results, finalWallet, setupError: null });
    setBusy(false);
  };

  const processed = outcome?.results.filter((r) => r.data?.status === 'PROCESSED').length ?? 0;
  const rejected =
    outcome?.results.filter(
      (r) => r.data?.status === 'REJECTED' && r.data.failureCode === 'INSUFFICIENT_BALANCE',
    ).length ?? 0;
  const confirmed =
    outcome !== null &&
    processed === 1 &&
    rejected === 1 &&
    outcome.finalWallet?.balance.amount === EXPECTED_FINAL;

  return (
    <Card title="Cenário: disputa de saldo">
      <p className="muted">
        Cria uma carteira com R$ 100,00 e dispara duas apostas (BET) de R$ 80,00 ao mesmo tempo. Só uma pode
        passar: a outra deve ser rejeitada com INSUFFICIENT_BALANCE e o saldo final deve ser 20.00.
      </p>
      <button disabled={busy} onClick={() => void run()}>
        {busy ? 'Executando…' : 'Executar cenário'}
      </button>
      {outcome?.setupError ? (
        <ErrorBox error={outcome.setupError.error} status={outcome.setupError.status} />
      ) : null}
      {outcome && outcome.results.length > 0 ? (
        <div className="result">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Aposta</th>
                  <th>HTTP</th>
                  <th>Status</th>
                  <th>failureCode</th>
                  <th>Saldo</th>
                </tr>
              </thead>
              <tbody>
                {outcome.results.map((result, index) => (
                  <tr key={index}>
                    <td>BET {index + 1} de 80.00</td>
                    <td>
                      <HttpBadge status={result.status} />
                    </td>
                    <td>{result.data ? <StatusBadge status={result.data.status} /> : (result.error?.code ?? '')}</td>
                    <td className="mono">{result.data?.failureCode ?? ''}</td>
                    <td className="num">{result.data ? formatMoney(result.data.balance) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Saldo final:{' '}
            <strong>{outcome.finalWallet ? formatMoney(outcome.finalWallet.balance) : 'indisponível'}</strong>{' '}
            <span className="mono muted">({outcome.finalWallet?.balance.amount ?? '?'})</span>
          </p>
          <span className={`badge ${confirmed ? 'ok' : 'bad'}`}>
            {confirmed ? 'Esperado: 1 PROCESSED, 1 REJECTED e saldo 20.00' : 'Resultado diferente do esperado'}
          </span>
        </div>
      ) : null}
    </Card>
  );
}
