/**
 * Headless browser smoke test against the deployed marketing-workflow web app
 * (run: node scripts/browser-smoke.mjs — needs APP_PASSWORD or
 * /tmp/workflow-test-pw.txt, and a user in the Cognito 'admin' group for the
 * admin steps).
 *
 * Walks EVERY user-facing function end to end (D-16..D-20):
 *   1. sign in
 *   2. settings — org configuration renders (agent prompts + model catalog)
 *   3. admin: set prompt overrides (brand_intelligence + report_generator)
 *   4. admin: model catalog — invalid id rejected by Bedrock check, then a
 *      clean re-save of the real ids
 *   5. create a workflow
 *   6. edit workflow — failure policy (retry-run, max 2)
 *   7. draft a plan with the planner (live harness invocation)
 *   8. per-task model selector — assign Opus to task 1
 *   9. save plan (server-side catalog validation)
 *  10. run now → wait for completion (exercises the SystemPrompt+Model
 *      override invoke states live) → open the report artifact
 *  11. admin cleanup: restore both prompt overrides to deployed defaults
 *
 * Captures console errors, failed requests, and step screenshots to
 * /tmp/workflow-shots. The created workflow is left in place (no delete API),
 * clearly named "Smoke test …".
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const APP_URL = process.env.APP_URL;
const USERNAME = process.env.APP_USER;
if (!APP_URL || !USERNAME) {
  throw new Error('Set APP_URL (the WebAppUrl stack output) and APP_USER before running.');
}
const PASSWORD =
  process.env.APP_PASSWORD ?? readFileSync('/tmp/workflow-test-pw.txt', 'utf-8').trim();
const OPUS_ID = process.env.DEEP_MODEL_ID ?? 'au.anthropic.claude-opus-5';
const RUN_TIMEOUT_MS = 15 * 60_000;
const DRAFT_TIMEOUT_MS = 5 * 60_000;
const SHOTS = '/tmp/workflow-shots';
mkdirSync(SHOTS, { recursive: true });

const consoleErrors = [];
const failedRequests = [];
let step = 0;

async function shot(page, name) {
  step += 1;
  const file = `${SHOTS}/${String(step).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  [shot] ${file}`);
}

/** Expand an agent's prompt section on Settings and apply/restore override. */
async function editAgentPrompt(page, agentName, marker) {
  await page.getByText(agentName, { exact: true }).first().click();
  const textarea = page.locator('textarea:visible').first();
  await textarea.waitFor({ timeout: 10_000 });
  if (marker) {
    const current = await textarea.inputValue();
    if (current.includes(marker)) {
      // Idempotent re-run: override already in place; Save is (correctly)
      // disabled because the draft equals the saved value.
      console.log(`   ${agentName}: override already in place`);
    } else {
      await textarea.fill(`${current}\n${marker}`);
      await page.getByRole('button', { name: 'Save override' }).locator('visible=true').click();
      await page
        .getByText(`${agentName}: prompt override saved`, { exact: false })
        .waitFor({ timeout: 15_000 });
    }
  } else {
    const restore = page
      .getByRole('button', { name: 'Restore default' })
      .locator('visible=true');
    if (await restore.isEnabled()) {
      await restore.click();
      await page
        .getByText(`${agentName}: restored the deployed default`, { exact: false })
        .waitFor({ timeout: 15_000 });
    } else {
      console.log(`   ${agentName}: no override to restore`);
    }
  }
  // Collapse again so the next section's controls are the visible ones.
  await page.getByText(agentName, { exact: true }).first().click();
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    consoleErrors.push(msg.text().slice(0, 300));
  }
});
page.on('requestfailed', (request) => {
  failedRequests.push(
    `${request.method()} ${request.url()} → ${request.failure()?.errorText}`,
  );
});

try {
  console.log('1. Sign in');
  await page.goto(`${APP_URL}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), {
    timeout: 20_000,
  });
  await shot(page, 'signed-in');

  console.log('2. Settings — organization configuration renders');
  await page.goto(`${APP_URL}/settings`, { waitUntil: 'networkidle' });
  await page.getByText('Agent prompts', { exact: true }).waitFor({ timeout: 20_000 });
  for (const agent of [
    'planner',
    'product_expert',
    'brand_intelligence',
    'market_analytics',
    'report_generator',
  ]) {
    await page.getByText(agent, { exact: true }).first().waitFor({ timeout: 10_000 });
  }
  await page.getByText('Model catalog', { exact: true }).waitFor();
  const sonnetInput = page.locator('input[value*="sonnet"]');
  const opusInput = page.locator('input[value*="opus"]');
  console.log(
    `   catalog rows: sonnet=${await sonnetInput.count()} opus=${await opusInput.count()}`,
  );
  await shot(page, 'settings-org-config');

  console.log('3. Admin: set prompt overrides (brand_intelligence, report_generator)');
  const MARKER = 'SMOKE-OVERRIDE: keep outputs concise for this verification run.';
  await editAgentPrompt(page, 'brand_intelligence', MARKER);
  await editAgentPrompt(page, 'report_generator', MARKER);
  await page.getByText('Customized').first().waitFor({ timeout: 10_000 });
  await shot(page, 'prompt-overrides-set');

  console.log('4. Admin: model catalog — invalid id rejected, clean save accepted');
  await page.getByRole('button', { name: 'Add model' }).click();
  const newRow = page.locator('input[placeholder="inference profile or model id"]:visible').last();
  await newRow.fill('bogus.model.does-not-exist');
  await page.getByRole('button', { name: 'Save catalog' }).click();
  await page
    .getByText('model id(s) not found in Bedrock', { exact: false })
    .waitFor({ timeout: 30_000 });
  console.log('   invalid id correctly rejected by the Bedrock check');
  await shot(page, 'catalog-invalid-rejected');
  await page.getByRole('button', { name: /Remove/ }).last().click();
  await page.getByRole('button', { name: 'Save catalog' }).click();
  await page.getByText('Model catalog saved', { exact: false }).waitFor({ timeout: 30_000 });
  console.log('   real ids re-saved and verified against Bedrock');

  console.log('5. Create a workflow');
  const wfName = `Smoke test ${new Date().toISOString().slice(0, 16)}`;
  await page.goto(`${APP_URL}/workflows`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Create workflow' }).first().click();
  await page.getByLabel('Name').fill(wfName);
  await page
    .getByLabel('Goal')
    .fill(
      'Produce a one-paragraph market intelligence note confirming the platform pipeline works. This is a connectivity verification: no web research is required, do not use tools, keep every task minimal.',
    );
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/workflows\/[0-9a-f-]+$/, { timeout: 20_000 });
  const workflowUrl = page.url();
  console.log(`   created: ${wfName}`);
  await shot(page, 'workflow-created');

  console.log('6. Edit workflow — failure policy retry-run (max 2)');
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit workflow' }).click();
  await page.getByText('Retry the job', { exact: true }).click();
  await page.getByLabel('Max attempts').fill('2');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Workflow updated', { exact: false }).waitFor({ timeout: 15_000 });
  await page
    .getByText('Retry the job (max 2 attempts)', { exact: true })
    .waitFor({ timeout: 15_000 });
  await shot(page, 'failure-policy-set');

  console.log('7. Draft a plan with the planner (live harness invocation)…');
  await page.getByRole('button', { name: /Draft plan with planner/ }).click();
  await page
    .getByRole('button', { name: 'Save plan' })
    .waitFor({ timeout: DRAFT_TIMEOUT_MS });
  await shot(page, 'plan-drafted');

  console.log('8. Per-task model selector — assign Opus to the first task');
  // The Select trigger's accessible name is the selected option: either
  // "Worker default" or a model id the planner already assigned (rule 8).
  const trigger = page
    .getByRole('button', { name: /Worker default|anthropic\./ })
    .first();
  const planned = (await trigger.textContent())?.trim();
  console.log(`   planner assigned: ${planned || '(worker default)'}`);
  await trigger.click();
  const escaped = OPUS_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.getByRole('option', { name: new RegExp(escaped) }).click();
  console.log(`   task 1 model → ${OPUS_ID}`);
  await shot(page, 'model-assigned');

  console.log('9. Save plan (server-side catalog validation)');
  await page.getByRole('button', { name: 'Save plan' }).click();
  await page.getByText('Plan saved as v', { exact: false }).waitFor({ timeout: 20_000 });

  console.log('10. Run now → wait for completion (override invoke states live)');
  await page.getByRole('button', { name: 'Run now' }).click();
  await page.getByText('Run started', { exact: false }).waitFor({ timeout: 15_000 });
  await page.locator('a[href^="/runs/"]').first().waitFor({ timeout: 30_000 });
  await page.locator('a[href^="/runs/"]').first().click();
  await page.waitForURL(/\/runs\//, { timeout: 15_000 });
  await shot(page, 'run-started');
  console.log(`   waiting up to ${RUN_TIMEOUT_MS / 60_000} min for the report…`);
  await page
    .getByRole('button', { name: 'View report' })
    .waitFor({ timeout: RUN_TIMEOUT_MS });
  await page.getByRole('button', { name: 'View report' }).click();
  await page.locator('.markdown, [class*="markdown"]').first().waitFor({ timeout: 20_000 });
  await shot(page, 'report-artifact');
  console.log('   report rendered — worker + report override states verified live');

  console.log('11. Admin cleanup: restore prompt overrides');
  await page.goto(`${APP_URL}/settings`, { waitUntil: 'networkidle' });
  await page.getByText('Agent prompts', { exact: true }).waitFor({ timeout: 20_000 });
  await editAgentPrompt(page, 'brand_intelligence', null);
  await editAgentPrompt(page, 'report_generator', null);
  await shot(page, 'overrides-restored');

  console.log(`\nRESULT: PASS — all functions verified in a real browser`);
  console.log(`Smoke workflow left in place (no delete API): ${workflowUrl}`);
} catch (error) {
  await shot(page, 'FAILURE');
  console.log(`\nRESULT: FAIL — ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  if (consoleErrors.length > 0) {
    console.log('\nConsole errors:');
    for (const err of consoleErrors.slice(0, 8)) console.log(`  - ${err}`);
  }
  if (failedRequests.length > 0) {
    console.log('\nFailed requests:');
    for (const req of failedRequests.slice(0, 8)) console.log(`  - ${req}`);
  }
  if (consoleErrors.length === 0 && failedRequests.length === 0) {
    console.log('No console errors, no failed requests.');
  }
  await browser.close();
}
