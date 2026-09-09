/**
 * Streaming report chat (Function URL handler) — behavioral tests over
 * runChatStream with a fake sink, fake JWT verifier, fake harness stream, and
 * mocked DynamoDB/S3. Also covers ProposalGate, the edit-fence hold-back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ddbSend: vi.fn(),
  s3Send: vi.fn(),
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
  '@agentic-platform/constructs/dist/handlers-src/lib/runtime-config',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@agentic-platform/constructs/dist/handlers-src/lib/runtime-config')
      >();
    return { ...actual, loadAgentConfig: mocks.loadAgentConfig };
  },
);
import {
  runChatStream,
  type ChatStreamSink,
  type FunctionUrlEvent,
  type JwtVerifier,
} from '../handlers-src/chat-stream';
import { ProposalGate } from '../handlers-src/lib/report-chat';

const RUN_ID = 'run-1234';
const REPORT_KEY = `artifacts/wf-1/${RUN_ID}/report.md`;
const REPORT = '# Brief\n\n## Executive summary\n\nRevenue grew 12%.\n\n## Sources\n\n- a';
const ARN = 'arn:aws:bedrock-agentcore:us-west-2:1:harness/report_chat';

class FakeSink implements ChatStreamSink {
  status?: number;
  headers?: Record<string, string>;
  chunks: string[] = [];
  ended = false;
  start(status: number, headers: Record<string, string>) {
    if (this.status !== undefined) throw new Error('start called twice');
    this.status = status;
    this.headers = headers;
  }
  write(chunk: string) {
    this.chunks.push(chunk);
  }
  end() {
    this.ended = true;
  }
  /** Parsed SSE data payloads. */
  events(): Array<Record<string, unknown>> {
    return this.chunks
      .join('')
      .split('\n\n')
      .filter((e) => e.startsWith('data: '))
      .map((e) => JSON.parse(e.slice(6)) as Record<string, unknown>);
  }
  body(): string {
    return this.chunks.join('');
  }
}

const okVerifier: JwtVerifier = { verify: async () => ({ 'cognito:username': 'alice' }) };
const badVerifier: JwtVerifier = {
  verify: async () => {
    throw new Error('Token expired');
  },
};

function event(body: unknown, overrides: Partial<FunctionUrlEvent> = {}): FunctionUrlEvent {
  return {
    rawPath: `/runs/${RUN_ID}/chat`,
    requestContext: { http: { method: 'POST' } },
    headers: { authorization: 'Bearer t0ken' },
    body: JSON.stringify(body),
    ...overrides,
  };
}
const question = { messages: [{ role: 'user', content: 'Summarize' }] };

function routeDdb(run: unknown, tasks: unknown[] = [], org: unknown = { Item: undefined }) {
  mocks.ddbSend.mockImplementation(
    async (command: { constructor: { name: string }; input: { Key?: { pk?: string } } }) => {
      if (command.constructor.name === 'QueryCommand') return { Items: tasks };
      if (command.input.Key?.pk === 'CONFIG') return org;
      return run;
    },
  );
}
const runItem = (overrides: Record<string, unknown> = {}) => ({
  Item: { runId: RUN_ID, workflowId: 'wf-1', reportArtifactKey: REPORT_KEY, plan: { tasks: [] }, ...overrides },
});

async function* deltas(...parts: string[]) {
  for (const part of parts) {
    yield part;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TABLE_NAME = 'table';
  process.env.BUCKET_NAME = 'bucket';
  process.env.REPORT_CHAT_HARNESS_ARN = ARN;
  mocks.loadAgentConfig.mockResolvedValue(undefined);
  mocks.s3Send.mockResolvedValue({ Body: { transformToString: async () => REPORT } });
});

describe('runChatStream — auth and pre-stream failures (plain JSON)', () => {
  it('accepts the token from the custom header (CloudFront OAC overwrites Authorization)', async () => {
    routeDdb(runItem());
    const sink = new FakeSink();
    const verify = vi.fn().mockResolvedValue({});
    await runChatStream(
      event(question, { headers: { 'x-agentic-token': 'cust0m', authorization: 'AWS4-HMAC-SHA256 Credential=…' } }),
      sink,
      { verifier: { verify }, invoke: vi.fn().mockReturnValue(deltas('ok')) },
    );
    // The custom header wins; the SigV4 Authorization header is ignored.
    expect(verify).toHaveBeenCalledWith('cust0m');
    expect(sink.status).toBe(200);
  });

  it('401s without a bearer token before any AWS call', async () => {
    const sink = new FakeSink();
    const invoke = vi.fn();
    await runChatStream(event(question, { headers: {} }), sink, { verifier: okVerifier, invoke });
    expect(sink.status).toBe(401);
    expect(sink.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(sink.body())).toEqual({ error: 'missing bearer token' });
    expect(mocks.ddbSend).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(sink.ended).toBe(true);
  });

  it('401s on a rejected token before any AWS call', async () => {
    const sink = new FakeSink();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runChatStream(event(question), sink, { verifier: badVerifier, invoke: vi.fn() });
    expect(sink.status).toBe(401);
    expect(JSON.parse(sink.body()).error).toMatch(/invalid or expired/);
    expect(mocks.ddbSend).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('accepts the CloudFront behavior prefix on the path', async () => {
    routeDdb(runItem());
    const sink = new FakeSink();
    const invoke = vi.fn().mockReturnValue(deltas('ok'));
    await runChatStream(event(question, { rawPath: `/chat/runs/${RUN_ID}/chat` }), sink, {
      verifier: okVerifier,
      invoke,
    });
    expect(sink.status).toBe(200);
    expect(invoke).toHaveBeenCalledTimes(1);
    // …but not arbitrary depth.
    const deep = new FakeSink();
    await runChatStream(event(question, { rawPath: `/a/b/runs/${RUN_ID}/chat` }), deep, {
      verifier: okVerifier,
      invoke: vi.fn(),
    });
    expect(deep.status).toBe(404);
  });

  it('answers CORS preflight with 204 and no auth', async () => {
    const sink = new FakeSink();
    await runChatStream(
      event(undefined, { requestContext: { http: { method: 'OPTIONS' } }, headers: {} }),
      sink,
      { verifier: badVerifier, invoke: vi.fn(), corsOrigin: 'https://app.example' },
    );
    expect(sink.status).toBe(204);
    expect(sink.headers?.['access-control-allow-origin']).toBe('https://app.example');
    expect(sink.body()).toBe('');
  });

  it('400/404/409/503 mirror the API route semantics', async () => {
    // 400 malformed body
    let sink = new FakeSink();
    await runChatStream(event({ messages: [] }), sink, { verifier: okVerifier, invoke: vi.fn() });
    expect(sink.status).toBe(400);
    // 404 bad path
    sink = new FakeSink();
    await runChatStream(event(question, { rawPath: '/nope' }), sink, { verifier: okVerifier, invoke: vi.fn() });
    expect(sink.status).toBe(404);
    // 503 no harness configured
    delete process.env.REPORT_CHAT_HARNESS_ARN;
    sink = new FakeSink();
    await runChatStream(event(question), sink, { verifier: okVerifier, invoke: vi.fn() });
    expect(sink.status).toBe(503);
    process.env.REPORT_CHAT_HARNESS_ARN = ARN;
    // 404 unknown run
    routeDdb({ Item: undefined });
    sink = new FakeSink();
    await runChatStream(event(question), sink, { verifier: okVerifier, invoke: vi.fn() });
    expect(sink.status).toBe(404);
    // 409 no report yet
    routeDdb(runItem({ reportArtifactKey: undefined }));
    sink = new FakeSink();
    await runChatStream(event(question), sink, { verifier: okVerifier, invoke: vi.fn() });
    expect(sink.status).toBe(409);
  });
});

describe('runChatStream — event stream', () => {
  it('streams deltas then a done event with the parsed reply', async () => {
    routeDdb(runItem());
    const sink = new FakeSink();
    const invoke = vi.fn().mockReturnValue(deltas('Revenue ', 'grew ', '12%.'));
    await runChatStream(event(question), sink, { verifier: okVerifier, invoke });

    expect(sink.status).toBe(200);
    expect(sink.headers?.['content-type']).toBe('text/event-stream');
    // Prelude flushed immediately so CloudFront sees bytes before the model
    // produces its first token (origin read timeout counts idle time).
    expect(sink.chunks[0]).toBe(': connected\n\n');
    // Same-origin by default: no CORS headers unless configured.
    expect(sink.headers?.['access-control-allow-origin']).toBeUndefined();
    const events = sink.events();
    // Plain answers never announce drafting.
    expect(events.some((e) => e.type === 'status')).toBe(false);
    const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    expect(text).toBe('Revenue grew 12%.');
    const done = events.find((e) => e.type === 'done')!;
    expect(done).toMatchObject({
      message: { role: 'assistant', content: 'Revenue grew 12%.' },
      reportVersion: 1,
    });
    expect(sink.ended).toBe(true);
    // Invoked the chat harness with the grounded request.
    const args = invoke.mock.calls[0]![0] as { harnessArn: string; text: string };
    expect(args.harnessArn).toBe(ARN);
    expect(args.text).toContain('# Report (version 1)');
  });

  it('never streams the edit-proposal fence; the proposal arrives in done', async () => {
    routeDdb(runItem());
    const sink = new FakeSink();
    const proposal = JSON.stringify({
      heading: '## Executive summary',
      newMarkdown: '## Executive summary\n\nUp 12% YoY.',
      rationale: 'basis',
    });
    // Fence opener split across deltas on purpose.
    const invoke = vi.fn().mockReturnValue(
      deltas('Tightened it.\n\n``', '`edit-prop', 'osal\n', proposal, '\n```'),
    );
    await runChatStream(event(question), sink, { verifier: okVerifier, invoke });

    const events = sink.events();
    const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    expect(text).not.toContain('edit-proposal');
    expect(text).not.toContain('{');
    expect(text.trim()).toBe('Tightened it.');
    // The client is told visible text has paused for drafting, exactly once,
    // after the last visible delta and before done.
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'status')).toHaveLength(1);
    expect(events.find((e) => e.type === 'status')).toEqual({ type: 'status', phase: 'drafting-edit' });
    expect(types.indexOf('status')).toBeGreaterThan(types.lastIndexOf('delta'));
    expect(types.indexOf('status')).toBeLessThan(types.indexOf('done'));
    const done = events.find((e) => e.type === 'done')!;
    expect((done.message as Record<string, unknown>).content).toBe('Tightened it.');
    expect((done.message as Record<string, unknown>).proposedEdit).toEqual({
      heading: '## Executive summary',
      newMarkdown: '## Executive summary\n\nUp 12% YoY.',
      rationale: 'basis',
    });
  });

  it('sends SSE keepalive comments while waiting on the model, then stops', async () => {
    routeDdb(runItem());
    const sink = new FakeSink();
    async function* slow() {
      await new Promise((resolve) => setTimeout(resolve, 70));
      yield 'Finally, an answer that is long enough to pass the gate.';
    }
    await runChatStream(event(question), sink, {
      verifier: okVerifier,
      invoke: vi.fn().mockReturnValue(slow()),
      keepaliveMs: 20,
    });
    const keepalives = sink.chunks.filter((c) => c === ': keepalive\n\n').length;
    expect(keepalives).toBeGreaterThanOrEqual(2);
    // Comments never reach the JSON event parser (only deltas + done).
    const types = sink.events().map((e) => e.type);
    expect(new Set(types)).toEqual(new Set(['delta', 'done']));
    expect(types[types.length - 1]).toBe('done');
    expect(sink.ended).toBe(true);
    // Interval cleared: no further writes after end.
    const after = sink.chunks.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sink.chunks.length).toBe(after);
  });

  it('emits an error event (not a 5xx) when the harness fails mid-stream', async () => {
    routeDdb(runItem());
    const sink = new FakeSink();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // eslint-disable-next-line require-yield
    async function* failing() {
      // Long enough to clear the gate's fence hold-back window.
      yield 'Here is a partial answer that was cut off mid-';
      throw new Error('throttled');
    }
    await runChatStream(event(question), sink, { verifier: okVerifier, invoke: vi.fn().mockReturnValue(failing()) });
    expect(sink.status).toBe(200); // headers already sent
    const events = sink.events();
    expect(events.some((e) => e.type === 'delta')).toBe(true);
    expect(events.find((e) => e.type === 'error')).toMatchObject({ status: 502 });
    expect(events.find((e) => e.type === 'done')).toBeUndefined();
    expect(sink.ended).toBe(true);
    consoleError.mockRestore();
  });
});

describe('ProposalGate', () => {
  function run(parts: string[]) {
    const gate = new ProposalGate();
    let visible = '';
    for (const part of parts) visible += gate.push(part);
    visible += gate.flush();
    return { visible, collected: gate.collected };
  }

  it('passes plain text through completely', () => {
    const { visible, collected } = run(['Hello ', 'world', '.']);
    expect(visible).toBe('Hello world.');
    expect(collected).toBe('Hello world.');
  });
  it('keeps ordinary code fences visible', () => {
    const { visible } = run(['See:\n```js\n', 'x()\n```\ndone']);
    expect(visible).toBe('See:\n```js\nx()\n```\ndone');
  });
  it('withholds everything from the proposal fence onward, even when split', () => {
    const { visible, collected } = run(['Answer.\n\n``', '`edit-proposal\n{"a":1}\n```']);
    expect(visible).toBe('Answer.\n\n');
    expect(collected).toBe('Answer.\n\n```edit-proposal\n{"a":1}\n```');
  });
  it('withholds when the fence arrives in a single delta', () => {
    const { visible } = run(['Answer.\n```edit-proposal\n{}\n```']);
    expect(visible).toBe('Answer.\n');
  });
});
