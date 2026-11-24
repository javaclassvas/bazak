/**
 * How far can the relevance judge be trusted?
 *
 * `evals/calibration/pairs.json` holds request–product pairs. A person fills in `"relevant": true|false`
 * for each one WITHOUT looking at the judge's answers. This script then runs the judge on the same
 * pairs and reports agreement with those labels.
 *
 *   npm run eval:calibrate            judge the pairs; report agreement if labels are present
 *   npm run eval:calibrate -- --v1    use the first version of the judge instructions
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { judgeRelevance, RELEVANCE_INSTRUCTIONS, RELEVANCE_INSTRUCTIONS_V1, RELEVANCE_THRESHOLD, type JudgedProduct } from './judge';

process.loadEnvFile('.env.local');

type Pair = { request: string[]; product: JudgedProduct; relevant: boolean | null };
const pairs: Pair[] = JSON.parse(readFileSync('evals/calibration/pairs.json', 'utf8'));
const v1 = process.argv.includes('--v1');

async function main() {
  const probabilities = await Promise.all(
    pairs.map(async (pair) => (await judgeRelevance(pair.request, [pair.product], v1 ? RELEVANCE_INSTRUCTIONS_V1 : RELEVANCE_INSTRUCTIONS))[0]),
  );
  // Judge output goes to the ignored output folder, so the labelling file never shows it.
  mkdirSync('evals/out', { recursive: true });
  writeFileSync(`evals/out/judge-${v1 ? 'v1' : 'v2'}.json`, JSON.stringify(pairs.map((p, i) => ({ request: p.request, product: p.product.title, p: Number(probabilities[i].toFixed(3)) })), null, 1));

  const saysRelevant = probabilities.filter((p) => p >= RELEVANCE_THRESHOLD).length;
  console.log(`judge ${v1 ? 'v1' : 'v2'}: ${pairs.length} pairs, ${saysRelevant} judged relevant, ${pairs.length - saysRelevant} not`);
  const uncertain = probabilities.filter((p) => p > 0.2 && p < 0.8).length;
  console.log(`probabilities between 0.2 and 0.8 (judge unsure): ${uncertain}`);

  const labelled = pairs.map((p, i) => ({ ...p, p: probabilities[i] })).filter((p) => p.relevant !== null);
  if (labelled.length === 0) {
    console.log('\nNo human labels yet. Fill in "relevant": true|false in evals/calibration/pairs.json and run again.');
    return;
  }
  const tp = labelled.filter((x) => x.relevant && x.p >= RELEVANCE_THRESHOLD).length;
  const tn = labelled.filter((x) => !x.relevant && x.p < RELEVANCE_THRESHOLD).length;
  const fp = labelled.filter((x) => !x.relevant && x.p >= RELEVANCE_THRESHOLD);
  const fn = labelled.filter((x) => x.relevant && x.p < RELEVANCE_THRESHOLD);
  console.log(`\nlabelled ${labelled.length}/${pairs.length} · agreement ${(((tp + tn) / labelled.length) * 100).toFixed(0)}%  (TP ${tp}, TN ${tn}, FP ${fp.length}, FN ${fn.length})`);
  for (const x of fp) console.log(`  judge says relevant, human says no  p=${x.p.toFixed(2)}  ${JSON.stringify(x.request)} → ${x.product.title}`);
  for (const x of fn) console.log(`  judge says not, human says relevant p=${x.p.toFixed(2)}  ${JSON.stringify(x.request)} → ${x.product.title}`);
}

main();
