import { marked } from 'marked';
import { describe, expect, it } from 'vitest';
// Importing the component applies its marked.use configuration.
import './Markdown';

describe('Markdown strikethrough config', () => {
  it('keeps single "~" (approximately) literal instead of pairing as <del>', () => {
    const html = marked.parse(
      'a ~27% price differential — with bulk discounts (~$8 per unit)',
      { async: false },
    ) as string;
    expect(html).not.toContain('<del>');
    expect(html).toContain('~27%');
    expect(html).toContain('~$8');
  });

  it('still renders explicit double-tilde strikethrough', () => {
    const html = marked.parse('was ~~$12~~ now $9', { async: false }) as string;
    expect(html).toContain('<del>$12</del>');
  });
});
