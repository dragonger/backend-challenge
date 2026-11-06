import { useEffect, useState, type FormEvent } from 'react';

import {
  api,
  TRANSACTION_KINDS,
  type ApiResult,
  type SubmitResult,
  type SubmitTransactionBody,
  type TransactionKind,
} from '../api/client';
import { newExternalId, newRoundId } from '../lib/format';
import { toTxRecord, type SessionWallet, type TxRecord } from '../lib/session';
import { Card, Field, SubmitResultView } from './common';

interface Props {
  wallet: SessionWallet | null;
  transactions: TxRecord[];
  onRecord: (record: TxRecord) => void;
  onDone: () => void;
}

interface LastRequest {
  body: SubmitTransactionBody;
  key: string;
}

const REFERENCE_REQUIRED: TransactionKind[] = ['REFUND', 'ROLLBACK'];
const REFERENCE_OPTIONAL: TransactionKind[] = ['WIN', 'LOSS'];

export function TransactionForm({ wallet, transactions, onRecord, onDone }: Props) {
  const [kind, setKind] = useState<TransactionKind>('BET');
  const [amount, setAmount] = useState('10.00');
  const [currency, setCurrency] = useState(wallet?.currency ?? 'BRL');
  const [providerId, setProviderId] = useState('demo-provider');
  const [roundId, setRoundId] = useState(newRoundId());
  const [gameId, setGameId] = useState('demo-game');
  const [externalId, setExternalId] = useState(newExternalId());
  const [reference, setReference] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<LastRequest | null>(null);
  const [result, setResult] = useState<ApiResult<SubmitResult> | null>(null);
  const [caption, setCaption] = useState('');

  useEffect(() => {
    if (wallet) {
      setCurrency(wallet.currency);
    }

    setReference('');
    setLast(null);
    setResult(null);
    setCaption('');
  }, [wallet?.id, wallet?.currency]);

  const defaultKey = `${providerId}:${externalId}`;
  const effectiveKey = keyTouched ? key : defaultKey;
  const needsReference = REFERENCE_REQUIRED.includes(kind);
  const showReference = needsReference || REFERENCE_OPTIONAL.includes(kind);
  const references = wallet ? transactions.filter((tx) => tx.walletId === wallet.id) : [];

  const send = async (body: SubmitTransactionBody, idempotencyKey: string, label: string) => {
    setBusy(true);
    const response = await api.submitTransaction(body, idempotencyKey);

    setResult(response);
    setCaption(label);
    setBusy(false);

    if (response.data) {
      onRecord(toTxRecord(body, idempotencyKey, response.status, response.data));
    }

    onDone();

    return response;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (!wallet) {
      return;
    }

    const trimmedReference = reference.trim();
    const body: SubmitTransactionBody = {
      providerId: providerId.trim(),
      externalTransactionId: externalId.trim(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: roundId.trim(),
      gameId: gameId.trim(),
      kind,
      money: { amount: amount.trim(), currency: currency.trim().toUpperCase() },
      ...(showReference && trimmedReference ? { referenceExternalTransactionId: trimmedReference } : {}),
    };

    setLast({ body, key: effectiveKey });
    await send(body, effectiveKey, 'Nova transação');

    // Next submit is a different transaction: fresh external id, default key again.
    setExternalId(newExternalId());
    setKeyTouched(false);
    setKey('');
  };

  const replay = async () => {
    if (last) {
      await send(last.body, last.key, 'Reenvio idempotente (mesma key e mesmo payload)');
    }
  };

  const conflict = async () => {
    if (last) {
      await send(
        { ...last.body, roundId: `${last.body.roundId}-alterado` },
        last.key,
        'Mesma key com payload diferente (roundId alterado)',
      );
    }
  };

  return (
    <Card title="Nova transação">
      {!wallet ? (
        <p className="muted">Selecione ou crie uma carteira para enviar transações.</p>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="form">
          <div className="row">
            <Field label="kind">
              <select value={kind} onChange={(e) => setKind(e.target.value as TransactionKind)}>
                {TRANSACTION_KINDS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Valor">
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Moeda">
              <input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} />
            </Field>
          </div>
          <div className="row">
            <Field label="providerId">
              <input value={providerId} onChange={(e) => setProviderId(e.target.value)} />
            </Field>
            <Field label="gameId">
              <input value={gameId} onChange={(e) => setGameId(e.target.value)} />
            </Field>
            <Field label="roundId">
              <input value={roundId} onChange={(e) => setRoundId(e.target.value)} />
            </Field>
          </div>
          <Field label="externalTransactionId" hint="Gerado automaticamente; pode editar.">
            <div className="row">
              <input
                value={externalId}
                onChange={(e) => setExternalId(e.target.value)}
                className="mono"
              />
              <button type="button" className="secondary" onClick={() => setExternalId(newExternalId())}>
                Novo
              </button>
            </div>
          </Field>
          {showReference ? (
            <Field
              label={`referenceExternalTransactionId${needsReference ? ' (obrigatório)' : ' (opcional)'}`}
              hint={
                references.length > 0
                  ? 'Escolha uma transação enviada nesta sessão para esta carteira, ou digite.'
                  : 'Nenhuma transação enviada para esta carteira ainda; digite o id externo.'
              }
            >
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                list="reference-options"
                required={needsReference}
                className="mono"
              />
              <datalist id="reference-options">
                {references.map((tx) => (
                  <option key={tx.transactionId} value={tx.body.externalTransactionId}>
                    {tx.body.kind} {tx.body.money.amount} ({tx.status})
                  </option>
                ))}
              </datalist>
            </Field>
          ) : null}
          <Field label="Header Idempotency-Key" hint="Padrão: providerId:externalTransactionId.">
            <input
              value={effectiveKey}
              onChange={(e) => {
                setKey(e.target.value);
                setKeyTouched(true);
              }}
              className="mono"
            />
          </Field>
          <div className="row wrap">
            <button type="submit" disabled={busy}>
              {busy ? 'Enviando…' : 'Enviar transação'}
            </button>
            <button type="button" className="secondary" disabled={busy || !last} onClick={() => void replay()}>
              Reenviar a última
            </button>
            <button type="button" className="secondary" disabled={busy || !last} onClick={() => void conflict()}>
              Mesma key, payload diferente
            </button>
          </div>
        </form>
      )}
      {result ? (
        <>
          <p className="muted small">{caption}</p>
          <SubmitResultView result={result} />
        </>
      ) : null}
    </Card>
  );
}
