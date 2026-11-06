import { useEffect, useState } from 'react';

import { api, type ApiResult, type DependencyStatus, type ReadinessReport } from '../api/client';

const POLL_MS = 10_000;

function Pill({ label, dep, unknown }: { label: string; dep?: DependencyStatus; unknown?: boolean }) {
  const up = dep?.status === 'up';
  const tone = unknown ? 'neutral' : up ? 'ok' : 'bad';
  const text = unknown ? 'desconhecido' : up ? `ok · ${dep?.latencyMs ?? 0} ms` : 'fora do ar';

  return (
    <span className={`pill ${tone}`} title={dep?.error ?? ''}>
      <span className="dot" />
      {label}: {text}
    </span>
  );
}

export function StatusBar() {
  const [result, setResult] = useState<ApiResult<ReadinessReport> | null>(null);

  useEffect(() => {
    let active = true;

    const check = async () => {
      const next = await api.ready();

      if (active) {
        setResult(next);
      }
    };

    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const report = result?.data?.checks ? result.data : null;
  const unreachable = result !== null && report === null;

  return (
    <div className="status-bar" aria-live="polite">
      <span className={`pill ${result === null ? 'neutral' : unreachable ? 'bad' : 'ok'}`}>
        <span className="dot" />
        API: {result === null ? 'verificando' : unreachable ? 'inacessível' : 'no ar'}
      </span>
      <Pill label="Banco" dep={report?.checks.database} unknown={!report} />
      <Pill label="SQS" dep={report?.checks.sqs} unknown={!report} />
      {unreachable && result?.error ? <span className="muted small">{result.error.message}</span> : null}
    </div>
  );
}
