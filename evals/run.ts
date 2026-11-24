/**
 * Live evals: the real model, the real agent code, a pinned catalog.
 *
 *   npm run eval                      all golden cases, once
 *   npm run eval -- --only ambiguous  cases whose id contains the text
 *   npm run eval -- --repeat 3        each case N times (a case passes only if every run passes)
 *   npm run eval -- --effort none     override reasoning effort
 *
 * Assertions read the stored assistant message (the same parts the UI renders), not raw model output.
 */
import { openai } from '@ai-sdk/openai';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ReasoningEffort } from '../src/lib/agent/agent';
import type { CopilotUIMessage } from '../src/lib/agent/tools';
import { createCatalogClient } from '../src/lib/catalog/client';
import { createFixtureFetch } from '../src/lib/catalog/fixture';
import type { Product } from '../src/lib/catalog/types';
import { caseChecks, invariantChecks, type CheckResult } from './checks';
import { GOLDEN } from './golden';
import { runTurn } from './harness';
import { judgeRelevance, RELEVANCE_THRESHOLD } from './judge';

process.loadEnvFile('.env.local');

const args = process.argv.slice(2);
const value = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const only = value('only');
const repeat = Number(value('repeat') ?? 1);
const effort = value('effort') as ReasoningEffort | undefined;

const modelId = process.env.OPENAI_MODEL ?? 'gpt-6-luna';
const model = openai(modelId);
const products: Product[] = JSON.parse(readFileSync('evals/fixture/catalog.json', 'utf8')).products;
const liveFixtureCatalog = createCatalogClient({ baseUrl: 'http://fixture.local', fetch: createFixtureFetch(products) });
const deadCatalog = createCatalogClient({
  baseUrl: 'http://down.local',
  retries: 0,
  fetch: async () => {
    throw new TypeError('fetch failed');
  },
});
const judge = args.includes('--judge');

type RunRecord = {
  caseId: string;
  run: number;
  pass: boolean;
  checks: CheckResult[];
  text: string;
  searches: unknown[];
  groups: { title: string | null; ids: number[] }[];
  timing: unknown;
  relevance?: number[];
  error?: string;
};

async function runCase(c: (typeof GOLDEN)[number], run: number): Promise<RunRecord> {
  const catalog = c.catalogDown ? deadCatalog : liveFixtureCatalog;
  try {
    let history: CopilotUIMessage[] = [];
    for (const earlier of c.setup ?? []) {
      const turn = await runTurn(earlier, { model, catalog, history, effort });
      history = JSON.parse(JSON.stringify(turn.messages)); // as if reloaded from the database
    }
    const turn = await runTurn(c.query, { model, catalog, history, effort });
    const checks = [
      ...caseChecks(c, turn, products),
      ...invariantChecks(turn, products, [...(c.setup ?? []), c.query]),
    ];
    let relevance: number[] | undefined;
    const shown = turn.groups.flatMap((g) => g.products);
    if (judge && shown.length > 0) {
      relevance = await judgeRelevance([...(c.setup ?? []), c.query], shown);
      const low = shown.filter((_, i) => relevance![i] < RELEVANCE_THRESHOLD);
      // Reported, not gating: the judge is the same model family as the system under test.
      checks.push({
        name: `judge: every card relevant (p ≥ ${RELEVANCE_THRESHOLD})`,
        pass: low.length === 0,
        warn: true,
        detail: low.map((p) => `#${p.id} ${p.title} p=${relevance![shown.indexOf(p)].toFixed(2)}`).join('; '),
      });
    }
    return {
      caseId: c.id,
      run,
      pass: checks.every((k) => k.pass || k.warn),
      checks,
      text: turn.text,
      searches: turn.searches,
      groups: turn.groups.map((g) => ({ title: g.title, ids: g.products.map((p) => p.id) })),
      timing: turn.timing,
      relevance,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { caseId: c.id, run, pass: false, checks: [{ name: 'runs without error', pass: false, detail: error }], text: '', searches: [], groups: [], timing: null, error };
  }
}

async function main() {
  const cases = GOLDEN.filter((c) => !only || c.id.includes(only));
  console.log(`model ${modelId}, effort ${effort ?? 'default'}, ${cases.length} cases × ${repeat}, catalog fixture (${products.length} products)\n`);

  const records: RunRecord[] = [];
  // Cases are independent; a small pool keeps the run short without hammering the API.
  const queue = cases.flatMap((c) => Array.from({ length: repeat }, (_, i) => ({ c, run: i + 1 })));
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) records.push(await runCase(job.c, job.run));
    }),
  );

  let passedCases = 0;
  for (const c of cases) {
    const runs = records.filter((r) => r.caseId === c.id).sort((a, b) => a.run - b.run);
    const passed = runs.filter((r) => r.pass).length;
    if (passed === runs.length) passedCases += 1;
    console.log(`${passed === runs.length ? 'PASS' : 'FAIL'}  ${c.id.padEnd(20)} ${passed}/${runs.length}   "${c.query}"`);
    for (const r of runs) {
      for (const k of r.checks.filter((x) => !x.pass && x.warn)) console.log(`        ! warning (run ${r.run}): ${k.name}${k.detail ? ` — ${k.detail}` : ''}`);
    }
    for (const r of runs.filter((x) => !x.pass)) {
      for (const k of r.checks.filter((x) => !x.pass && !x.warn)) console.log(`        ✗ ${k.name}${k.detail ? ` — ${k.detail}` : ''}`);
      console.log(`        searches: ${JSON.stringify(r.searches)}`);
      console.log(`        shown: ${JSON.stringify(r.groups)}`);
      console.log(`        text: ${r.text.replace(/\s+/g, ' ').slice(0, 220)}`);
    }
  }
  console.log(`\n${passedCases}/${cases.length} cases passed`);
  const ok = records.filter((r) => r.timing) as (RunRecord & { timing: { cardsMs: number | null; totalMs: number } })[];
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  console.log(`runs: ${records.filter((r) => r.pass).length}/${records.length} passed · median to cards ${median(ok.flatMap((r) => (r.timing.cardsMs == null ? [] : [r.timing.cardsMs])))} ms · median total ${median(ok.map((r) => r.timing.totalMs))} ms`);
  const probs = records.flatMap((r) => r.relevance ?? []);
  if (probs.length) {
    console.log(`judge: ${probs.length} cards, mean relevance ${(probs.reduce((a, b) => a + b, 0) / probs.length).toFixed(3)}, below ${RELEVANCE_THRESHOLD}: ${probs.filter((p) => p < RELEVANCE_THRESHOLD).length}`);
  }

  mkdirSync('evals/out', { recursive: true });
  const file = `evals/out/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify({ model: modelId, effort: effort ?? 'default', repeat, records }, null, 1));
  console.log(`details: ${file}`);
  process.exit(passedCases === cases.length ? 0 : 1);
}

main();
