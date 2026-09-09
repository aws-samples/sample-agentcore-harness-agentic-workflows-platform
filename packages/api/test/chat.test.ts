/**
 * Report chat handler (POST /runs/{runId}/chat) — behavioral tests over the
 * real router dispatch with the AWS surface mocked: DynamoDB (run record),
 * S3 (report artifact), and the harness data plane (invokeHarnessText).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpEvent } from '../handlers-src/lib/http';

const mocks = vi.hoisted(() => ({
  ddbSend: vi.fn(),
  s3Send: vi.fn(),
  invokeHarnessText: vi.fn(),
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

import { handler } from '../handlers-src/api-router';

const RUN_ID = 'run-1234';
const WORKFLOW_ID = 'wf-1';
const REPORT_KEY = `artifacts/${WORKFLOW_ID}/${RUN_ID}/report.md`;
const REPORT_ARN = 'arn:aws:bedrock-agentcore:ap-southeast-2:1:harness/report_generator';
const RESEARCH_ARN = 'arn:aws:bedrock-agentcore:ap-southeast-2:1:harness/web_research';

function chatEvent(body: unknown, runId = RUN_ID): HttpEvent {
  return {
    rawPath: `/runs/${runId}/chat`,
    requestContext: {
      http: { method: 'POST' },
      authorizer: { jwt: { claims: { username: 'alice' } } },
    },
    body: JSON.stringify(body),
  };
}

function runItem(overrides: Record<string, unknown> = {}) {
  return {
    Item: {
      runId: RUN_ID,
      workflowId: WORKFLOW_ID,
      status: 'succeeded',
      reportArtifactKey: REPORT_KEY,
      plan: { report: { worker: 'report_generator' } },
      ...overrides,
    },
  };
}

function s3Body(text: string) {
  return { Body: { transformToString: async () => text } };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TABLE_NAME = 'table';
  process.env.BUCKET_NAME = 'bucket';
  process.env.WORKER_HARNESS_MAP = JSON.stringify({
    web_research: RESEARCH_ARN,
    report_generator: REPORT_ARN,
  });
});

describe('POST /runs/{runId}/chat', () => {
  it('rejects a malformed body before touching AWS', async () => {
    const response = await handler(chatEvent({ messages: [] }));
    expect(response.statusCode).toBe(400);
    expect(mocks.ddbSend).not.toHaveBeenCalled();
    expect(mocks.invokeHarnessText).not.toHaveBeenCalled();
  });

  it('404s an unknown run', async () => {
    mocks.ddbSend.mockResolvedValueOnce({ Item: undefined });
    const response = await handler(
      chatEvent({ messages: [{ role: 'user', content: 'hi' }] }, 'missing'),
    );
    expect(response.statusCode).toBe(404);
    expect(mocks.invokeHarnessText).not.toHaveBeenCalled();
  });

  it('409s when the run has no report yet', async () => {
    mocks.ddbSend.mockResolvedValueOnce(
      runItem({ status: 'running', reportArtifactKey: undefined }),
    );
    const response = await handler(
      chatEvent({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/no report yet/);
    expect(mocks.s3Send).not.toHaveBeenCalled();
    expect(mocks.invokeHarnessText).not.toHaveBeenCalled();
  });

  it('answers grounded in the report using the plan report worker harness', async () => {
    mocks.ddbSend.mockResolvedValueOnce(runItem());
    mocks.s3Send.mockResolvedValueOnce(
      s3Body('# Brief\n\nRevenue grew 12% in Q2.'),
    );
    mocks.invokeHarnessText.mockResolvedValueOnce('  Revenue grew 12% in Q2.  ');

    const response = await handler(
      chatEvent({ messages: [{ role: 'user', content: 'How much did revenue grow?' }] }),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      message: { role: 'assistant', content: 'Revenue grew 12% in Q2.' },
    });

    // Report fetched from the run's own artifact key.
    const getObject = mocks.s3Send.mock.calls[0]![0] as { input: { Bucket: string; Key: string } };
    expect(getObject.input).toEqual({ Bucket: 'bucket', Key: REPORT_KEY });

    // Harness selection + prompt assembly.
    expect(mocks.invokeHarnessText).toHaveBeenCalledTimes(1);
    const args = mocks.invokeHarnessText.mock.calls[0]![0] as {
      harnessArn: string;
      sessionId: string;
      text: string;
      systemPrompt: string;
    };
    expect(args.harnessArn).toBe(REPORT_ARN);
    expect(args.sessionId.length).toBeGreaterThanOrEqual(33);
    expect(args.sessionId).toContain(RUN_ID);
    expect(args.text).toBe('How much did revenue grow?');
    expect(args.systemPrompt).toContain('Revenue grew 12% in Q2.');
    expect(args.systemPrompt).toMatch(/ONLY in the report/);
  });

  it('threads prior turns into the user message on follow-ups', async () => {
    mocks.ddbSend.mockResolvedValueOnce(runItem());
    mocks.s3Send.mockResolvedValueOnce(s3Body('# Brief'));
    mocks.invokeHarnessText.mockResolvedValueOnce('Two gaps were flagged.');

    const response = await handler(
      chatEvent({
        messages: [
          { role: 'user', content: 'Summarize the brief.' },
          { role: 'assistant', content: 'The brief covers Q2.' },
          { role: 'user', content: 'Any gaps?' },
        ],
      }),
    );

    expect(response.statusCode).toBe(200);
    const args = mocks.invokeHarnessText.mock.calls[0]![0] as { text: string };
    expect(args.text).toContain('# Conversation so far');
    expect(args.text).toContain('User: Summarize the brief.');
    expect(args.text).toContain('Assistant: The brief covers Q2.');
    expect(args.text).toContain('# New question');
    expect(args.text.trim().endsWith('Any gaps?')).toBe(true);
  });

  it('falls back to a registered worker when the plan names an unknown report worker', async () => {
    mocks.ddbSend.mockResolvedValueOnce(
      runItem({ plan: { report: { worker: 'retired_worker' } } }),
    );
    mocks.s3Send.mockResolvedValueOnce(s3Body('# Brief'));
    mocks.invokeHarnessText.mockResolvedValueOnce('ok');

    const response = await handler(
      chatEvent({ messages: [{ role: 'user', content: 'q' }] }),
    );
    expect(response.statusCode).toBe(200);
    const args = mocks.invokeHarnessText.mock.calls[0]![0] as { harnessArn: string };
    expect([RESEARCH_ARN, REPORT_ARN]).toContain(args.harnessArn);
  });

  it('truncates oversized reports before grounding', async () => {
    mocks.ddbSend.mockResolvedValueOnce(runItem());
    mocks.s3Send.mockResolvedValueOnce(s3Body('x'.repeat(70_000)));
    mocks.invokeHarnessText.mockResolvedValueOnce('ok');

    await handler(chatEvent({ messages: [{ role: 'user', content: 'q' }] }));

    const args = mocks.invokeHarnessText.mock.calls[0]![0] as { systemPrompt: string };
    expect(args.systemPrompt).toContain('[report truncated at 60000 characters]');
    expect(args.systemPrompt.length).toBeLessThan(62_000);
  });

  it('502s when the report artifact cannot be read', async () => {
    mocks.ddbSend.mockResolvedValueOnce(runItem());
    mocks.s3Send.mockRejectedValueOnce(new Error('NoSuchKey'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await handler(
      chatEvent({ messages: [{ role: 'user', content: 'q' }] }),
    );
    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body).error).toMatch(/could not load the report/);
    expect(mocks.invokeHarnessText).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('502s with a retryable message when the harness fails', async () => {
    mocks.ddbSend.mockResolvedValueOnce(runItem());
    mocks.s3Send.mockResolvedValueOnce(s3Body('# Brief'));
    mocks.invokeHarnessText.mockRejectedValueOnce(
      new Error('Harness runtime error: throttled'),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await handler(
      chatEvent({ messages: [{ role: 'user', content: 'q' }] }),
    );
    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body).error).toMatch(/try again/);
    consoleError.mockRestore();
  });
});
