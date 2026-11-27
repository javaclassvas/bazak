import {
  createIdGenerator,
  createUIMessageStreamResponse,
  readUIMessageStream,
  toUIMessageStream,
  TypeValidationError,
  type LanguageModel,
  type UIMessageChunk,
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

/** Closing sentence when the model called tools but wrote nothing, so a reply never ends in silence. */
export const CLOSING_TEXT = {
  /** Cards were shown; the model just did not add a sentence. */
  shown: 'Here is what I found.',
  /** The step limit was reached, or the model stopped, before anything could be shown. */
  nothingShown: 'I could not finish that search. Could you rephrase it or narrow it down?',
};
const RUN_LOCK_MS = 120_000;
const newMessageId = createIdGenerator({ prefix: 'msg', size: 16 });

/**
 * If a reply used tools but contains no text, append a closing sentence to the stream itself.
 * Done in the stream, not at save time, so the browser and the database get the same reply.
 */
function withClosingText(state: { failed: boolean }): TransformStream<UIMessageChunk, UIMessageChunk> {
  let usedTools = false;
  let wroteText = false;
  let showedCards = false;
  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.type === 'tool-input-available') usedTools = true;
      if (chunk.type === 'text-delta' && chunk.delta.trim()) wroteText = true;
      // A stream-level error ends the turn. A failed tool call does not: it is a part of the reply.
      if (chunk.type === 'error') state.failed = true;
      if (chunk.type === 'tool-output-available') {
        const output = chunk.output as { products?: unknown[]; dropped?: unknown } | null;
        if (output && 'dropped' in output && Array.isArray(output.products) && output.products.length > 0) showedCards = true;
      }
      if (chunk.type === 'finish' && usedTools && !wroteText && !state.failed) {
        const textId = 'closing-text';
        controller.enqueue({ type: 'start-step' });
        controller.enqueue({ type: 'text-start', id: textId });
        controller.enqueue({ type: 'text-delta', id: textId, delta: showedCards ? CLOSING_TEXT.shown : CLOSING_TEXT.nothingShown });
        controller.enqueue({ type: 'text-end', id: textId });
        controller.enqueue({ type: 'finish-step' });
      }
      controller.enqueue(chunk);
    },
  });
}

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
  // Safety net: never leave a conversation locked if the stream never ends.
  const unlock = setTimeout(() => activeRuns.delete(id), RUN_LOCK_MS);
  try {
    const { result, messages } = await runAgent({
      model: deps.model(),
      catalog: deps.catalog,
      messages: [...history, message],
      effort: deps.effort,
    });

    const state = { failed: false };
    const uiStream = toUIMessageStream({
      stream: result.stream,
      originalMessages: messages,
      generateMessageId: newMessageId,
      // Called for tool errors as well as fatal ones, so it only words the message; it decides nothing.
      onError: (error) => {
        console.error('[chat] stream error:', error);
        return 'The assistant could not finish this reply. Please try again.';
      },
    }).pipeThrough(withClosingText(state));

    // Two readers of one stream: the browser, and a server-side reader that assembles the message to
    // store. If the browser goes away (tab closed, page reloaded) its branch is cancelled, but the
    // server-side reader keeps pulling, so the turn runs to completion and the whole reply is saved.
    // Both branches carry the same chunks, so what is stored is what was streamed.
    const [forBrowser, forStore] = uiStream.tee();
    void (async () => {
      let reply: { id: string; parts: { type: string }[] } | undefined;
      try {
        for await (const snapshot of readUIMessageStream({ stream: forStore })) reply = snapshot;
      } catch (error) {
        state.failed = true;
        console.error('[chat] could not read the reply to store it:', error);
      } finally {
        clearTimeout(unlock);
        activeRuns.delete(id);
      }
      // A reply that failed part-way is not stored. The user message stays last in the database, which
      // is exactly the state Retry expects; a half-finished reply would make every retry look stale.
      if (state.failed || !reply) return;
      // Reasoning is neither shown nor replayed, so it is not stored.
      const parts = reply.parts.filter((p) => p.type !== 'reasoning');
      if (!parts.some((p) => p.type !== 'step-start')) return; // nothing was produced
      try {
        deps.store.saveMessage(id, { id: reply.id, role: 'assistant', parts });
      } catch (error) {
        // The user has already seen this reply; it will be missing after a reload.
        console.error('[chat] could not save the assistant message:', error);
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
