'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useRef, useState } from 'react';
import type { CopilotUIMessage } from '@/lib/agent/tools';
import { Message } from './message';

const SUGGESTIONS = ['Laptops for work', 'Phones under $300', 'A dress and matching shoes', 'Something cheap and cool'];

export function Chat({ id, initialMessages = [] }: { id?: string; initialMessages?: CopilotUIMessage[] }) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const { messages, sendMessage, status, error, regenerate } = useChat<CopilotUIMessage>({
    id,
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });

  const busy = status === 'submitted' || status === 'streaming';
  // Nothing has streamed yet: the model is thinking before its first tool call or word.
  const waiting = status === 'submitted' || (status === 'streaming' && messages.at(-1)?.role === 'user');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, status]);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    sendMessage({ text: trimmed });
    setInput('');
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
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

          {waiting && (
            <p data-testid="thinking" role="status" className="animate-pulse text-xs text-zinc-400">
              Thinking…
            </p>
          )}

          {error && (
            <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
              <span>Something went wrong and this reply did not finish.</span>
              <button type="button" onClick={() => regenerate()} className="rounded-md bg-red-900 px-3 py-1 text-xs font-medium text-white hover:bg-red-800">
                Retry
              </button>
            </div>
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
            disabled={busy || !input.trim()}
            className="rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
