'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CopilotUIMessage } from '@/lib/agent/tools';
import { Message } from './message';
import { CONVERSATIONS_CHANGED } from './sidebar';

const SUGGESTIONS = ['Laptops for work', 'Phones under $300', 'A dress and matching shoes', 'Something cheap and cool'];
/** A message carried over into a new chat after the old one went out of sync. */
const DRAFT_KEY = 'copilot:draft';

type Props = {
  id: string;
  initialMessages: CopilotUIMessage[];
  /** Stored messages that could not be read and are not shown. */
  unreadable?: number;
  /** The server is still generating a reply started before this page load. */
  pending?: boolean;
};

/** The server answers errors as `{ error: code }`; the SDK surfaces the body in the error message. */
function errorCode(error: Error | undefined): string | null {
  if (!error) return null;
  const match = error.message.match(/"error"\s*:\s*"([a-z_]+)"/);
  return match ? match[1] : 'unknown';
}

export function Chat({ id, initialMessages, unreadable = 0, pending = false }: Props) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        // The server owns the history. Send only the new message, plus the id of the message we believe
        // precedes it so the server can tell when our view is stale.
        prepareSendMessagesRequest: ({ messages, id: chatId }) => ({
          body: { id: chatId, message: messages.at(-1), lastMessageId: messages.at(-2)?.id ?? null },
        }),
      }),
    [],
  );

  const { messages, sendMessage, status, error, regenerate, clearError } = useChat<CopilotUIMessage>({
    id,
    messages: initialMessages,
    transport,
    onFinish: () => window.dispatchEvent(new Event(CONVERSATIONS_CHANGED)),
    onError: () => window.dispatchEvent(new Event(CONVERSATIONS_CHANGED)),
  });

  const code = errorCode(error);
  const busy = status === 'submitted' || status === 'streaming';
  const waiting = status === 'submitted' || (status === 'streaming' && messages.at(-1)?.role === 'user');
  // The last message is the user's and nothing is running: an earlier reply failed or never arrived.
  const unanswered = !busy && !pending && !error && messages.at(-1)?.role === 'user';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, status]);

  // Pick up a message carried over from an out-of-sync conversation.
  // The draft is removed only once it has been applied: in development React runs effects twice,
  // and removing it on the first pass would leave nothing for the second.
  useEffect(() => {
    if (initialMessages.length > 0) return;
    let draft: string | null = null;
    try {
      draft = sessionStorage.getItem(DRAFT_KEY);
    } catch {
      /* storage unavailable: nothing to restore */
    }
    if (!draft) return;
    const text = draft;
    const timer = setTimeout(() => {
      setInput(text);
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        /* nothing to clean up */
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [initialMessages.length]);

  // A reply is being finished on the server. Reload until it has been saved.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => window.location.reload(), 2000);
    return () => clearTimeout(timer);
  }, [pending]);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy || pending) return;
    clearError();
    sendMessage({ text: trimmed });
    setInput('');
  }

  function carryOverToNewChat() {
    const last = messages.findLast((m) => m.role === 'user');
    const text = last?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    try {
      sessionStorage.setItem(DRAFT_KEY, text);
    } catch {
      /* storage unavailable: the new chat simply starts empty */
    }
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
          {unreadable > 0 && (
            <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {unreadable} earlier {unreadable === 1 ? 'message' : 'messages'} could not be read and {unreadable === 1 ? 'is' : 'are'} not shown.
            </p>
          )}

          {messages.length === 0 && (
            <div className="flex flex-col items-center gap-4 pt-16 text-center">
              <h1 className="text-2xl font-semibold text-zinc-900">What are you shopping for?</h1>
              <p className="max-w-md text-sm text-zinc-500">Describe what you need. I search the store catalog and show what fits.</p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => submit(s)}
                    className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:border-zinc-400"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <Message key={m.id} message={m} />
          ))}

          {(waiting || pending) && (
            <p data-testid="thinking" role="status" className="animate-pulse text-xs text-zinc-400">
              {pending ? 'Finishing the previous reply…' : 'Thinking…'}
            </p>
          )}

          {code === 'out_of_sync' ? (
            <div role="alert" className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
              <span>This conversation changed somewhere else, so your message was not sent.</span>
              <span className="flex gap-2">
                <button type="button" onClick={() => window.location.reload()} className="rounded-md bg-amber-900 px-3 py-1 text-xs font-medium text-white">
                  Reload conversation
                </button>
                <Link href="/" prefetch={false} onClick={carryOverToNewChat} className="rounded-md border border-amber-900 px-3 py-1 text-xs font-medium">
                  Start a new chat with this message
                </Link>
              </span>
            </div>
          ) : code === 'history_invalid' ? (
            <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
              This conversation can no longer be continued.{' '}
              <Link href="/" prefetch={false} onClick={carryOverToNewChat} className="font-medium underline">
                Start a new chat with this message
              </Link>
            </div>
          ) : (
            (error || unanswered) && (
              <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                <span>
                  {code === 'storage_failed'
                    ? 'Your message could not be saved, so it was not sent.'
                    : code === 'busy'
                      ? 'A reply is still being generated for this conversation.'
                      : unanswered
                        ? 'This message did not get a reply.'
                        : 'Something went wrong and this reply did not finish.'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    clearError();
                    regenerate();
                  }}
                  className="rounded-md bg-red-900 px-3 py-1 text-xs font-medium text-white hover:bg-red-800"
                >
                  Retry
                </button>
              </div>
            )
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        className="border-t border-zinc-200 bg-white"
      >
        <div className="mx-auto flex w-full max-w-3xl gap-2 px-4 py-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask for a product…"
            aria-label="Message"
            autoFocus
            className="flex-1 rounded-xl border border-zinc-300 px-4 py-2.5 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-zinc-900"
          />
          <button
            type="submit"
            disabled={busy || pending || !input.trim()}
            className="rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </main>
  );
}
