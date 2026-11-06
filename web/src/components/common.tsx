import type { ReactNode } from 'react';

import type { ApiError, ApiResult, SubmitResult, TransactionStatus } from '../api/client';
import { formatMoney } from '../lib/format';

export function Card({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="card">
      <header className="card-header">
        <h2>{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

const statusTone: Record<string, string> = {
  PROCESSED: 'ok',
  REJECTED: 'bad',
  PENDING_REFERENCE: 'warn',
  PENDING: 'warn',
  FAILED: 'bad',
};

export function StatusBadge({ status }: { status: TransactionStatus | string }) {
  return <span className={`badge ${statusTone[status] ?? 'neutral'}`}>{status}</span>;
}

export function HttpBadge({ status }: { status: number }) {
  const tone =
    status === 0
      ? 'bad'
      : status < 300
        ? 'ok'
        : status === 202
          ? 'warn'
          : 'bad';

  return <span className={`badge ${tone}`}>{status === 0 ? 'sem resposta' : `HTTP ${status}`}</span>;
}

export function ErrorBox({ error, status }: { error: ApiError; status?: number }) {
  return (
    <div className="error-box" role="alert">
      <strong>
        {status !== undefined && status > 0 ? `HTTP ${status} · ` : ''}
        {error.code}
      </strong>
      <p>{error.message}</p>
      {error.details !== undefined ? <JsonBlock value={error.details} /> : null}
    </div>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

/** Shows a POST /wagering/transactions answer: HTTP code, status, failureCode, balance, replay. */
export function SubmitResultView({ result }: { result: ApiResult<SubmitResult> }) {
  const data = result.data;

  return (
    <div className="result">
      <div className="result-head">
        <HttpBadge status={result.status} />
        {data ? <StatusBadge status={data.status} /> : null}
        {data?.idempotentReplay ? <span className="badge info">idempotentReplay</span> : null}
      </div>
      {data ? (
        <dl className="kv">
          <dt>transactionId</dt>
          <dd className="mono">{data.transactionId}</dd>
          <dt>failureCode</dt>
          <dd>{data.failureCode ?? 'nenhum'}</dd>
          <dt>Saldo resultante</dt>
          <dd>
            {formatMoney(data.balance)} <span className="mono muted">({data.balance.amount})</span>
          </dd>
          <dt>idempotentReplay</dt>
          <dd>{String(data.idempotentReplay)}</dd>
        </dl>
      ) : null}
      {result.error ? <ErrorBox error={result.error} status={result.status} /> : null}
      {result.retryAfter ? (
        <p className="muted">Retry-After: {result.retryAfter}s (reenvie com a mesma chave).</p>
      ) : null}
    </div>
  );
}
