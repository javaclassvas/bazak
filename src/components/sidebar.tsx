'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Summary = { id: string; title: string; updatedAt: number };

/** Fired by the chat when a message has been saved, so the list picks up new titles and ordering. */
export const CONVERSATIONS_CHANGED = 'copilot:conversations-changed';

export function Sidebar({ activeId }: { activeId: string }) {
  const [conversations, setConversations] = useState<Summary[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const res = await fetch('/api/conversations', { cache: 'no-store' });
        const data = await res.json();
        if (cancelled) return;
        setConversations(data.conversations ?? []);
        setNotice(
          !res.ok
            ? 'Past conversations could not be loaded.'
            : data.historyWasReset
              ? 'Earlier history could not be read and was set aside.'
              : null,
        );
      } catch {
        if (!cancelled) setNotice('Past conversations could not be loaded.');
      }
    }
    refresh();
    window.addEventListener(CONVERSATIONS_CHANGED, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(CONVERSATIONS_CHANGED, refresh);
    };
  }, []);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-white">
      <div className="p-3">
        <Link
          href="/"
          prefetch={false}
          className="block rounded-lg bg-zinc-900 px-3 py-2 text-center text-sm font-medium text-white hover:bg-zinc-700"
        >
          New chat
        </Link>
      </div>
      {notice && (
        <p role="status" className="mx-3 mb-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
          {notice}
        </p>
      )}
      <nav aria-label="Conversations" className="flex-1 overflow-y-auto px-2 pb-3">
        {conversations?.length === 0 && <p className="px-2 py-1 text-xs text-zinc-400">No conversations yet.</p>}
        <ul className="flex flex-col gap-0.5">
          {conversations?.map((c) => (
            <li key={c.id}>
              <Link
                href={`/c/${c.id}`}
                aria-current={c.id === activeId ? 'page' : undefined}
                className={`block truncate rounded-md px-2 py-1.5 text-sm ${
                  c.id === activeId ? 'bg-zinc-100 font-medium text-zinc-900' : 'text-zinc-600 hover:bg-zinc-50'
                }`}
              >
                {c.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
