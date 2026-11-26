import { expect, test, type Page } from '@playwright/test';

/**
 * Real model + real browser. Every assertion is a property that must hold for any acceptable answer:
 * we do not assert which products the model picks, only that what reaches the screen is true.
 */

const CATALOG = 'https://dummyjson.com';
const visible = (page: Page, selector: string) => page.locator(`${selector}:visible`);
const cards = (page: Page) => visible(page, '[data-testid=product-card]');
const lastAssistant = (page: Page) => visible(page, '[data-testid=assistant-message]').last();

async function send(page: Page, text: string) {
  const input = visible(page, 'input[aria-label=Message]');
  await input.fill(text);
  await input.press('Enter');
}

/** Wait until the reply has finished: the Send button is usable again after typing. */
async function replyFinished(page: Page) {
  await expect(visible(page, '[data-testid=thinking]')).toHaveCount(0);
  await expect(lastAssistant(page).locator('p.whitespace-pre-wrap').last()).not.toBeEmpty();
  await expect.poll(async () => (await fetch(`${new URL(page.url()).origin}/api/conversations`)).ok).toBe(true);
  // Text has stopped growing.
  let previous = '';
  await expect
    .poll(async () => {
      const now = await lastAssistant(page).innerText();
      const stable = now === previous && now.length > 0;
      previous = now;
      return stable;
    }, { intervals: [700] })
    .toBe(true);
}

type Shown = { id: number; title: string; price: number };

async function readCards(page: Page, scope = page.locator('body')): Promise<Shown[]> {
  return scope.locator('[data-testid=product-card]:visible').evaluateAll((nodes) =>
    nodes.map((n) => ({
      id: Number(n.getAttribute('data-product-id')),
      title: n.querySelector('h3')?.textContent ?? '',
      price: Number((n.querySelector('span.text-base')?.textContent ?? '').replace(/[$,]/g, '')),
    })),
  );
}

/** Every card on screen must equal what the live catalog says about that product right now. */
async function expectCardsMatchCatalog(shown: Shown[]) {
  for (const card of shown) {
    const res = await fetch(`${CATALOG}/products/${card.id}?select=title,price,category`);
    expect(res.ok, `product ${card.id} exists in the catalog`).toBe(true);
    const product = await res.json();
    expect(card.title, `title of #${card.id}`).toBe(product.title);
    expect(card.price, `price of #${card.id}`).toBe(product.price);
  }
}

const moneyIn = (text: string) => [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, '')));

test('budget query: grounded cards, streamed reply, survives reload, can be refined', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);

  // The reply is streamed: something appears (a status line or "Thinking…") well before the reply ends.
  await send(page, 'phones under $300');
  await expect(visible(page, '[data-testid=thinking], [data-testid=search-status]').first()).toBeVisible({ timeout: 10_000 });
  await expect(cards(page).first()).toBeVisible();
  await replyFinished(page);

  const first = await readCards(page);
  expect(first.length).toBeGreaterThanOrEqual(1);
  expect(first.length).toBeLessThanOrEqual(8);
  for (const card of first) expect(card.price, `${card.title} is within the budget`).toBeLessThanOrEqual(300);
  await expectCardsMatchCatalog(first);

  // Any price the assistant wrote in prose is either a shown price or the user's own number.
  const prose = await lastAssistant(page).locator('p.whitespace-pre-wrap').allInnerTexts();
  const allowed = new Set([...first.map((c) => c.price), 300]);
  expect(moneyIn(prose.join(' ')).filter((n) => !allowed.has(n))).toEqual([]);

  // Reload: the same cards, from the database.
  await page.reload();
  await expect(cards(page).first()).toBeVisible();
  expect(await readCards(page)).toEqual(first);
  await expect(visible(page, 'main [role=alert]')).toHaveCount(0);

  // Refine in the same conversation: a second assistant message with its own grounded cards.
  await send(page, 'only the two cheapest of those');
  await expect(visible(page, '[data-testid=assistant-message]')).toHaveCount(2);
  await expect(lastAssistant(page).locator('[data-testid=product-card]').first()).toBeVisible();
  await replyFinished(page);

  const refined = await readCards(page, lastAssistant(page));
  expect(refined.length).toBeGreaterThanOrEqual(1);
  expect(refined.length).toBeLessThanOrEqual(2);
  await expectCardsMatchCatalog(refined);
  for (const card of refined) expect(card.price).toBeLessThanOrEqual(300);

  // Listed in the sidebar under its first message.
  await expect(visible(page, 'nav[aria-label=Conversations] a')).toHaveText(['phones under $300']);
});

test('off-catalog query: a reply, and nothing to buy', async ({ page }) => {
  await page.goto('/');
  await send(page, 'Book me a flight to Tokyo');
  await expect(lastAssistant(page).locator('p.whitespace-pre-wrap').last()).not.toBeEmpty();
  await replyFinished(page);
  await expect(cards(page)).toHaveCount(0);
  await expect(visible(page, 'main [role=alert]')).toHaveCount(0);
});

test('two things at once: a group of cards for each', async ({ page }) => {
  await page.goto('/');
  await send(page, 'a dress and matching shoes');
  await expect(cards(page).first()).toBeVisible();
  await replyFinished(page);

  const groups = visible(page, '[data-testid=product-group]');
  expect(await groups.count()).toBeGreaterThanOrEqual(2);
  const shown = await readCards(page);
  await expectCardsMatchCatalog(shown);

  const categories = new Set<string>();
  for (const card of shown) categories.add((await (await fetch(`${CATALOG}/products/${card.id}?select=category`)).json()).category);
  expect([...categories].sort()).toEqual(['womens-dresses', 'womens-shoes']);
});
