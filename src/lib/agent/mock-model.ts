import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { simulateReadableStream, type LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { CATEGORIES } from '../catalog/types';

/** What a scripted model does in one step: call tools, say something, or fail. */
export type ScriptedStep =
  | { toolCalls: { toolName: string; input: unknown }[] }
  | { text: string }
  | { error: Error };

/** A simplified view of the prompt the model received for this step. */
export type ScriptContext = {
  /** 0-based index of the model call within the model's lifetime. */
  call: number;
  lastUserText: string;
  /** Tool results that arrived since the last user message, oldest first. */
  toolResults: { toolName: string; output: unknown }[];
};

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

type PromptMessage = { role: string; content: unknown };

function readContext(prompt: PromptMessage[], call: number): ScriptContext {
  const lastUser = prompt.findLastIndex((m) => m.role === 'user');
  const userParts = (prompt[lastUser]?.content ?? []) as { type: string; text?: string }[];
  const toolResults = prompt
    .slice(lastUser + 1)
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content as { type: string; toolName: string; output: { value?: unknown } }[])
    .filter((p) => p.type === 'tool-result')
    .map((p) => ({ toolName: p.toolName, output: p.output?.value }));
  return { call, lastUserText: userParts.map((p) => p.text ?? '').join(''), toolResults };
}

/**
 * A language model driven by a function instead of a network call.
 * Tests script it to misbehave; the e2e suite uses the rule-based script below.
 */
export function createScriptedModel(
  script: (ctx: ScriptContext) => ScriptedStep,
  options: { chunkDelayMs?: number } = {},
): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const index = call++;
      const step = script(readContext(prompt as PromptMessage[], index));
      if ('error' in step) throw step.error;

      const chunks: LanguageModelV4StreamPart[] =
        'toolCalls' in step
          ? [
              ...step.toolCalls.map((c, i) => ({
                type: 'tool-call' as const,
                toolCallId: `call-${index}-${i}`,
                toolName: c.toolName,
                input: JSON.stringify(c.input),
              })),
              { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
            ]
          : [
              { type: 'text-start' as const, id: `text-${index}` },
              // Word by word, so streaming is observable.
              ...step.text.split(/(?<=\s)/).map((delta) => ({ type: 'text-delta' as const, id: `text-${index}`, delta })),
              { type: 'text-end' as const, id: `text-${index}` },
              { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
            ];

      return {
        stream: simulateReadableStream({ chunks, chunkDelayInMs: options.chunkDelayMs ?? null, initialDelayInMs: null }),
      };
    },
  });
}

/**
 * The stand-in model for `MOCK_LLM=1`: deterministic, needs no API key.
 * It follows the real protocol — search, show the first hits, then one sentence — so the whole
 * UI and persistence path can be exercised without a model. It is not a model of model quality.
 */
export function createDemoModel(): LanguageModel {
  return createScriptedModel(
    ({ lastUserText, toolResults }) => {
      const text = lastUserText.toLowerCase();
      const last = toolResults.at(-1);

      if (!last) {
        const category = CATEGORIES.find((c) => text.includes(c.replace(/s$/, '').replace(/-/g, ' ')));
        if (!category) return { text: 'Hi! Tell me what you are looking for, for example “laptops” or “smartphones”.' };
        return { toolCalls: [{ toolName: 'search_products', input: { category } }] };
      }

      if (last.toolName === 'search_products') {
        const output = last.output as { ok?: boolean; products?: { id: number }[] };
        if (!output.ok) return { text: 'The catalog cannot be reached right now, so I have nothing to show.' };
        const ids = (output.products ?? []).slice(0, 3).map((p) => p.id);
        if (ids.length === 0) return { text: 'I could not find anything like that in the catalog.' };
        return { toolCalls: [{ toolName: 'show_products', input: { title: 'Top picks', items: ids.map((id) => ({ id })) } }] };
      }

      return { text: 'Here are a few options from the catalog. Want me to narrow them down?' };
    },
    { chunkDelayMs: 15 },
  );
}
