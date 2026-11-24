import { openai } from '@ai-sdk/openai';
import { experimental_decide } from 'ai';
import type { ProductCard } from '../src/lib/agent/tools';

/**
 * Relevance judge on the OpenAI Decisions API.
 *
 * One Boolean question per shown product; the answer is P(relevant), not a verdict, so the threshold
 * is ours to choose and to calibrate against human labels (`npm run eval:calibrate`).
 *
 * Why this API and not a prompt asking for "yes/no": it returns a probability per question, takes many
 * questions in one request, and has no free-text output to parse.
 */
export const RELEVANCE_THRESHOLD = 0.5;

const model = () => openai.decisionModel(process.env.OPENAI_MODEL ?? 'gpt-6-luna');

export type JudgedProduct = Pick<ProductCard, 'id' | 'title' | 'description' | 'category' | 'price'> & { brand?: string | null };

/** First version. Kept for the calibration comparison; see DECISIONS.md F15. */
export const RELEVANCE_INSTRUCTIONS_V1 =
  'A shopper sent the request(s) in `request` to a shopping assistant, and the assistant showed this product. ' +
  'Is this product a relevant result for that request? Judge whether it is the kind of product asked for and whether it ' +
  'meets constraints the shopper stated (budget, colour, brand, category). Do not judge quality or whether better products exist. ' +
  'For a vague request (a gift, "something cool") a plausible suggestion counts as relevant.';

/**
 * Second version. V1 scored a single card against the whole request, so it marked down a laptop shown
 * for "a laptop, a watch and sunglasses" and a perfume shown for "exactly two fragrances".
 */
export const RELEVANCE_INSTRUCTIONS =
  'A shopper sent the request(s) in `request` to a shopping assistant. The assistant showed several product cards; `product` is ONE of them. ' +
  'Answer whether this one card belongs among the results.\n' +
  'True when: it is a kind of product the shopper asked for, AND it does not break a constraint that applies to a single product ' +
  '(price limit or range, brand, colour, category).\n' +
  'If the shopper asked for several different things, the card only has to match one of them.\n' +
  'Ignore constraints about the set as a whole: how many results ("exactly two"), or which is best ("cheapest", "top rated"). ' +
  'Ignore product quality, and parts of the request the store cannot serve.\n' +
  'For a vague request (a gift, "something cool") a plausible suggestion is relevant.\n' +
  'Later messages in `request` refine earlier ones.';

/** P(relevant) for each product, in the order given. */
export async function judgeRelevance(userTurns: string[], products: JudgedProduct[], instructions = RELEVANCE_INSTRUCTIONS): Promise<number[]> {
  const out: number[] = [];
  // One request per product keeps each judgement independent of the other cards in the group.
  await Promise.all(
    products.map(async (p, i) => {
      const { answers } = await experimental_decide({
        model: model(),
        state: {
          request: userTurns,
          product: { title: p.title, description: p.description, category: p.category, brand: p.brand ?? null, price_usd: p.price },
        },
        questions: { relevant: { type: 'boolean', instructions } },
      });
      out[i] = answers.relevant.probability;
    }),
  );
  return out;
}
