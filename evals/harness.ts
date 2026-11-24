import { toUIMessageStream, type LanguageModel } from 'ai';
import { runAgent, type ReasoningEffort } from '../src/lib/agent/agent';
import type { CopilotUIMessage, ShowProductsOutput } from '../src/lib/agent/tools';
import type { CatalogClient } from '../src/lib/catalog/client';
import type { SearchInput } from '../src/lib/catalog/search';

/** Everything one assistant turn produced, read back from the message that would be stored and rendered. */
export type Turn = {
  messages: CopilotUIMessage[];
  text: string;
  /** One entry per `show_products` call: exactly the card groups the UI would render. */
  groups: ShowProductsOutput[];
  searches: SearchInput[];
  steps: number;
  timing: { firstToolCallMs: number | null; cardsMs: number | null; firstTextMs: number | null; totalMs: number };
  usage: { input?: number; output?: number; reasoning?: number };
};

export type TurnOptions = {
  model: LanguageModel;
  catalog: CatalogClient;
  history?: CopilotUIMessage[];
  effort?: ReasoningEffort;
  onEvent?: (ms: number, line: string) => void;
};

export async function runTurn(text: string, { model, catalog, history = [], effort, onEvent }: TurnOptions): Promise<Turn> {
  const userMessage = { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] };
  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);

  const { result, messages } = await runAgent({ model, catalog, messages: [...history, userMessage], effort });

  let finalMessages: CopilotUIMessage[] = [];
  const stream = toUIMessageStream({
    stream: result.stream,
    originalMessages: messages,
    onEnd: ({ messages: all }) => {
      finalMessages = all as CopilotUIMessage[];
    },
  });

  const timing: Turn['timing'] = { firstToolCallMs: null, cardsMs: null, firstTextMs: null, totalMs: 0 };
  const names = new Map<string, string>();
  let steps = 0;

  const reader = stream.getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    switch (chunk.type) {
      case 'start-step':
        steps += 1;
        onEvent?.(since(), `step ${steps}`);
        break;
      case 'tool-input-available':
        names.set(chunk.toolCallId, chunk.toolName);
        timing.firstToolCallMs ??= since();
        onEvent?.(since(), `call   ${chunk.toolName}(${JSON.stringify(chunk.input)})`);
        break;
      case 'tool-output-available': {
        const name = names.get(chunk.toolCallId);
        const output = chunk.output as { total?: number; match?: string; products?: { id: number }[]; dropped?: number[]; ok?: boolean };
        if (name === 'show_products') {
          timing.cardsMs ??= since();
          onEvent?.(since(), `cards  ${JSON.stringify(output.products?.map((p) => p.id))}${output.dropped?.length ? ` dropped ${JSON.stringify(output.dropped)}` : ''}`);
        } else {
          onEvent?.(since(), output.ok === false ? 'result catalog unavailable' : `result ${output.total} candidates (${output.match})`);
        }
        break;
      }
      case 'text-delta':
        if (timing.firstTextMs == null) {
          timing.firstTextMs = since();
          onEvent?.(since(), 'first text');
        }
        break;
      case 'error':
        throw new Error(chunk.errorText);
    }
  }
  timing.totalMs = since();

  const assistant = finalMessages.at(-1);
  const groups: ShowProductsOutput[] = [];
  const searches: SearchInput[] = [];
  let answer = '';
  for (const part of assistant?.role === 'assistant' ? assistant.parts : []) {
    if (part.type === 'text') answer += part.text;
    if (part.type === 'tool-show_products' && part.state === 'output-available') groups.push(part.output);
    if (part.type === 'tool-search_products' && part.input) searches.push(part.input as SearchInput);
  }

  const usage = await result.usage;
  return {
    messages: finalMessages,
    text: answer,
    groups,
    searches,
    steps,
    timing,
    usage: { input: usage.inputTokens, output: usage.outputTokens, reasoning: usage.outputTokenDetails?.reasoningTokens },
  };
}
