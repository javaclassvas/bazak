import type { ProductCard } from '../src/lib/agent/tools';
import type { Product } from '../src/lib/catalog/types';
import type { GoldenCase } from './golden';
import type { Turn } from './harness';

/** `warn` checks are reported but do not fail a case: a guard fired and the user-visible result was still right. */
export type CheckResult = { name: string; pass: boolean; detail?: string; warn?: boolean };

const MONEY = /[$€£]\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:usd|dollars?|bucks)\b/gi;

/** Every money amount written in a text, as numbers. */
export function moneyAmounts(text: string): number[] {
  return [...text.matchAll(MONEY)].map((m) => Number((m[1] ?? m[2]).replace(/,/g, '')));
}

/**
 * Invariants that hold for every turn, whatever the query: the things a grounding regression would break.
 */
export function invariantChecks(turn: Turn, catalog: Product[], userTexts: string[]): CheckResult[] {
  const shown: ProductCard[] = turn.groups.flatMap((g) => g.products);
  const byId = new Map(catalog.map((p) => [p.id, p]));

  // 1. Cards match the catalog field for field. Guards the server-side hydration.
  const mismatched = shown.filter((card) => {
    const p = byId.get(card.id);
    return !p || p.title !== card.title || p.price !== card.price || (p.thumbnail ?? null) !== card.thumbnail;
  });

  // 2. The model never asked to show an id it had not retrieved.
  const dropped = turn.groups.flatMap((g) => g.dropped);

  // 3. Any money amount in the prose is either a shown product's price or a number the user said first.
  const allowed = new Set([...shown.map((c) => c.price), ...userTexts.flatMap(moneyAmounts), ...userTexts.flatMap(plainNumbers)]);
  const strayAmounts = moneyAmounts(turn.text).filter((n) => !allowed.has(n));

  return [
    { name: 'cards match catalog', pass: mismatched.length === 0, detail: mismatched.map((c) => `#${c.id}`).join(' ') },
    // The allowlist already refused these, so the user saw nothing wrong; we track how often it has to.
    { name: 'no dropped ids', pass: dropped.length === 0, detail: dropped.join(' '), warn: true },
    { name: 'no ungrounded prices in text', pass: strayAmounts.length === 0, detail: strayAmounts.join(' ') },
    { name: 'has text', pass: turn.text.trim().length > 0 },
  ];
}

const plainNumbers = (text: string) => [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, '')));

/** Checks specific to one golden case. */
export function caseChecks(c: GoldenCase, turn: Turn, catalog: Product[]): CheckResult[] {
  const shown = turn.groups.flatMap((g) => g.products);
  const shownIds = new Set(shown.map((p) => p.id));
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const out: CheckResult[] = [];
  const e = c.expect;

  if (e.noCards) out.push({ name: 'shows no cards', pass: shown.length === 0, detail: `${shown.length} shown` });
  if (e.noToolCalls) {
    const calls = turn.searches.length + turn.groups.length;
    out.push({ name: 'makes no tool calls', pass: calls === 0, detail: `${calls} calls` });
  }

  if (e.oracle) {
    const oracle = catalog.filter(e.oracle);
    const outside = shown.filter((card) => !e.oracle!(byId.get(card.id)!));
    out.push({
      name: 'shown ⊆ oracle',
      pass: outside.length === 0,
      detail: outside.map((c) => `#${c.id} ${c.title} $${c.price} [${c.category}]`).join('; '),
    });
    const need = Math.min(e.minShown ?? 3, oracle.length);
    out.push({ name: `shows ≥ ${need}`, pass: shown.length >= need, detail: `${shown.length} shown, oracle has ${oracle.length}` });
  }

  if (e.mustInclude) {
    const missing = e.mustInclude(catalog).filter((id) => !shownIds.has(id));
    out.push({ name: 'includes required products', pass: missing.length === 0, detail: missing.map((id) => `#${id} ${byId.get(id)?.title}`).join('; ') });
  }
  if (e.minGroups) out.push({ name: `≥ ${e.minGroups} groups`, pass: turn.groups.length >= e.minGroups, detail: `${turn.groups.length} groups` });
  if (e.coversCategories) {
    const present = new Set(shown.map((p) => p.category));
    const missing = e.coversCategories.filter((cat) => !present.has(cat));
    out.push({ name: 'covers every intent', pass: missing.length === 0, detail: missing.join(' ') });
  }
  if (e.asksQuestion) out.push({ name: 'asks a question', pass: /[?？]/.test(turn.text) });
  if (e.minCards) out.push({ name: `shows ≥ ${e.minCards} cards`, pass: shown.length >= e.minCards, detail: `${shown.length} shown` });
  if (e.exactShown != null) out.push({ name: `shows exactly ${e.exactShown}`, pass: shown.length === e.exactShown, detail: `${shown.length} shown` });
  if (e.textMatches) out.push({ name: `text matches ${e.textMatches}`, pass: e.textMatches.test(turn.text) });
  if (e.noPricesInText) {
    const amounts = moneyAmounts(turn.text);
    out.push({ name: 'no prices in text', pass: amounts.length === 0, detail: amounts.join(' ') });
  }
  if (e.namesNoProducts) {
    const named = catalog.filter((p) => p.title.length > 6 && turn.text.toLowerCase().includes(p.title.toLowerCase()));
    out.push({ name: 'names no catalog product', pass: named.length === 0, detail: named.map((p) => p.title).join('; ') });
  }

  return out;
}
