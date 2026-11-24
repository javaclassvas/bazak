/**
 * A local HTTP server that answers DummyJSON product routes from the pinned fixture.
 * The app under e2e test is pointed at it with CATALOG_BASE_URL, so the run needs no network.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createFixtureFetch } from '../src/lib/catalog/fixture';

const port = Number(process.env.STUB_PORT ?? 4010);
const answer = createFixtureFetch(JSON.parse(readFileSync('evals/fixture/catalog.json', 'utf8')).products);

createServer(async (req, res) => {
  if (req.url === '/health') return res.writeHead(200).end('ok');
  const response = await answer(`http://localhost:${port}${req.url}`);
  res.writeHead(response.status, { 'content-type': 'application/json' }).end(await response.text());
}).listen(port, () => console.log(`catalog stub on :${port}`));
