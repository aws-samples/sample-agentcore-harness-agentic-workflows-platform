/**
 * Capture the docs/webapp.md screenshot set against a deployed marketing-workflow app
 * (run: APP_URL=… APP_USER=… APP_PASSWORD=… node scripts/capture-docs-shots.mjs).
 *
 * Walks the primary user journey — sign in → create workflow → draft plan →
 * review/edit → run → report — plus the Settings page, saving PNGs to
 * docs/images/webapp/. Creates one real workflow and executes one real run
 * (Bedrock spend applies). Selectors mirror scripts/browser-smoke.mjs.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_URL = process.env.APP_URL;
const USERNAME = process.env.APP_USER;
const PASSWORD = process.env.APP_PASSWORD;
if (!APP_URL || !USERNAME || !PASSWORD) {
  throw new Error('Set APP_URL, APP_USER, and APP_PASSWORD.');
}
const DRAFT_TIMEOUT_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 20 * 60_000;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'images', 'webapp');
mkdirSync(OUT, { recursive: true });

const WF_NAME = 'Velvet Fox AU spring campaign';
const WF_GOAL =
  'Plan a spring campaign for Velvet Fox, our sparkling rosé brand, in the ' +
  'Australian market: brand profile and target segment, current consumer ' +
  'sentiment, competitor sparkling/rosé activity, and social-channel ' +
  'compliance constraints. Deliver a campaign strategy.';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

async function shot(name, { fullPage = false } = {}) {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log(`  [shot] ${name}.png`);
}

try {
  console.log('1. Login page');
  await page.goto(`${APP_URL}/login`, { waitUntil: 'networkidle' });
  await shot('01-login');

  console.log('2. Sign in → workflows list');
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20_000 });
  await page.goto(`${APP_URL}/workflows`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot('02-workflows');

  console.log('3. Create workflow');
  await page.getByRole('button', { name: 'Create workflow' }).first().click();
  // Wait out the modal fade-in — capturing too early yields a
  // half-transparent dialog over the list.
  await page.getByRole('dialog').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1200);
  await page.getByLabel('Name').fill(WF_NAME);
  await page.getByLabel('Goal').fill(WF_GOAL);
  await page.waitForTimeout(800);
  await shot('03-create-workflow');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/workflows\/[0-9a-f-]+$/, { timeout: 20_000 });

  console.log('4. Draft a plan (live planner invocation, may take minutes)…');
  await page.getByRole('button', { name: /Draft plan with planner/ }).click();
  await page.getByRole('button', { name: 'Save plan' }).waitFor({ timeout: DRAFT_TIMEOUT_MS });
  await page.waitForTimeout(1000);
  await shot('04-plan-editor', { fullPage: true });

  console.log('5. Save plan → workflow detail');
  await page.getByRole('button', { name: 'Save plan' }).click();
  await page.getByText('Plan saved as v', { exact: false }).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await shot('05-workflow-detail');

  console.log('6. Run now → run detail (in progress)');
  await page.getByRole('button', { name: 'Run now' }).click();
  await page.getByText('Run started', { exact: false }).waitFor({ timeout: 15_000 });
  await page.locator('a[href^="/runs/"]').first().waitFor({ timeout: 30_000 });
  await page.locator('a[href^="/runs/"]').first().click();
  await page.waitForURL(/\/runs\//, { timeout: 15_000 });
  // Let the first wave start so task rows show live status.
  await page.waitForTimeout(20_000);
  await shot('06-run-in-progress');

  console.log(`7. Waiting up to ${RUN_TIMEOUT_MS / 60_000} min for completion…`);
  // The View report button renders DISABLED while the run is in flight
  // (and duplicates once enabled), so wait for the enabled state, not
  // mere presence.
  const report = page.getByRole('button', { name: 'View report' }).first();
  await report.waitFor({ timeout: 60_000 });
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (await report.isDisabled()) {
    if (Date.now() > deadline) throw new Error('run did not complete in time');
    await page.waitForTimeout(10_000);
  }
  await page.waitForTimeout(1500);
  await shot('07-run-complete');

  console.log('8. Report artifact (title + executive summary only)');
  await report.click();
  const md = page.locator('.markdown, [class*="markdown"]').first();
  await md.waitFor({ timeout: 20_000 });
  // Clip to the report's opening: live research output further down may
  // name real-world brands, which the published docs must not show.
  await md.locator('h1, h2').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(800);
  await page.screenshot({
    path: join(OUT, '08-report.png'),
    clip: { x: 280, y: 40, width: 1160, height: 290 },
  });
  console.log('  [shot] 08-report.png');

  console.log('9. Settings — agent configuration');
  await page.goto(`${APP_URL}/settings`, { waitUntil: 'networkidle' });
  await page.getByText('Agent prompts', { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByText('Agent prompts', { exact: true }).scrollIntoViewIfNeeded();
  await shot('09-settings-agents');
  // Viewport shot, not fullPage: the sticky header repeats mid-image on
  // fullPage captures of this page.
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByText('product_expert', { exact: true }).first().click();
  await page.locator('textarea:visible').first().waitFor({ timeout: 10_000 });
  await page.getByText('product_expert', { exact: true }).first()
    .evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.mouse.wheel(0, -80);
  await page.waitForTimeout(600);
  await shot('10-settings-agent-detail');

  console.log('\nDONE — screenshots in docs/images/webapp/');
} catch (error) {
  await shot('FAILURE');
  console.log(`FAIL — ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
