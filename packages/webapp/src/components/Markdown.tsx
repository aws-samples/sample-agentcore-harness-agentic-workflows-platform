import DOMPurify from 'dompurify';
import { marked, type Tokens } from 'marked';
import { useMemo } from 'react';

// Agent reports use "~" for "approximately" (~27%, ~$8). marked's GFM
// strikethrough pairs SINGLE tildes too, so two approximations in one
// paragraph render everything between them as <del>. Restrict
// strikethrough to the explicit double-tilde form.
marked.use({
  tokenizer: {
    del(src: string): Tokens.Del | undefined {
      const match = /^~~(?=\S)([\s\S]*?\S)~~/.exec(src);
      if (!match) {
        return undefined; // single "~" stays literal text
      }
      return {
        type: 'del',
        raw: match[0],
        text: match[1]!,
        tokens: this.lexer.inlineTokens(match[1]!),
      };
    },
  },
});

/**
 * Markdown → sanitised HTML. The ONLY path by which model-authored text
 * (reports, chat answers, edit proposals, review diffs) becomes DOM: marked
 * renders, DOMPurify strips anything executable. Inline <del>/<ins> from the
 * review diff survive because they are on DOMPurify's default allow-list.
 * Exported so the sanitiser is tested, not trusted (threat model T003).
 */
export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    // Beyond DOMPurify's defaults (which already drop scripts, event
    // handlers, and javascript: URLs): reports never need inline styles or
    // form controls, and injected `style="position:fixed…"` could overlay the
    // review's Save button — found by the sanitiser regression test.
    FORBID_ATTR: ['style'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea'],
  });
}

/** Rendered, sanitized markdown. */
export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
