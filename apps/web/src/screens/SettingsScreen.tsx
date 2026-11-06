import type { ProfileDto, SettingsDto } from '@diet/shared';
import { Bell, BellOff, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Input } from '@/ui/input';
import { api, ApiError } from '../api';
import { Switch } from '@/ui/switch';
import { ScreenHeader } from '../components/ScreenHeader';
import { Button, Card, ErrorNote, SectionTitle, MultiToggle } from '../components/ui';
import { currentSubscription, disablePush, enablePush, pushSupport } from '../push';
import { useHealth } from '../useHealth';
import { useQuery } from '../useQuery';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function SettingsScreen() {
  const settings = useQuery<SettingsDto>('/settings');

  return (
    <>
      <ScreenHeader title="Settings" />
      <div className="space-y-6">
        {settings.status === 'error' && <ErrorNote>{settings.error.message}</ErrorNote>}
        {settings.data && (
          <>
            <Notifications settings={settings.data} reload={settings.reload} />
            <Reminders profile={settings.data.profile} />
            <Shortcuts configured={settings.data.ingest.configured} />
          </>
        )}
        <Server />
      </div>
    </>
  );
}

function Notifications({
  settings,
  reload,
}: {
  settings: SettingsDto;
  reload: () => Promise<void>;
}) {
  const support = pushSupport();
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void currentSubscription().then((s) => {
      if (!cancelled) setSubscribed(s !== null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ text: success, error: false });
      await reload();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  const publicKey = settings.push.publicKey;
  let body;
  if (!publicKey) {
    body = (
      <p className="text-sm text-muted-foreground">
        Push isn't configured on the server (VAPID keys in .env).
      </p>
    );
  } else if (support === 'needs_install') {
    body = (
      <p className="text-sm text-muted-foreground">
        On iPhone, notifications only work from the installed app: Share → Add to Home Screen, then
        open it from there.
      </p>
    );
  } else if (support === 'unsupported') {
    body = (
      <p className="text-sm text-muted-foreground">
        This browser doesn't support push notifications.
      </p>
    );
  } else if (subscribed) {
    body = (
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const r = await api.post<{ sent: number }>('/push/test');
              if (r.sent === 0)
                throw new Error('No device received it. Try turning notifications off and on.');
            }, 'Sent. It should arrive in a few seconds.')
          }
        >
          <Bell size={16} aria-hidden /> Send a test
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await disablePush();
              setSubscribed(false);
            }, 'Notifications are off on this device.')
          }
        >
          <BellOff size={16} aria-hidden /> Turn off here
        </Button>
      </div>
    );
  } else {
    body = (
      <Button
        disabled={busy || subscribed === null}
        onClick={() =>
          void run(async () => {
            await enablePush(publicKey);
            setSubscribed(true);
          }, 'Notifications are on for this device.')
        }
      >
        <Bell size={16} aria-hidden /> Turn on notifications
      </Button>
    );
  }

  return (
    <section aria-labelledby="notifications-heading">
      <SectionTitle id="notifications-heading">Notifications</SectionTitle>
      <Card className="space-y-3">
        {body}
        {message &&
          (message.error ? (
            <ErrorNote>{message.text}</ErrorNote>
          ) : (
            <p className="text-sm text-primary">{message.text}</p>
          ))}
        <p className="text-xs text-muted-foreground">
          {settings.push.subscriptions === 0
            ? 'No device receives reminders yet.'
            : `${settings.push.subscriptions} device${settings.push.subscriptions === 1 ? '' : 's'} receive${
                settings.push.subscriptions === 1 ? 's' : ''
              } reminders.`}
        </p>
      </Card>
    </section>
  );
}

function Reminders({ profile }: { profile: ProfileDto }) {
  const [state, setState] = useState(profile);
  const [error, setError] = useState<string | null>(null);

  // Changes are saved one at a time, in order, so the server ends with the last choice; only
  // the newest response may update the screen. `desired` reflects taps not yet saved.
  const desired = useRef(profile);
  const confirmed = useRef(profile);
  const queue = useRef(Promise.resolve());
  const latest = useRef(0);

  function update(patch: Partial<ProfileDto>) {
    desired.current = { ...desired.current, ...patch };
    setState(desired.current);
    setError(null);
    const seq = ++latest.current;
    queue.current = queue.current.then(async () => {
      try {
        confirmed.current = await api.patch<ProfileDto>('/profile', patch);
        if (seq === latest.current) {
          desired.current = confirmed.current;
          setState(confirmed.current);
        }
      } catch (err) {
        if (seq === latest.current) {
          desired.current = confirmed.current;
          setState(confirmed.current);
        }
        setError(err instanceof ApiError ? err.message : String(err));
      }
    });
  }

  const toggleDay = (day: number) => {
    const days = desired.current.weighInDays;
    update({
      weighInDays: days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort(),
    });
  };

  return (
    <section aria-labelledby="reminders-heading">
      <SectionTitle id="reminders-heading">Reminders</SectionTitle>
      <Card className="space-y-4">
        <label className="flex items-center justify-between">
          <span className="text-sm">Send reminders</span>
          <Switch
            checked={state.remindersEnabled}
            onCheckedChange={(on) => update({ remindersEnabled: on })}
            aria-label="Send reminders"
          />
        </label>
        <div>
          <p className="mb-2 text-sm">Weigh-in days</p>
          <MultiToggle
            label="Weigh-in days"
            fill
            options={WEEKDAYS.map((label, i) => ({ value: i + 1, label }))}
            value={state.weighInDays}
            onToggle={toggleDay}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Two a week is the minimum for a trend you can act on within about six weeks.
          </p>
        </div>
        <TimeRow
          label="Weigh-in reminder at"
          value={state.weighInTime}
          onChange={(v) => update({ weighInTime: v })}
        />
        <TimeRow
          label="Monday check-in reminder at"
          value={state.checkinReminderTime}
          onChange={(v) => update({ checkinReminderTime: v })}
        />
        <p className="text-xs text-muted-foreground">Times are in {state.timezone}.</p>
        {error && <ErrorNote>{error}</ErrorNote>}
      </Card>
    </section>
  );
}

function TimeRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <Input
        type="time"
        value={value}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        className="h-11 w-auto"
      />
    </label>
  );
}

function Shortcuts({ configured }: { configured: boolean }) {
  const origin = window.location.origin;
  const endpoints = [
    { label: 'Log weight', url: `${origin}/api/ingest/weight` },
    { label: 'Send Tanita CSV', url: `${origin}/api/ingest/tanita` },
  ];
  const [copied, setCopied] = useState<string | null>(null);

  return (
    <section aria-labelledby="shortcuts-heading">
      <SectionTitle id="shortcuts-heading">iOS Shortcuts</SectionTitle>
      <Card className="space-y-3">
        {!configured && (
          <p className="text-sm text-warn">
            The Shortcut endpoints are off: set INGEST_TOKEN in the server's .env.
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          Each Shortcut POSTs to one of these addresses with the header{' '}
          <code className="rounded bg-surface-2 px-1">
            Authorization: Bearer &lt;INGEST_TOKEN&gt;
          </code>
          . Setup steps are in <code className="rounded bg-surface-2 px-1">docs/shortcuts.md</code>.
        </p>
        <ul className="space-y-2">
          {endpoints.map((e) => (
            <li
              key={e.url}
              className="flex items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium">{e.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{e.url}</span>
              </span>
              <button
                type="button"
                aria-label={`Copy ${e.label} address`}
                onClick={() =>
                  void navigator.clipboard.writeText(e.url).then(() => {
                    setCopied(e.url);
                    setTimeout(() => setCopied(null), 1500);
                  })
                }
                className="rounded-full p-2 text-muted-foreground hover:bg-border"
              >
                {copied === e.url ? (
                  <span className="text-xs text-primary">Copied</span>
                ) : (
                  <Copy size={16} aria-hidden />
                )}
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' }) {
  const color = tone === 'ok' ? 'text-primary' : tone === 'bad' ? 'text-danger' : 'text-text';
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={`text-sm font-medium ${color}`}>{value}</dd>
    </div>
  );
}

function Server() {
  const health = useHealth();
  return (
    <section aria-labelledby="server-heading">
      <SectionTitle id="server-heading">Server</SectionTitle>
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
      {health.kind === 'error' && (
        <p className="mt-2 text-sm text-muted-foreground">{health.message}</p>
      )}
    </section>
  );
}
