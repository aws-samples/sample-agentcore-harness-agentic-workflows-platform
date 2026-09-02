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

/** Rendered, sanitized markdown. */
export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
