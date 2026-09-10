/**
 * Capture the report-assistant screenshots for docs/webapp.md §7b against a
 * deployed app and an EXISTING finished run:
 *
 *   APP_URL=… APP_USER=… APP_PASSWORD=… RUN_ID=… node scripts/capture-chat-shots.mjs
 *
 * Kept separate from capture-docs-shots.mjs, which creates a workflow and
 * executes a full run (~20 min, Bedrock spend): this one only chats, so it
 * costs two report_chat turns and takes about two minutes. Nothing is saved
 * — the proposal is reviewed and then dismissed.
 *
 * Framing: shots are clipped to the drawer and to sections that name only
 * the fictional portfolio, so no real-world brand from live research ends up
 * in the published docs (same rule as the report shot in the main script).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { APP_URL, APP_USER: USERNAME, APP_PASSWORD: PASSWORD, RUN_ID } = process.env;
if (!APP_URL || !USERNAME || !PASSWORD || !RUN_ID) {
  throw new Error('Set APP_URL, APP_USER, APP_PASSWORD, and RUN_ID (a run with a report).');
}
const ANSWER_TIMEOUT_MS = 4 * 60_000;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'images', 'webapp');
mkdirSync(OUT, { recursive: true });

const QUESTION =
  'Which of our brands overlap in the portfolio, and what does the report say we should do about it?';
const EDIT_REQUEST =
  'Rewrite section 8 (Risks) as a table with columns Risk, Evidence and Mitigation, using only what the report already says.';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

async function shot(name, options = {}) {
  await page.screenshot({ path: join(OUT, `${name}.png`), ...options });
  console.log(`  [shot] ${name}.png`);
}
/** The chat panel inside the AppLayout drawer (the drawer itself has no accessible name). */
const drawer = () => page.locator('.chat-drawer');
/** Full-height clip around the drawer column, for drawer-only captures. */
async function drawerClip() {
  const box = await drawer().boundingBox();
  if (!box) throw new Error('drawer not visible');
  const x = Math.max(0, box.x - 24);
  return { x, y: 0, width: 1440 - x, height: 900 };
}
async function sendAndWait(text) {
  const input = page.getByPlaceholder(/Ask a question/);
  await input.fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  // The assistant turn is complete when the send button is enabled again.
  await page.waitForFunction(
    () => !document.querySelector('button[aria-label="Send"]')?.hasAttribute('disabled'),
    null,
    { timeout: ANSWER_TIMEOUT_MS },
  );
  await page.waitForTimeout(800);
}

try {
  console.log('Sign in');
  await page.goto(`${APP_URL}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20_000 });

  console.log('Open the run report');
  await page.goto(`${APP_URL}/runs/${RUN_ID}`, { waitUntil: 'networkidle' });
  // The report workspace renders on the run page itself ("View report" only
  // scrolls to it), so wait for the rendered markdown directly.
  await page.locator('.markdown').first().waitFor({ timeout: 30_000 });
  // The drawer remembers its open state per browser (default open); open it
  // only if it is not already showing.
  if (!(await drawer().isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Open report assistant' }).click();
  }
  await drawer().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);

  console.log('11. Ask a grounded question (live report_chat turn)…');
  await sendAndWait(QUESTION);
  // The drawer auto-scrolls to the end of a long answer; show the question
  // and the opening of the reply instead.
  await page.locator('.chat-turn-user').last().evaluate((el) => {
    let node = el.parentElement;
    while (node && !(getComputedStyle(node).overflowY === 'auto' && node.scrollHeight > node.clientHeight)) {
      node = node.parentElement;
    }
    if (node) node.scrollTop = el.offsetTop - node.offsetTop - 8;
  });
  await page.waitForTimeout(500);
  await shot('11-report-chat-answer', { clip: await drawerClip() });

  console.log('12. Request an edit (live turn, ~1 min)…');
  const input = page.getByPlaceholder(/Ask a question/);
  await input.fill(EDIT_REQUEST);
  await page.getByRole('button', { name: 'Send' }).click();
  // Catch the drafting indicator mid-flight for the walkthrough.
  await page.getByText(/Drafting section/).waitFor({ timeout: ANSWER_TIMEOUT_MS });
  await page.waitForTimeout(400);
  await shot('12-report-chat-drafting', { clip: await drawerClip() });
  await page.waitForFunction(
    () => !document.querySelector('button[aria-label="Send"]')?.hasAttribute('disabled'),
    null,
    { timeout: ANSWER_TIMEOUT_MS },
  );

  console.log('13. Review mode in the report');
  // The summary bar reads "Proposed changes" (Accept all / Keep all appear
  // only with 2+ sections; one section offers Save change / Edit / Dismiss).
  await page.locator('.report-review-summary').waitFor({ timeout: 20_000 });
  // The app smooth-scrolls to the top of the review when a proposal lands;
  // let that finish, then bring the reviewed section itself into frame.
  await page.waitForTimeout(1500);
  await page.locator('.report-review').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await page.locator('.report-review').first().evaluate((el) => {
    // Nudge up so the section header sits just below the pinned summary bar.
    let node = el.parentElement;
    while (node && !(getComputedStyle(node).overflowY === 'auto' && node.scrollHeight > node.clientHeight)) {
      node = node.parentElement;
    }
    (node ?? document.scrollingElement).scrollBy(0, -100);
  });
  await page.waitForTimeout(800);
  await shot('13-report-review-diff');

  await page.getByRole('button', { name: 'Dismiss' }).click();
  console.log('\nDONE — nothing saved; screenshots in docs/images/webapp/');
} catch (error) {
  await shot('FAILURE-chat');
  console.log(`FAIL — ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
