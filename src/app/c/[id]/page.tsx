import { connection } from 'next/server';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { Chat } from '@/components/chat';
import { Sidebar } from '@/components/sidebar';
import { isGenerating } from '@/lib/agent/chat-stream';
import type { CopilotUIMessage } from '@/lib/agent/tools';
import { getStore } from '@/lib/db/store';

async function Conversation({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) notFound();
  await connection(); // history is per request, never prerendered

  const { messages, unreadable } = getStore().load(id);
  return (
    <>
      <Sidebar activeId={id} />
      <Chat
        // Remount when the URL changes, so one conversation's state never leaks into another.
        key={id}
        id={id}
        initialMessages={messages as CopilotUIMessage[]}
        unreadable={unreadable}
        // A reply is still being generated server-side (the page was reloaded mid-stream).
        pending={isGenerating(id)}
      />
    </>
  );
}

export default function Page(props: PageProps<'/c/[id]'>) {
  return (
    <div className="flex min-h-0 flex-1">
      <Suspense>
        <Conversation params={props.params} />
      </Suspense>
    </div>
  );
}
