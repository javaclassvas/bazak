import { createChatStream } from '@/lib/agent/chat-stream';
import { getModel, MissingApiKeyError } from '@/lib/agent/model';
import { createCatalogClient } from '@/lib/catalog/client';
import { getStore } from '@/lib/db/store';

const catalog = createCatalogClient();

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  try {
    return await createChatStream(body, { model: getModel, catalog, store: getStore() });
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return Response.json({ error: 'unavailable', message: error.message }, { status: 500 });
    }
    console.error('[chat] failed before streaming:', error);
    return Response.json({ error: 'unavailable', message: 'The assistant is unavailable right now.' }, { status: 500 });
  }
}
