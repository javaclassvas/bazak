import { createUIMessageStreamResponse, toUIMessageStream, TypeValidationError } from 'ai';
import { runAgent } from '@/lib/agent/agent';
import { getModel, MissingApiKeyError } from '@/lib/agent/model';
import { createCatalogClient } from '@/lib/catalog/client';

const catalog = createCatalogClient();

const jsonError = (status: number, message: string) => Response.json({ error: message }, { status });

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.messages)) return jsonError(400, 'Expected { messages: UIMessage[] }.');

  try {
    const { result, messages } = await runAgent({ model: getModel(), catalog, messages: body.messages });

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: result.stream,
        originalMessages: messages,
        // Provider errors can carry request details; the browser gets a fixed sentence, the server log gets the rest.
        onError: (error) => {
          console.error('[chat] stream error:', error);
          return 'The assistant could not finish this reply. Please try again.';
        },
      }),
    });
  } catch (error) {
    if (error instanceof MissingApiKeyError) return jsonError(500, error.message);
    if (TypeValidationError.isInstance(error)) return jsonError(400, 'The conversation history is not valid.');
    console.error('[chat] failed before streaming:', error);
    return jsonError(500, 'The assistant is unavailable right now.');
  }
}
