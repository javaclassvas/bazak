/**
 * Mutation table: break one thing on purpose, run the suites, record which of them notice.
 *
 *   npm run mutate                 fast suite + e2e for every mutation
 *   npm run mutate -- --evals      also run the live evals where the model is involved (slow, uses the API)
 *   npm run mutate -- --only price
 *
 * Each mutation is a single text replacement in one source file. The file is restored afterwards,
 * including on failure or Ctrl-C. Refuses to start if `src/` has uncommitted changes.
 */
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

type Mutation = {
  id: string;
  what: string;
  file: string;
  find: string;
  replace: string;
  /** Whether live evals can observe this at all. Evals call the agent directly, not the HTTP route. */
  evals: boolean;
};

const MUTATIONS: Mutation[] = [
  {
    id: 'allowlist',
    what: 'show_products accepts any id (allowlist removed)',
    file: 'src/lib/agent/tools.ts',
    find: 'if (!state.allowedIds.has(item.id) || products.length >= MAX_SHOWN) {',
    replace: 'if (products.length >= MAX_SHOWN) {',
    evals: true,
  },
  {
    id: 'price-filter',
    what: 'maxPrice is ignored by refine',
    file: 'src/lib/catalog/search.ts',
    find: 'if (input.maxPrice != null) products = products.filter((p) => p.price <= input.maxPrice!);',
    replace: '',
    evals: true,
  },
  {
    id: 'category-enum',
    what: 'category is a free string instead of an enum',
    file: 'src/lib/agent/tools.ts',
    find: 'category: z.enum(CATEGORIES).optional(),',
    replace: 'category: z.string().optional() as unknown as z.ZodOptional<z.ZodEnum<{ [K in (typeof CATEGORIES)[number]]: K }>>,',
    evals: true,
  },
  {
    id: 'card-data',
    what: 'card price is rounded instead of copied from the catalog',
    file: 'src/lib/agent/tools.ts',
    find: '    price: p.price,\n    discountPercentage',
    replace: '    price: Math.round(p.price),\n    discountPercentage',
    evals: true,
  },
  {
    id: 'prompt-grounding',
    what: 'instructions no longer forbid prices in text or products that were not shown',
    file: 'src/lib/agent/prompt.ts',
    find: '- Never state prices, discounts, ratings or stock in your text. Never mention a product you did not show.\n',
    replace: '- Mention the price of each product you recommend in your text.\n',
    evals: true,
  },
  {
    id: 'prompt-off-catalog',
    what: 'instructions no longer say what to do with off-catalog requests',
    file: 'src/lib/agent/prompt.ts',
    find: '- Request outside the catalog (flights, services, categories not listed above): say plainly that this store does not carry it. Do not call tools and do not show substitutes unless a listed category is genuinely close; in that case offer it in one sentence and ask.\n',
    replace: '- Always show some products, whatever the request.\n',
    evals: true,
  },
  {
    id: 'buffered-stream',
    what: 'the reply is buffered and sent in one piece (no streaming)',
    file: 'src/lib/agent/chat-stream.ts',
    find: 'return createUIMessageStreamResponse({ stream: forBrowser });',
    replace:
      'const streamed = createUIMessageStreamResponse({ stream: forBrowser });\n    return new Response(await streamed.text(), { headers: streamed.headers });',
    evals: false,
  },
  {
    id: 'no-drain',
    what: 'the server stops reading when the browser disconnects',
    file: 'src/lib/agent/chat-stream.ts',
    find: 'while (!(await reader.read()).done);',
    replace: 'await reader.cancel();',
    evals: false,
  },
  {
    id: 'sync-check',
    what: 'lastMessageId is not checked against the database',
    file: 'src/lib/agent/chat-stream.ts',
    find: 'if ((history.at(-1)?.id ?? null) !== lastMessageId) {',
    replace: 'if (false as boolean) {',
    evals: false,
  },
  {
    id: 'client-history',
    what: 'the server accepts assistant messages from the browser',
    file: 'src/lib/agent/chat-stream.ts',
    find: "role: z.literal('user'),",
    replace: "role: z.enum(['user', 'assistant']),",
    evals: false,
  },
];

const args = process.argv.slice(2);
const withEvals = args.includes('--evals');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;

type Outcome = 'caught' | 'missed' | 'n/a';

function run(command: string, cmdArgs: string[], env: Record<string, string> = {}): { failed: boolean; output: string } {
  const result = spawnSync(command, cmdArgs, { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024 });
  return { failed: result.status !== 0, output: `${result.stdout}\n${result.stderr}` };
}

/** Names of the failing tests, so the table says what caught it and not only that something did. */
function failures(output: string): string[] {
  const vitest = [...output.matchAll(/^\s*(?:×|✗)\s+(.+?)\s+\d+ms$/gm)].map((m) => m[1]);
  const playwright = [...output.matchAll(/^\s+\d+\) \[chromium\] › [^›]+› (.+?)\s*$/gm)].map((m) => m[1]);
  const evals = [...output.matchAll(/^FAIL\s+(\S+)/gm)].map((m) => `eval:${m[1]}`);
  return [...new Set([...vitest, ...playwright, ...evals])];
}

function main() {
  if (execSync('git status --porcelain src', { encoding: 'utf8' }).trim()) {
    console.error('src/ has uncommitted changes. Commit or stash them first: this script rewrites source files.');
    process.exit(1);
  }

  const rows: { id: string; what: string; types: Outcome; fast: Outcome; e2e: Outcome; evals: Outcome; by: string[] }[] = [];
  const mutations = MUTATIONS.filter((m) => !only || m.id.includes(only));

  for (const m of mutations) {
    const original = readFileSync(m.file, 'utf8');
    if (!original.includes(m.find)) {
      console.error(`[${m.id}] target text not found in ${m.file}. The source changed; update the mutation.`);
      process.exit(1);
    }
    const restore = () => writeFileSync(m.file, original);
    process.once('SIGINT', () => {
      restore();
      process.exit(130);
    });

    console.log(`\n▶ ${m.id}: ${m.what}`);
    const by: string[] = [];
    const record = (label: string, r: { failed: boolean; output: string }): Outcome => {
      if (r.failed) by.push(...(failures(r.output).length ? failures(r.output) : [label]));
      console.log(`  ${label.padEnd(6)} ${r.failed ? 'CAUGHT' : 'missed'}`);
      return r.failed ? 'caught' : 'missed';
    };

    try {
      writeFileSync(m.file, original.replace(m.find, m.replace));
      const types = record('types', run('npx', ['tsc', '--noEmit']));
      const fast = record('fast', run('npx', ['vitest', 'run']));
      const e2e = record('e2e', run('npx', ['playwright', 'test']));
      const evals: Outcome = withEvals && m.evals ? record('evals', run('npx', ['tsx', 'evals/run.ts'])) : 'n/a';
      rows.push({ id: m.id, what: m.what, types, fast, e2e, evals, by });
    } finally {
      restore();
    }
  }

  const cell = (o: Outcome) => (o === 'caught' ? '**caught**' : o === 'missed' ? 'missed' : '—');
  const table = [
    '| Mutation | Types | Fast suite | E2E | Live evals | Failing tests |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.what} | ${cell(r.types)} | ${cell(r.fast)} | ${cell(r.e2e)} | ${cell(r.evals)} | ${r.by.slice(0, 4).join('; ') || '—'}${r.by.length > 4 ? ` (+${r.by.length - 4})` : ''} |`),
  ].join('\n');
  console.log(`\n${table}\n`);
  writeFileSync('evals/out/mutations.md', `${table}\n`);
  const survived = rows.filter((r) => [r.types, r.fast, r.e2e, r.evals].every((o) => o !== 'caught'));
  console.log(survived.length ? `Not caught by anything: ${survived.map((r) => r.id).join(', ')}` : 'Every mutation was caught by at least one suite.');
}

main();
