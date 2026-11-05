/**
 * Runs real plan generations against the fixture and reports how often they pass the
 * validator, how often they needed a repair, and what they cost. Spends real money: about
 * $0.25–0.60 per run with Opus at high effort.
 *
 *   ANTHROPIC_API_KEY=... pnpm --filter @diet/api eval:plan -- --runs 3 [--model claude-opus-5-5] [--effort high]
 */
import { costOf, createClaudeModel } from '../src/ai/model.js';
import { makeContext, runPipeline, type RunLog } from '../src/services/generate.js';
import { fixture } from './fixture.js';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const runs = Math.max(1, Number(arg('runs', '1')));
const model = arg('model', 'claude-opus-5-5');
const effort = arg('effort', 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY to run the eval.');
  process.exit(1);
}

const planModel = createClaudeModel({ apiKey, model, effort });
console.log(`eval:plan · ${runs} run(s) · ${model} · effort ${effort}\n`);

const rows: {
  ok: boolean;
  repaired: boolean;
  errors: number;
  solver: number;
  cost: number;
  seconds: number;
}[] = [];
for (let i = 1; i <= runs; i++) {
  const started = Date.now();
  const log: RunLog = { served: [], attempts: [] };
  const outcome = await runPipeline(planModel, makeContext(fixture()), log).catch(
    (err: unknown) => ({
      ok: false,
      doc: null,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  const row = {
    ok: outcome.ok,
    repaired: outcome.result?.repaired ?? false,
    errors: outcome.result?.errors.length ?? 0,
    solver: outcome.result?.solverChanges.length ?? 0,
    cost: costOf(log.served).usd,
    seconds: (Date.now() - started) / 1000,
  };
  rows.push(row);
  console.log(
    `run ${i}: ${row.ok ? 'PASS' : 'FAIL'}${row.repaired ? ' (after repair)' : ''} · ${row.solver} solver change(s) · $${row.cost.toFixed(3)} · ${row.seconds.toFixed(0)} s`,
  );
  if (!row.ok) {
    for (const e of (outcome.result?.errors ?? [outcome.error ?? 'unknown error']).slice(0, 8))
      console.log(`   - ${e}`);
  }
}

const pct = (k: number) => `${Math.round((k / rows.length) * 100)}%`;
const mean = (f: (r: (typeof rows)[number]) => number) =>
  rows.reduce((s, r) => s + f(r), 0) / rows.length;
console.log(
  `\npass rate ${pct(rows.filter((r) => r.ok).length)} · repair rate ${pct(rows.filter((r) => r.repaired).length)} · ` +
    `mean cost $${mean((r) => r.cost).toFixed(3)} · mean time ${mean((r) => r.seconds).toFixed(0)} s`,
);
