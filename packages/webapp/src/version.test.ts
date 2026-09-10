import { describe, expect, it } from 'vitest';
import { bundleInHtml, isBundleStale } from './version';

const html = (bundle: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="/${bundle}"></script>` +
  `<link rel="stylesheet" href="/assets/index-CeVyhKBg.css"></head><body><div id="root"></div></body></html>`;

const fetchReturning = (status: number, body: string): typeof fetch =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

describe('bundle version detection', () => {
  it('reads the hashed entry bundle out of index.html', () => {
    expect(bundleInHtml(html('assets/index-B_6eEunk.js'))).toBe('assets/index-B_6eEunk.js');
    expect(bundleInHtml('<html></html>')).toBeNull();
  });

  it('is stale only when the live index names a different bundle', async () => {
    const running = 'assets/index-B_6eEunk.js';
    expect(await isBundleStale(running, fetchReturning(200, html(running)))).toBe(false);
    expect(await isBundleStale(running, fetchReturning(200, html('assets/index-Zz9new.js')))).toBe(true);
  });

  it('never reports stale on fetch problems (no false reload prompts offline)', async () => {
    const running = 'assets/index-B_6eEunk.js';
    expect(await isBundleStale(running, fetchReturning(503, ''))).toBe(false);
    expect(await isBundleStale(running, fetchReturning(200, 'maintenance page'))).toBe(false);
    const failing = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    expect(await isBundleStale(running, failing)).toBe(false);
  });
});
