/**
 * Report chat + report edit handlers — behavioral tests over the real router
 * dispatch with the AWS surface mocked: DynamoDB (run/task/config records),
 * S3 (artifacts), and the harness data plane (invokeHarnessText).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpEvent } from '../handlers-src/lib/http';

const mocks = vi.hoisted(() => ({
  ddbSend: vi.fn(),
  s3Send: vi.fn(),
  invokeHarnessText: vi.fn(),
  loadAgentConfig: vi.fn(),
}));

vi.mock('../handlers-src/lib/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../handlers-src/lib/common')>();
  return { ...actual, ddb: { send: mocks.ddbSend } };
});

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: class {
      send = mocks.s3Send;
    },
  };
});

vi.mock(
  '@agentic-platform/constructs/dist/handlers-src/lib/planner-client',
  () => ({ invokeHarnessText: mocks.invokeHarnessText }),
);

vi.mock(
  '@agentic-platform/constructs/dist/handlers-src/lib/runtime-config',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@agentic-platform/constructs/dist/handlers-src/lib/runtime-config')
      >();
    return { ...actual, loadAgentConfig: mocks.loadAgentConfig };
  },
);

import { handler } from '../handlers-src/api-router';

const RUN_ID = 'run-1234';
const WORKFLOW_ID = 'wf-1';
const REPORT_KEY = `artifacts/${WORKFLOW_ID}/${RUN_ID}/report.md`;
const CHAT_ARN = 'arn:aws:bedrock-agentcore:ap-southeast-2:1:harness/report_chat';
const REPORT = '# Brief\n\n## Executive summary\n\nRevenue grew 12%.\n\n## Sources\n\n- a';

function event(method: string, path: string, body: unknown, claims: Record<string, unknown> = { username: 'alice' }): HttpEvent {
  return {
    rawPath: path,
    requestContext: { http: { method }, authorizer: { jwt: { claims } } },
    body: JSON.stringify(body),
  };
}
const chatEvent = (body: unknown, runId = RUN_ID) => event('POST', `/runs/${runId}/chat`, body);
const putEvent = (body: unknown, claims?: Record<string, unknown>) =>
  event('PUT', `/runs/${RUN_ID}/report`, body, claims);

function runItem(overrides: Record<string, unknown> = {}) {
  return {
    Item: {
      runId: RUN_ID,
      workflowId: WORKFLOW_ID,
      status: 'succeeded',
      reportArtifactKey: REPORT_KEY,
      finishedAt: '2026-09-09T00:00:00Z',
      plan: {
        report: { worker: 'report_generator' },
        tasks: [{ id: 't1', name: 'Competitor scan' }, { id: 't2', name: 'Audience' }],
      },
      ...overrides,
    },
  };
}
const taskItems = (items: Array<Record<string, unknown>>) => ({ Items: items });
const s3Body = (text: string) => ({ Body: { transformToString: async () => text } });
const metaItem = (createdBy = 'alice') => ({ Item: { workflowId: WORKFLOW_ID, createdBy } });

/** Route DynamoDB commands by shape so tests don't depend on call order. */
function routeDdb(handlers: {
  run?: () => unknown;
  tasks?: () => unknown;
  meta?: () => unknown;
  org?: () => unknown;
  update?: (input: Record<string, unknown>) => unknown;
}) {
  mocks.ddbSend.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    const key = command.input.Key as { pk?: string; sk?: string } | undefined;
    // Org settings (chat turn limit): default to "not configured".
    if (name === 'GetCommand' && key?.pk === 'CONFIG') return handlers.org?.() ?? { Item: undefined };
    if (name === 'GetCommand' && key?.pk?.startsWith('RUN#')) return handlers.run?.();
    if (name === 'GetCommand' && key?.pk?.startsWith('WF#')) return handlers.meta?.();
    if (name === 'QueryCommand') return handlers.tasks?.() ?? taskItems([]);
    if (name === 'UpdateCommand') return handlers.update?.(command.input) ?? { Attributes: {} };
    throw new Error(`unexpected ddb command ${name}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TABLE_NAME = 'table';
  process.env.BUCKET_NAME = 'bucket';
  process.env.REPORT_CHAT_HARNESS_ARN = CHAT_ARN;
  mocks.loadAgentConfig.mockResolvedValue(undefined);
});

describe('POST /runs/{runId}/chat', () => {
  it('rejects a malformed body before touching AWS', async () => {
    const response = await handler(chatEvent({ messages: [] }));
    expect(response.statusCode).toBe(400);
    expect(mocks.ddbSend).not.toHaveBeenCalled();
    expect(mocks.invokeHarnessText).not.toHaveBeenCalled();
  });

  it('503s when the deployment has no report_chat harness', async () => {
    delete process.env.REPORT_CHAT_HARNESS_ARN;
    const response = await handler(chatEvent({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error).toMatch(/report_chat/);
    expect(mocks.ddbSend).not.toHaveBeenCalled();
  });

  it('404s an unknown run', async () => {
    routeDdb({ run: () => ({ Item: undefined }) });
    const response = await handler(chatEvent({ messages: [{ role: 'user', content: 'hi' }] }, 'missing'));
    expect(response.statusCode).toBe(404);
    expect(mocks.invokeHarnessText).not.toHaveBeenCalled();
  });

  it('409s when the run has no report yet', async () => {
    routeDdb({ run: () => runItem({ status: 'running', reportArtifactKey: undefined }) });
    const response = await handler(chatEvent({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/no report yet/);
    expect(mocks.s3Send).not.toHaveBeenCalled();
  });

  it('enforces the org-configured turn limit (default 100) before grounding', async () => {
    const turns = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `t${i}` }))
        .concat([{ role: 'user', content: 'q' }]);
    // Default: 101 turns exceed 100.
    routeDdb({ run: () => runItem() });
    let response = await handler(chatEvent({ messages: turns(100) }));
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/100-turn limit/);
    expect(mocks.s3Send).not.toHaveBeenCalled();
    // Configured lower: 5 turns exceed 4.
    routeDdb({ run: () => runItem(), org: () => ({ Item: { chatMaxTurns: 4 } }) });
    response = await handler(chatEvent({ messages: turns(4) }));
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/4-turn limit/);
    // Configured higher: 101 turns pass when the limit is 200.
    routeDdb({ run: () => runItem(), org: () => ({ Item: { chatMaxTurns: 200 } }) });
    mocks.s3Send.mockResolvedValue(s3Body(REPORT));
    mocks.invokeHarnessText.mockResolvedValueOnce('ok');
    response = await handler(chatEvent({ messages: turns(100) }));
    expect(response.statusCode).toBe(200);
  });

  it('grounds on the report AND succeeded task outputs, invoking report_chat', async () => {
    routeDdb({
      run: () => runItem(),
      tasks: () =>
        taskItems([
          { taskId: 't1', status: 'succeeded', artifactKey: `artifacts/${WORKFLOW_ID}/${RUN_ID}/t1/output.md` },
          { taskId: 't2', status: 'failed' },
          { taskId: '__report', status: 'succeeded', artifactKey: REPORT_KEY },
        ]),
    });
    mocks.s3Send.mockImplementation(async (command: { input: { Key: string } }) =>
      command.input.Key === REPORT_KEY ? s3Body(REPORT) : s3Body('Rival cut prices 8%.'),
    );
    mocks.invokeHarnessText.mockResolvedValueOnce('  Revenue grew 12%.  ');

    const response = await handler(
      chatEvent({ messages: [{ role: 'user', content: 'How much did revenue grow?' }] }),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      message: { role: 'assistant', content: 'Revenue grew 12%.' },
      reportVersion: 1,
    });
    // Report + exactly one task artifact fetched (failed task and the report
    // pseudo-task are skipped).
    const fetchedKeys = mocks.s3Send.mock.calls.map((call) => (call[0] as { input: { Key: string } }).input.Key);
    expect(fetchedKeys).toEqual([REPORT_KEY, `artifacts/${WORKFLOW_ID}/${RUN_ID}/t1/output.md`]);

    expect(mocks.invokeHarnessText).toHaveBeenCalledTimes(1);
    const args = mocks.invokeHarnessText.mock.calls[0]![0] as {
      harnessArn: string; sessionId: string; text: string; systemPrompt?: string; model?: unknown;
    };
    expect(args.harnessArn).toBe(CHAT_ARN);
    expect(args.sessionId.length).toBeGreaterThanOrEqual(33);
    expect(args.sessionId).toContain(RUN_ID);
    // One harness session PER TURN: a shared per-run session replays every
    // prior turn's grounding into the model (live: 181k input tokens).
    mocks.invokeHarnessText.mockResolvedValueOnce('again');
    await handler(chatEvent({ messages: [{ role: 'user', content: 'again?' }] }));
    const second = mocks.invokeHarnessText.mock.calls[1]![0] as { sessionId: string };
    expect(second.sessionId).not.toBe(args.sessionId);
    expect(args.text).toContain('# Report (version 1)');
    expect(args.text).toContain('Revenue grew 12%.');
    expect(args.text).toContain('## Competitor scan (t1)');
    expect(args.text).toContain('Rival cut prices 8%.');
    expect(args.text.trim().endsWith('How much did revenue grow?')).toBe(true);
    // No admin override → the deployed instructions/model apply unchanged.
    expect(args.systemPrompt).toBeUndefined();
    expect(args.model).toBeUndefined();
  });

  it('applies admin prompt/model overrides for report_chat (D-19)', async () => {
    routeDdb({ run: () => runItem() });
    mocks.s3Send.mockResolvedValue(s3Body(REPORT));
    mocks.loadAgentConfig.mockResolvedValueOnce({
      name: 'report_chat',
      defaultInstructions: 'deployed',
      defaultModelId: 'haiku',
      defaultMaxTokens: 6144,
      instructionsOverride: 'Answer in French.',
      modelOverride: 'sonnet',
    });
    mocks.invokeHarnessText.mockResolvedValueOnce('Bonjour.');

    await handler(chatEvent({ messages: [{ role: 'user', content: 'q' }] }));

    expect(mocks.loadAgentConfig).toHaveBeenCalledWith('table', 'report_chat');
    const args = mocks.invokeHarnessText.mock.calls[0]![0] as { systemPrompt?: string; model?: unknown };
    expect(args.systemPrompt).toBe('Answer in French.');
    expect(args.model).toEqual({ modelId: 'sonnet', maxTokens: 6144 });
  });

  it('returns a validated edit proposal and reports the current version', async () => {
    const v2Key = `artifacts/${WORKFLOW_ID}/${RUN_ID}/report.v2.md`;
    routeDdb({
      run: () =>
        runItem({
          reportArtifactKey: v2Key,
          reportVersions: [
            { version: 1, artifactKey: REPORT_KEY, savedAt: 'x' },
            { version: 2, artifactKey: v2Key, savedAt: 'y', savedBy: 'bob' },
          ],
        }),
    });
    mocks.s3Send.mockResolvedValue(s3Body(REPORT));
    mocks.invokeHarnessText.mockResolvedValueOnce(
      [
        'Tightened it.',
        '```edit-proposal',
        JSON.stringify({ heading: '## Executive summary', newMarkdown: '## Executive summary\n\nUp 12% YoY.', rationale: 'basis' }),
        '```',
      ].join('\n'),
    );

    const response = await handler(chatEvent({ messages: [{ role: 'user', content: 'tighten the summary' }] }));
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(body.reportVersion).toBe(2);
    expect(body.message.content).toBe('Tightened it.');
    expect(body.message.proposedEdits).toEqual([
      {
        heading: '## Executive summary',
        newMarkdown: '## Executive summary\n\nUp 12% YoY.',
        rationale: 'basis',
      },
    ]);
    // Grounded on the LATEST version's key.
    expect((mocks.s3Send.mock.calls[0]![0] as { input: { Key: string } }).input.Key).toBe(v2Key);
    const args = mocks.invokeHarnessText.mock.calls[0]![0] as { text: string };
    expect(args.text).toContain('# Report (version 2)');
  });

  it('surfaces an unusable proposal as proposalIssue, not as an edit', async () => {
    routeDdb({ run: () => runItem() });
    mocks.s3Send.mockResolvedValue(s3Body(REPORT));
    mocks.invokeHarnessText.mockResolvedValueOnce(
      'x\n```edit-proposal\n{"heading":"## Missing","newMarkdown":"## Missing\\n\\ny"}\n```',
    );
    const body = JSON.parse((await handler(chatEvent({ messages: [{ role: 'user', content: 'q' }] }))).body);
    expect(body.message.proposedEdits).toBeUndefined();
    expect(body.message.proposalIssue).toMatch(/section not found/);
  });

  it('502s when grounding artifacts cannot be read (harness never invoked)', async () => {
    routeDdb({ run: () => runItem() });
    mocks.s3Send.mockRejectedValueOnce(new Error('NoSuchKey'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await handler(chatEvent({ messages: [{ role: 'user', content: 'q' }] }));
    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body).error).toMatch(/could not load the report artifacts/);
    expect(mocks.invokeHarnessText).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('502s with a retryable message when the harness fails', async () => {
    routeDdb({ run: () => runItem() });
    mocks.s3Send.mockResolvedValue(s3Body(REPORT));
    mocks.invokeHarnessText.mockRejectedValueOnce(new Error('throttled'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await handler(chatEvent({ messages: [{ role: 'user', content: 'q' }] }));
    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body).error).toMatch(/try again/);
    consoleError.mockRestore();
  });
});

describe('PUT /runs/{runId}/report', () => {
  const body = { markdown: '# Brief\n\n## Executive summary\n\nUp 12% YoY.', baseVersion: 1, note: 'tighten' };

  it('rejects a malformed body before touching AWS', async () => {
    expect((await handler(putEvent({ markdown: '' }))).statusCode).toBe(400);
    expect(mocks.ddbSend).not.toHaveBeenCalled();
  });

  it('404s an unknown run', async () => {
    routeDdb({ run: () => ({ Item: undefined }) });
    expect((await handler(putEvent(body))).statusCode).toBe(404);
  });

  it('403s a non-owner, non-admin caller', async () => {
    routeDdb({ run: () => runItem(), meta: () => metaItem('someone-else') });
    const response = await handler(putEvent(body));
    expect(response.statusCode).toBe(403);
    expect(mocks.s3Send).not.toHaveBeenCalled();
  });

  it('lets an admin edit a workflow they do not own', async () => {
    routeDdb({ run: () => runItem(), meta: () => metaItem('someone-else') });
    mocks.s3Send.mockResolvedValueOnce({});
    const response = await handler(
      putEvent(body, { username: 'root', 'cognito:groups': '[admin]' }),
    );
    expect(response.statusCode).toBe(200);
  });

  it('409s when the run has no report', async () => {
    routeDdb({ run: () => runItem({ reportArtifactKey: undefined }), meta: () => metaItem() });
    const response = await handler(putEvent(body));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/no report to edit/);
  });

  it('409s a stale baseVersion without writing', async () => {
    const v2Key = `artifacts/${WORKFLOW_ID}/${RUN_ID}/report.v2.md`;
    routeDdb({
      run: () =>
        runItem({
          reportArtifactKey: v2Key,
          reportVersions: [
            { version: 1, artifactKey: REPORT_KEY, savedAt: 'x' },
            { version: 2, artifactKey: v2Key, savedAt: 'y' },
          ],
        }),
      meta: () => metaItem(),
    });
    const response = await handler(putEvent({ ...body, baseVersion: 1 }));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ latestVersion: 2 });
    expect(mocks.s3Send).not.toHaveBeenCalled();
  });

  it('saves v2 as a new object, appends history, and repoints the run', async () => {
    let updateInput: Record<string, unknown> | undefined;
    routeDdb({
      run: () => runItem(),
      meta: () => metaItem(),
      update: (input) => {
        updateInput = input;
        return { Attributes: {} };
      },
    });
    mocks.s3Send.mockResolvedValueOnce({});

    const response = await handler(putEvent(body));
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);
    const v2Key = `artifacts/${WORKFLOW_ID}/${RUN_ID}/report.v2.md`;

    // New object, original untouched.
    const put = mocks.s3Send.mock.calls[0]![0] as { input: { Key: string; Body: string; ContentType: string } };
    expect(put.input.Key).toBe(v2Key);
    expect(put.input.Body).toBe(body.markdown);
    expect(put.input.ContentType).toMatch(/markdown/);

    // Run record: pointer moves, history synthesizes v1 then appends v2,
    // and the write is conditioned on the key we read.
    expect(updateInput?.ConditionExpression).toBe('reportArtifactKey = :expectedKey');
    const values = updateInput?.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':expectedKey']).toBe(REPORT_KEY);
    expect(values[':key']).toBe(v2Key);
    const versions = values[':versions'] as Array<Record<string, unknown>>;
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]).toMatchObject({ artifactKey: REPORT_KEY });
    expect(versions[1]).toMatchObject({ artifactKey: v2Key, savedBy: 'alice', note: 'tighten' });

    expect(payload.reportArtifactKey).toBe(v2Key);
    expect(payload.version).toMatchObject({ version: 2, savedBy: 'alice' });
    expect(payload.reportVersions).toHaveLength(2);
  });

  it('409s when the conditional write loses a race', async () => {
    routeDdb({
      run: () => runItem(),
      meta: () => metaItem(),
      update: () => {
        const error = new Error('conditional');
        (error as { name: string }).name = 'ConditionalCheckFailedException';
        throw error;
      },
    });
    mocks.s3Send.mockResolvedValueOnce({});
    const response = await handler(putEvent(body));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/concurrently/);
  });
});
