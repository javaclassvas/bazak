import { getStore, historyWasReset } from '@/lib/db/store';

export async function GET() {
  try {
    return Response.json({ conversations: getStore().list(), historyWasReset: historyWasReset() });
  } catch (error) {
    console.error('[conversations] list failed:', error);
    return Response.json({ conversations: [], error: 'unavailable' }, { status: 500 });
  }
}
