import { connection } from 'next/server';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

async function NewChat(): Promise<never> {
  // A fresh id per visit. The conversation itself is created only when its first message is saved,
  // and the id is in the URL before anything is sent, so the stream never has to survive a navigation.
  await connection();
  redirect(`/c/${crypto.randomUUID()}`);
}

export default function Home() {
  return (
    <Suspense>
      <NewChat />
    </Suspense>
  );
}
