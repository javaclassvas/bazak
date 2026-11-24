import type { Product } from '../src/lib/catalog/types';

/**
 * A golden case: what the user says and what a correct answer must look like.
 *
 * `oracle` defines the set of acceptable products as a predicate over the pinned catalog. The checks are
 * then set relations, not opinions: everything shown must be in the oracle set (precision), and enough of
 * the oracle set must be shown (a guard against "show one safe item and pass").
 */
export type GoldenCase = {
  id: string;
  kind: 'direct' | 'budget' | 'ranking' | 'off-catalog' | 'ambiguous' | 'multi-intent' | 'multi-turn' | 'smalltalk';
  /** Earlier user turns, run first to build real history. */
  setup?: string[];
  query: string;
  expect: {
    oracle?: (p: Product) => boolean;
    /** At least this many cards, capped by the oracle size. Default 3 when an oracle is given. */
    minShown?: number;
    /** No cards at all (off-catalog, small talk, nothing fits the budget). */
    noCards?: boolean;
    noToolCalls?: boolean;
    minGroups?: number;
    /** Each listed category must appear among the shown products. */
    coversCategories?: string[];
    /** These product ids must be among the shown ones. */
    mustInclude?: (catalog: Product[]) => number[];
    asksQuestion?: boolean;
  };
};

const inCategory = (...categories: string[]) => (p: Product) => categories.includes(p.category);

export const GOLDEN: GoldenCase[] = [
  {
    id: 'direct-category',
    kind: 'direct',
    query: 'Show me laptops',
    expect: { oracle: inCategory('laptops') },
  },
  {
    id: 'direct-keyword',
    kind: 'direct',
    query: 'I need a red lipstick',
    expect: {
      oracle: inCategory('beauty'),
      minShown: 1,
      mustInclude: (catalog) => catalog.filter((p) => p.title === 'Red Lipstick').map((p) => p.id),
    },
  },
  {
    id: 'budget-hit',
    kind: 'budget',
    query: 'phones under $300',
    expect: { oracle: (p) => p.category === 'smartphones' && p.price <= 300 },
  },
  {
    id: 'budget-miss',
    kind: 'budget',
    query: 'laptops under $1000',
    // Every laptop in the catalog costs more. The right answer is to say so, not to show a near miss as a match.
    expect: { noCards: true },
  },
  {
    id: 'ranking-cheapest',
    kind: 'ranking',
    query: "What's the cheapest fragrance you have?",
    expect: {
      oracle: inCategory('fragrances'),
      minShown: 1,
      mustInclude: (catalog) => {
        const fragrances = catalog.filter((p) => p.category === 'fragrances').sort((a, b) => a.price - b.price);
        return fragrances.slice(0, 1).map((p) => p.id);
      },
    },
  },
  {
    id: 'off-catalog',
    kind: 'off-catalog',
    query: 'Book me a flight to Tokyo',
    expect: { noCards: true, noToolCalls: true },
  },
  {
    id: 'ambiguous',
    kind: 'ambiguous',
    query: 'something cheap and cool',
    expect: { oracle: (p) => p.price <= 100, minShown: 3, minGroups: 2, asksQuestion: true },
  },
  {
    id: 'multi-intent',
    kind: 'multi-intent',
    query: 'a dress and matching shoes',
    expect: {
      oracle: inCategory('womens-dresses', 'womens-shoes'),
      minGroups: 2,
      coversCategories: ['womens-dresses', 'womens-shoes'],
    },
  },
  {
    id: 'multi-turn-refine',
    kind: 'multi-turn',
    setup: ['smartphones under $500'],
    query: 'cheaper ones',
    // "Cheaper" than a $500 budget: still phones, and strictly below the earlier ceiling.
    expect: { oracle: (p) => p.category === 'smartphones' && p.price < 500 },
  },
  {
    id: 'smalltalk',
    kind: 'smalltalk',
    query: 'hi there!',
    expect: { noCards: true, noToolCalls: true, asksQuestion: true },
  },
];
