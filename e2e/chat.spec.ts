import { expect, test, type Page } from '@playwright/test';

// Next.js keeps the previous route mounted but hidden after client-side navigation,
// so every locator here is restricted to what is actually visible.
const visible = (page: Page, selector: string) => page.locator(`${selector}:visible`);
const cards = (page: Page) => visible(page, '[data-testid=product-card]');
const sidebarLinks = (page: Page) => visible(page, 'nav[aria-label=Conversations] a');

async function send(page: Page, text: string) {
  const input = visible(page, 'input[aria-label=Message]');
  await input.fill(text);
  await input.press('Enter');
}

test('chat, product cards, reload, new conversation, list, resume', async ({ page }) => {
  // A new visit gets its own conversation URL before anything is sent.
  await page.goto('/');
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
  const firstUrl = page.url();
  await expect(sidebarLinks(page)).toHaveCount(0);

  // Ask for products: search status, then cards, then text.
  await send(page, 'show me laptops');
  await expect(visible(page, '[data-testid=user-message]')).toHaveText('show me laptops');
  await expect(visible(page, '[data-testid=search-status]')).toHaveText(/Searched laptops · \d+ found/);
  await expect(cards(page)).toHaveCount(3);
  await expect(visible(page, '[data-testid=assistant-message] p').last()).toContainText('Want me to narrow them down?');

  // Cards carry real catalog data: title, description, price, image.
  const first = cards(page).first();
  await expect(first.getByRole('heading')).toHaveText('Apple MacBook Pro 14 Inch Space Grey');
  await expect(first).toContainText('$1,999.99');
  await expect(first).toContainText('MacBook Pro 14 Inch in Space Grey');
  await expect(first.getByRole('img')).toHaveAttribute('src', /cdn\.dummyjson\.com.*thumbnail/);

  // The conversation is listed, titled by its first message.
  await expect(sidebarLinks(page)).toHaveText(['show me laptops']);

  // Reload: everything is still there, served from the database.
  await page.reload();
  await expect(visible(page, '[data-testid=user-message]')).toHaveText('show me laptops');
  await expect(cards(page)).toHaveCount(3);
  await expect(cards(page).first().getByRole('heading')).toHaveText('Apple MacBook Pro 14 Inch Space Grey');
  await expect(visible(page, 'main [role=alert]')).toHaveCount(0);

  // Start a new conversation: empty, different URL.
  await visible(page, 'aside a').filter({ hasText: 'New chat' }).click();
  await expect(page).not.toHaveURL(firstUrl);
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
  await expect(visible(page, '[data-testid=user-message]')).toHaveCount(0);

  await send(page, 'any smartphones?');
  await expect(cards(page)).toHaveCount(3);
  await expect(cards(page).first()).toContainText('iPhone');

  // Both conversations are listed, most recent first.
  await expect(sidebarLinks(page)).toHaveText(['any smartphones?', 'show me laptops']);

  // Go back to the first one and continue it.
  await sidebarLinks(page).filter({ hasText: 'show me laptops' }).click();
  await expect(page).toHaveURL(firstUrl);
  await expect(cards(page)).toHaveCount(3);
  await expect(cards(page).first().getByRole('heading')).toHaveText('Apple MacBook Pro 14 Inch Space Grey');

  await send(page, 'and tablets?');
  await expect(visible(page, '[data-testid=user-message]')).toHaveText(['show me laptops', 'and tablets?']);
  await expect(cards(page)).toHaveCount(6);
  await expect(sidebarLinks(page)).toHaveText(['show me laptops', 'any smartphones?']); // moved back to the top

  // And the continued conversation survives a reload too.
  await page.reload();
  await expect(visible(page, '[data-testid=user-message]')).toHaveText(['show me laptops', 'and tablets?']);
  await expect(cards(page)).toHaveCount(6);
});

test('a conversation continued in another tab is detected, not silently overwritten', async ({ page, context }) => {
  await page.goto('/');
  await send(page, 'show me laptops');
  await expect(cards(page)).toHaveCount(3);

  // A second tab opens the same conversation and continues it.
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(cards(other)).toHaveCount(3);
  await send(other, 'and tablets?');
  await expect(cards(other)).toHaveCount(6);
  await expect(visible(other, '[data-testid=assistant-message]').last()).toContainText('narrow them down'); // reply fully finished

  // The first tab is now behind. Its next message is refused and the user is told why.
  await send(page, 'any smartphones?');
  const alert = visible(page, 'main [role=alert]');
  await expect(alert).toContainText('changed somewhere else');
  await expect(alert.getByRole('button', { name: 'Reload conversation' })).toBeVisible();

  // Nothing was written by the refused message.
  await other.reload();
  await expect(visible(other, '[data-testid=user-message]')).toHaveText(['show me laptops', 'and tablets?']);
});
