/**
 * Headless trace CLI: one query through the real agent, printed step by step. No UI, no database.
 *
 *   npm run trace -- "laptops under 1000"
 *   npm run trace -- "laptops under 1000" --effort none|low|medium|high
 *   npm run trace -- "laptops under 1000" --compare          same query at none / low / medium
 *   npm run trace -- "phones" --followup "cheaper ones"      second turn replays the stored history
 *   npm run trace -- "phones" --fixture                      pinned catalog instead of the live API
 */
import { openai } from '@ai-sdk/openai';
import { readFileSync } from 'node:fs';
import { runTurn, type Turn } from '../evals/harness';
import type { ReasoningEffort } from '../src/lib/agent/agent';
import type { CopilotUIMessage } from '../src/lib/agent/tools';
import { createCatalogClient } from '../src/lib/catalog/client';
import { createFixtureFetch } from '../src/lib/catalog/fixture';

process.loadEnvFile('.env.local');

const EFFORTS: ReasoningEffort[] = ['none', 'low', 'medium', 'high'];
const model = openai(process.env.OPENAI_MODEL ?? 'gpt-6-luna');

function printTurn(turn: Turn) {
  for (const group of turn.groups) {
    console.log(`\n  ▸ ${group.title ?? '(untitled)'}`);
    for (const p of group.products) {
      console.log(`    #${p.id} ${p.title} — $${p.price} [${p.category}]${p.reason ? ` · ${p.reason}` : ''}`);
    }
  }
  console.log(`\n${turn.text}\n`);
  console.log('timing:', JSON.stringify(turn.timing), ' usage:', JSON.stringify(turn.usage));
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const value = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
  const valued = new Set(['effort', 'followup']);
  const query = args.find((a, i) => !a.startsWith('--') && !valued.has((args[i - 1] ?? '').slice(2)));
  if (!query) {
    console.error('usage: npm run trace -- "<query>" [--effort none|low|medium|high] [--compare] [--followup "<text>"] [--fixture]');
    process.exit(1);
  }
  const effort = (value('effort') ?? 'low') as ReasoningEffort;
  if (!EFFORTS.includes(effort)) throw new Error(`unknown effort: ${effort}`);

  const catalog = flag('fixture')
    ? createCatalogClient({
        baseUrl: 'http://fixture.local',
        fetch: createFixtureFetch(JSON.parse(readFileSync('evals/fixture/catalog.json', 'utf8')).products),
      })
    : createCatalogClient();

  if (flag('compare')) {
    const rows = [];
    for (const e of ['none', 'low', 'medium'] as const) {
      const t = await runTurn(query, { model, catalog, effort: e });
      rows.push({
        effort: e,
        'first tool (ms)': t.timing.firstToolCallMs,
        'cards (ms)': t.timing.cardsMs,
        'first text (ms)': t.timing.firstTextMs,
        'total (ms)': t.timing.totalMs,
        steps: t.steps,
        searches: t.searches.length,
        groups: t.groups.length,
        shown: t.groups.reduce((n, g) => n + g.products.length, 0),
        'reasoning tok': t.usage.reasoning,
      });
    }
    console.table(rows);
    return;
  }

  const onEvent = (ms: number, line: string) => console.log(`  [${String(ms).padStart(5)} ms] ${line}`);
  console.log(`\n> ${query}   (effort: ${effort})`);
  const first = await runTurn(query, { model, catalog, effort, onEvent });
  printTurn(first);

  const followup = value('followup');
  if (followup) {
    // History survives only as JSON, exactly as it will in the database.
    const stored: CopilotUIMessage[] = JSON.parse(JSON.stringify(first.messages));
    console.log(`\n> ${followup}   (replaying ${stored.length} stored messages)`);
    printTurn(await runTurn(followup, { model, catalog, effort, history: stored, onEvent }));
  }
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
