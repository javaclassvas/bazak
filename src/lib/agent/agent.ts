import { convertToModelMessages, isStepCount, streamText, validateUIMessages, type LanguageModel } from 'ai';
import type { CatalogClient } from '../catalog/client';
import { INSTRUCTIONS } from './prompt';
import { collectAllowedIds, createTools, createToolState, type CopilotUIMessage } from './tools';

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

/** Chosen from the stage 1 latency table; revisited against eval results (DECISIONS.md, F2). */
export const DEFAULT_EFFORT: ReasoningEffort = 'low';

/** Search, maybe retry, show, answer — with room for a multi-intent turn. Bounds a model that loops. */
export const MAX_STEPS = 8;

export type AgentInput = {
  model: LanguageModel;
  catalog: CatalogClient;
  /** Full conversation so far, ending with the new user message. Untrusted until validated here. */
  messages: unknown[];
  effort?: ReasoningEffort;
};

/**
 * One assistant turn: validate the history, run the tool loop, return the stream.
 * No HTTP and no database in here, so the route, the CLI, tests and evals all drive the same code.
 */
export async function runAgent({ model, catalog, messages, effort = DEFAULT_EFFORT }: AgentInput) {
  const state = createToolState(collectAllowedIds(messages as { parts?: unknown[] }[]));
  const tools = createTools(catalog, state);

  const validated = (await validateUIMessages({ messages, tools })) as CopilotUIMessage[];

  const result = streamText({
    model,
    instructions: INSTRUCTIONS,
    messages: await convertToModelMessages(validated, { tools }),
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    providerOptions: {
      // No reasoning summaries: we neither show nor store them (DECISIONS.md, F3).
      openai: { reasoningEffort: effort, reasoningSummary: null },
    },
  });

  return { result, tools, messages: validated };
}
