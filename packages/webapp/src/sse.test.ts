import { describe, expect, it } from 'vitest';
import { parseEventData, readSseEvents } from './sse';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const data of readSseEvents(stream)) out.push(data);
  return out;
}

describe('parseEventData', () => {
  it('joins data lines and strips the optional leading space', () => {
    expect(parseEventData('data: {"a":1}')).toBe('{"a":1}');
    expect(parseEventData('data:x\ndata: y')).toBe('x\ny');
  });
  it('ignores comments and non-data fields', () => {
    expect(parseEventData(': keepalive')).toBeNull();
    expect(parseEventData('event: delta\nid: 3')).toBeNull();
    expect(parseEventData('')).toBeNull();
  });
});

describe('readSseEvents', () => {
  it('yields one payload per blank-line-delimited event', async () => {
    const events = await collect(streamOf('data: a\n\ndata: b\n\n'));
    expect(events).toEqual(['a', 'b']);
  });
  it('reassembles events split across chunks (including mid-UTF-8)', async () => {
    const events = await collect(
      streamOf('data: {"type":"del', 'ta","text":"caf', 'é"}\n', '\ndata: done\n\n'),
    );
    expect(events).toEqual(['{"type":"delta","text":"café"}', 'done']);
  });
  it('flushes a trailing event that lacks the final blank line', async () => {
    expect(await collect(streamOf('data: a\n\ndata: tail'))).toEqual(['a', 'tail']);
  });
  it('handles CRLF line endings', async () => {
    expect(await collect(streamOf('data: a\r\n\r\ndata: b\r\n\r\n'))).toEqual(['a', 'b']);
  });
});
