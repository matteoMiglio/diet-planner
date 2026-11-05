import { ScreenHeader } from '../components/ScreenHeader';
import { useHealth } from '../useHealth';

function Row({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' }) {
  const color = tone === 'ok' ? 'text-accent' : tone === 'bad' ? 'text-danger' : 'text-text';
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={`text-sm font-medium ${color}`}>{value}</dd>
    </div>
  );
}

export function SettingsScreen() {
  const health = useHealth();

  return (
    <>
      <ScreenHeader title="Settings" />
      <section aria-labelledby="server-heading">
        <h2
          id="server-heading"
          className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase"
        >
          Server
        </h2>
        <dl className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {health.kind === 'loading' && <Row label="Status" value="Checking…" />}
          {health.kind === 'error' && <Row label="Status" value="Unreachable" tone="bad" />}
          {health.kind === 'ok' && (
            <>
              <Row
                label="Status"
                value={health.health.status === 'ok' ? 'Connected' : 'Degraded'}
                tone={health.health.status === 'ok' ? 'ok' : 'bad'}
              />
              <Row
                label="Database"
                value={health.health.db === 'ok' ? 'OK' : 'Down'}
                tone={health.health.db === 'ok' ? 'ok' : 'bad'}
              />
              <Row label="Version" value={health.health.version} />
            </>
          )}
        </dl>
        {health.kind === 'error' && <p className="mt-2 text-sm text-muted">{health.message}</p>}
      </section>
    </>
  );
}
