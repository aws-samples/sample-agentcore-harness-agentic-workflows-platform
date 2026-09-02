import { describe, expect, it } from 'vitest';
import { bareToolName, extractToolName } from '../src/gateway-event';

describe('bareToolName', () => {
  it('strips the target prefix', () => {
    expect(bareToolName('research-tools___tavily_search')).toBe('tavily_search');
  });
  it('passes bare names through', () => {
    expect(bareToolName('news_search')).toBe('news_search');
  });
  it('uses the LAST separator (tool names may not contain ___, targets might)', () => {
    expect(bareToolName('a___b___patent_search')).toBe('patent_search');
  });
});

describe('extractToolName', () => {
  it('reads the gateway client-context key', () => {
    expect(
      extractToolName({
        clientContext: {
          custom: { bedrockAgentCoreToolName: 'research-tools___news_search' },
        },
      }),
    ).toBe('news_search');
  });
  it('falls back to the provided default', () => {
    expect(extractToolName({}, 'tavily_search')).toBe('tavily_search');
  });
  it('throws without context or fallback', () => {
    expect(() => extractToolName(undefined)).toThrow(/tool name/);
  });
});
