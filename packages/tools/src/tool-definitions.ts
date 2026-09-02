/**
 * MCP tool schemas for the Gateway targets — names, descriptions, and
 * input schemas kept stable so agent prompts referencing these tools keep
 * working unchanged.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'tavily_search',
    description:
      'Search the web for current information. Use this to supplement your knowledge with recent data points, news, or statistics. Do NOT rely on this as your primary source — use your expert knowledge first, then search to verify or enrich specific claims.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'news_search',
    description:
      'Search recent news articles via NewsAPI. Returns headlines, sources, publish dates, and article snippets for a query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'News search query' },
        maxResults: { type: 'number', description: 'Max articles (default 10)' },
        sortBy: {
          type: 'string',
          enum: ['relevancy', 'publishedAt', 'popularity'],
          description: 'Sort order (default: relevancy)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'social_search',
    description:
      'Search social media by keyword via EnsembleData. TikTok, YouTube, and Threads return posts with text, author, engagement stats (views/likes/comments/shares), and URLs — TikTok falls back to hashtag search when the keyword index is sparse. Instagram returns matching accounts and hashtags (brand-presence discovery), not posts. Use for consumer sentiment, brand mentions, trends, and campaign signals.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: ['tiktok', 'instagram', 'youtube', 'threads'],
          description: 'Which social platform to search',
        },
        query: { type: 'string', description: 'Keyword or phrase to search for' },
        period: {
          type: 'number',
          description:
            'Lookback window in days — TikTok only, snapped to 1/7/30/90/180 (default 90)',
        },
        country: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code, e.g. AU — TikTok only',
        },
        maxResults: { type: 'number', description: 'Max posts (default 10, cap 20)' },
      },
      required: ['platform', 'query'],
    },
  },
  {
    name: 'patent_search',
    description:
      'Search patents by company and/or keywords. Uses the PatentsView PatentSearch API when configured, with a keyless Google Patents web-search fallback. Results include title, URL, abstract snippet, date, and assignee.',
    inputSchema: {
      type: 'object',
      properties: {
        companyName: { type: 'string', description: 'Assignee organization name' },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Technology keywords',
        },
        maxResults: { type: 'number', description: 'Max patents (default 10)' },
      },
    },
  },
];

export function toolDefinition(name: string): ToolDefinition {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (!definition) {
    throw new Error(`Unknown tool definition: ${name}`);
  }
  return definition;
}
