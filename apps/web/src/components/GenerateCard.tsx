import type { AiRunDto } from '@diet/shared';
import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Textarea } from '@/ui/textarea';
import { api, ApiError } from '../api';
import { useQuery } from '../useQuery';
import { Button, Card, ErrorNote, SectionTitle, Disclosure } from './ui';

const POLL_MS = 3000;

/**
 * Starts an AI plan generation and follows it to the end. The result is always a draft:
 * nothing changes until the person opens it and activates it.
 */
export function GenerateCard() {
  const runs = useQuery<AiRunDto[]>('/ai-runs');
  const [preferences, setPreferences] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The last successful answer: a failed poll must not make a running generation look idle.
  const [known, setKnown] = useState<AiRunDto[] | null>(null);
  if (runs.data && runs.data !== known) setKnown(runs.data);
  const latest = (runs.data ?? known)?.[0];
  const active = latest && (latest.status === 'queued' || latest.status === 'running');
  const { reload } = runs;

  useEffect(() => {
    if (!active) return;
    // Keep polling while a run is active, also after a failed request.
    const timer = setTimeout(() => void reload(), POLL_MS);
    return () => clearTimeout(timer);
  }, [active, latest?.id, latest?.status, runs.data, runs.error, reload]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      await api.post('/plans/generate', { preferences: preferences.trim() || null });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <Card className="space-y-3">
      <SectionTitle>Generate a plan</SectionTitle>
      {active ? (
        <div className="flex items-center gap-3" role="status">
          <span
            className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent"
            aria-hidden
          />
          <p className="text-sm">
            Building the week and checking every day against your targets and rules. This takes a
            minute or two; you can leave this screen.
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Claude builds a week from your pool and rules; code then checks every number and fixes
            small portion misses. You get a draft to review; nothing changes until you activate it.
          </p>
          <label className="block">
            <span className="text-sm">Anything for this week? (optional)</span>
            <Textarea
              value={preferences}
              onChange={(e) => setPreferences(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="e.g. more fish, no lentils, quick lunches on Tuesday"
              className="mt-1 w-full"
            />
          </label>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button disabled={starting} onClick={() => void start()}>
            <Sparkles size={16} aria-hidden /> {starting ? 'Starting…' : 'Generate'}
          </Button>
        </>
      )}
      {runs.error && active && (
        <p className="text-xs text-muted-foreground">
          Lost contact with the server; still checking…
        </p>
      )}
      {latest && !active && <RunResult run={latest} />}
    </Card>
  );
}

function RunResult({ run }: { run: AiRunDto }) {
  const cost = `$${run.costUsd.toFixed(2)}`;
  if (run.status === 'succeeded' && run.planId) {
    return (
      <div className="space-y-2 rounded-xl bg-primary-soft p-3">
        <p className="text-sm font-semibold">New draft ready</p>
        {run.result?.summary && <p className="text-sm">{run.result.summary}</p>}
        {run.result && run.result.solverChanges.length > 0 && (
          <Disclosure
            className="text-sm"
            summaryClassName="text-muted-foreground"
            summary={<>{run.result.solverChanges.length} portion(s) adjusted to hit the targets</>}
          >
            <ul className="mt-1 list-disc pl-5 text-xs">
              {run.result.solverChanges.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </Disclosure>
        )}
        {run.result && run.result.warnings.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {run.result.warnings.length} note(s), e.g. {run.result.warnings[0]}
          </p>
        )}
        <div className="flex items-center justify-between">
          <Link to={`/plan/edit/${run.planId}`} className="text-sm font-semibold text-primary">
            Review the draft
          </Link>
          <span className="text-xs text-muted-foreground">
            {run.result?.repaired ? 'needed one repair · ' : ''}
            {cost}
          </span>
        </div>
      </div>
    );
  }
  if (run.status === 'failed') {
    return (
      <div className="space-y-1 rounded-xl bg-surface-2 p-3">
        <p className="text-sm font-semibold text-danger">
          The last generation didn't produce a valid plan
        </p>
        {run.error && <p className="text-sm">{run.error}</p>}
        {run.result && run.result.errors.length > 0 && (
          <Disclosure
            className="text-sm"
            summaryClassName="text-muted-foreground"
            summary="What still failed"
          >
            <ul className="mt-1 list-disc pl-5 text-xs">
              {run.result.errors.slice(0, 15).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Disclosure>
        )}
        <p className="text-xs text-muted-foreground">
          {cost}. Try again, or adjust the rules or pool.
        </p>
      </div>
    );
  }
  return null;
}
