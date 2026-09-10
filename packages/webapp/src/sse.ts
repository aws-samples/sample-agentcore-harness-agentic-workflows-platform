/**
 * Minimal server-sent-events parser over a fetch ReadableStream. Handles
 * `data:` lines, multi-line data, blank-line event boundaries, and chunks
 * that split an event across reads. Comments (`:`) and other fields are
 * ignored — the chat stream only uses `data`.
 */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  /** Called on every raw chunk, including comment-only keepalives. */
  onChunk?: () => void,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        onChunk?.();
      }
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      // Normalize CRLF, then split on blank lines (event boundaries).
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = parseEventData(rawEvent);
        if (data !== null) {
          yield data;
        }
        boundary = buffer.indexOf('\n\n');
      }
      if (done) {
        // A final event without a trailing blank line.
        const data = parseEventData(buffer);
        if (data !== null) {
          yield data;
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Join the `data:` lines of one raw event; null when there are none. */
export function parseEventData(rawEvent: string): string | null {
  const lines = rawEvent.split('\n');
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  return data.length > 0 ? data.join('\n') : null;
}
