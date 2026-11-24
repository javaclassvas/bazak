import {
  createIdGenerator,
  createUIMessageStreamResponse,
  toUIMessageStream,
  TypeValidationError,
  type LanguageModel,
} from 'ai';
import { z } from 'zod';
import type { CatalogClient } from '../catalog/client';
import { titleFrom, type ConversationStore, type StoredMessage } from '../db/conversations';
import { runAgent, type ReasoningEffort } from './agent';

/** What the browser sends: one new message and what it believes came before it. Never the history. */
const requestSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  message: z.object({
    id: z.string().min(1).max(100),
    role: z.literal('user'),
    parts: z.array(z.object({ type: z.literal('text'), text: z.string().min(1).max(4000) })).min(1).max(4),
  }),
  /** Id of the last message the browser has for this conversation, `null` for a new one. */
  lastMessageId: z.string().nullable(),
});

export type ChatDeps = {
  model: () => LanguageModel;
  catalog: CatalogClient;
  store: ConversationStore;
  effort?: ReasoningEffort;
};

export type ChatErrorCode =
  | 'bad_request'
  | 'out_of_sync' // the browser's view of the conversation differs from the database
  | 'busy' // a reply for this conversation is still being generated
  | 'storage_failed' // the user's message could not be saved; the model was not called
  | 'history_invalid'
  | 'unavailable';

const fail = (status: number, code: ChatErrorCode, message: string) => Response.json({ error: code, message }, { status });

const FALLBACK_TEXT = 'I ran out of steps before finishing that. Could you rephrase or narrow it down?';
const RUN_LOCK_MS = 120_000;
const newMessageId = createIdGenerator({ prefix: 'msg', size: 16 });

// Conversations with a reply in flight, in this process. Stops a second tab or an impatient retry from
// starting a parallel generation whose answer would be saved twice.
const globalForRuns = globalThis as unknown as { __copilotRuns?: Set<string> };
const activeRuns = (globalForRuns.__copilotRuns ??= new Set<string>());

export const isGenerating = (conversationId: string) => activeRuns.has(conversationId);

/**
 * One chat request, end to end: check the request against stored history, save the user's message,
 * run the agent, stream the reply, save the reply. The route handler only supplies the dependencies.
 */
export async function createChatStream(body: unknown, deps: ChatDeps): Promise<Response> {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return fail(400, 'bad_request', 'Expected { id, message, lastMessageId }.');
  const { id, message, lastMessageId } = parsed.data;

  if (activeRuns.has(id)) return fail(409, 'busy', 'A reply for this conversation is still being generated.');

  let stored: StoredMessage[];
  try {
    stored = deps.store.load(id).messages;
  } catch (error) {
    console.error('[chat] could not read history:', error);
    return fail(500, 'unavailable', 'Conversation history could not be read.');
  }

  // A retry re-sends a user message that is already the last stored one (the model failed after it was saved).
  const isRetry = stored.at(-1)?.id === message.id && stored.at(-1)?.role === 'user';
  const history = isRetry ? stored.slice(0, -1) : stored;

  // The browser must agree with the database about what came before. It will not if the database was
  // cleared, the conversation continued in another tab, or history rows were lost.
  if ((history.at(-1)?.id ?? null) !== lastMessageId) {
    return fail(409, 'out_of_sync', 'This conversation has changed since the page was loaded.');
  }

  if (!isRetry) {
    try {
      deps.store.saveMessage(id, message, titleFrom(message.parts.map((p) => p.text).join(' ')));
    } catch (error) {
      // Disk full, read-only file, locked database. Do not call the model for a turn we cannot record.
      console.error('[chat] could not save the user message:', error);
      return fail(507, 'storage_failed', 'Your message could not be saved, so it was not sent.');
    }
  }

  activeRuns.add(id);
  // Safety net: never leave a conversation locked if the stream ends without reaching onEnd.
  const unlock = setTimeout(() => activeRuns.delete(id), RUN_LOCK_MS);
  try {
    const { result, messages } = await runAgent({
      model: deps.model(),
      catalog: deps.catalog,
      messages: [...history, message],
      effort: deps.effort,
    });

    const uiStream = toUIMessageStream({
      stream: result.stream,
      originalMessages: messages,
      generateMessageId: newMessageId,
      onError: (error) => {
        console.error('[chat] stream error:', error);
        return 'The assistant could not finish this reply. Please try again.';
      },
      onEnd: ({ responseMessage }) => {
        clearTimeout(unlock);
        activeRuns.delete(id);
        // Reasoning is neither shown nor replayed, so it is not stored.
        const parts: unknown[] = responseMessage.parts.filter((p) => p.type !== 'reasoning');
        const hasContent = parts.some((p) => (p as { type: string }).type !== 'step-start');
        if (!hasContent) return; // the model failed before producing anything: leave the user message last, so Retry works
        const hasText = parts.some((p) => (p as { type: string; text?: string }).type === 'text' && (p as { text?: string }).text?.trim());
        if (!hasText) parts.push({ type: 'text', text: FALLBACK_TEXT });
        try {
          deps.store.saveMessage(id, { id: responseMessage.id, role: 'assistant', parts });
        } catch (error) {
          // The user has already seen this reply; it will be missing after a reload.
          console.error('[chat] could not save the assistant message:', error);
        }
      },
    });

    // Two readers of one stream: the browser, and a server-side drain. If the browser goes away
    // (tab closed, page reloaded) its branch is cancelled, but the drain keeps pulling, so the turn runs
    // to completion and `onEnd` saves the whole reply. Without the drain, a disconnect ends the stream
    // early and a truncated reply is what gets stored.
    const [forBrowser, forDrain] = uiStream.tee();
    void (async () => {
      const reader = forDrain.getReader();
      try {
        while (!(await reader.read()).done);
      } catch (error) {
        console.error('[chat] drain failed:', error);
        clearTimeout(unlock);
        activeRuns.delete(id);
      }
    })();

    return createUIMessageStreamResponse({ stream: forBrowser });
  } catch (error) {
    clearTimeout(unlock);
    activeRuns.delete(id);
    if (TypeValidationError.isInstance(error)) {
      return fail(422, 'history_invalid', 'Stored history for this conversation cannot be used. Start a new chat.');
    }
    throw error;
  }
}
