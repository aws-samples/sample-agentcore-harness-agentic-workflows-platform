/**
 * Tool executor logic — plain functions (no classes) sized for the
 * Gateway Lambda runtime, with two-tier fallback semantics where a
 * keyless fallback exists.
 *
 * Included: tavily_search, news_search, patent_search
 * (PatentsView native → Google Patents web fallback). browser_fetch_url is
 * NOT ported — it is a native harness built-in tool (agentcore_browser) in
 * the target architecture.
 */
import { fetchWithTimeout, lookupApiKey } from './secrets';

// ── tavily_search (from tavily-search.ts) ─────────────────────────────────

export interface TavilySearchInput {
  query: string;
  maxResults?: number;
}

export async function tavilySearch(input: TavilySearchInput): Promise<unknown> {
  const apiKey = await lookupApiKey({
    envVar: 'TAVILY_API_KEY',
    secretName: process.env.TAVILY_SECRET_NAME,
  });
  if (!apiKey) {
    throw new Error(
      'tavily_search: API key not configured (set TAVILY_API_KEY or TAVILY_SECRET_NAME)',
    );
  }
  const response = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: input.query,
      max_results: input.maxResults ?? 5,
      include_answer: true,
    }),
  });
  if (!response.ok) {
    throw new Error(`Tavily API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// ── news_search (from news-search.ts) ─────────────────────────────────────

export interface NewsSearchInput {
  query: string;
  maxResults?: number;
  sortBy?: 'relevancy' | 'publishedAt' | 'popularity';
}

export async function newsSearch(input: NewsSearchInput): Promise<unknown> {
  const apiKey = await lookupApiKey({
    envVar: 'NEWSAPI_API_KEY',
    secretName: process.env.NEWSAPI_SECRET_NAME,
  });
  if (!apiKey) {
    throw new Error(
      'news_search: API key not configured (set NEWSAPI_API_KEY or NEWSAPI_SECRET_NAME)',
    );
  }
  const params = new URLSearchParams({
    q: input.query,
    pageSize: String(input.maxResults ?? 10),
    sortBy: input.sortBy ?? 'relevancy',
    apiKey,
  });
  const response = await fetchWithTimeout(
    `https://newsapi.org/v2/everything?${params.toString()}`,
  );
  if (!response.ok) {
    throw new Error(`NewsAPI error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// ── social_search (EnsembleData: TikTok / Instagram / YouTube / Threads) ──

const ED_BASE_URL = 'https://ensembledata.com/apis';
/** TikTok keyword search accepts only these lookback buckets (days). */
const ED_TIKTOK_PERIODS = [0, 1, 7, 30, 90, 180] as const;
const SOCIAL_PLATFORMS = ['tiktok', 'instagram', 'youtube', 'threads'] as const;

export interface SocialSearchInput {
  platform: (typeof SOCIAL_PLATFORMS)[number];
  query: string;
  /** Lookback window in days (TikTok only; snapped up to 0/1/7/30/90/180). */
  period?: number;
  /** ISO 3166-1 alpha-2 country code (TikTok only). */
  country?: string;
  maxResults?: number;
}

interface SocialPost {
  text?: string;
  author?: string;
  url?: string;
  createdAt?: string;
  stats?: Record<string, number>;
}

/**
 * Keyword search across social platforms via the EnsembleData API
 * (endpoint paths and parameter names verified against the official
 * Node SDK, EnsembleData/ensembledata-node client.js):
 *   tiktok    GET /tt/keyword/search?name=&period=&country=
 *   instagram GET /instagram/search?text=
 *   youtube   GET /youtube/search?keyword=&depth=1
 *   threads   GET /threads/keyword/search?name=
 * Auth is a `token` query parameter. Responses are slimmed to an
 * LLM-friendly post list — raw social payloads run to hundreds of KB.
 */
export async function socialSearch(input: SocialSearchInput): Promise<{
  platform: string;
  query: string;
  resultCount: number;
  posts: SocialPost[];
  note?: string;
  nextCursor?: unknown;
}> {
  if (!SOCIAL_PLATFORMS.includes(input.platform)) {
    throw new Error(
      `social_search: unsupported platform "${input.platform}" (one of: ${SOCIAL_PLATFORMS.join(', ')})`,
    );
  }
  if (!input.query || input.query.trim().length === 0) {
    throw new Error('social_search: query is required');
  }
  const token = await lookupApiKey({
    envVar: 'ENSEMBLEDATA_API_KEY',
    secretName: process.env.ENSEMBLEDATA_SECRET_NAME,
  });
  if (!token) {
    throw new Error(
      'social_search: API key not configured (set ENSEMBLEDATA_API_KEY or ENSEMBLEDATA_SECRET_NAME)',
    );
  }

  const query = input.query.trim();
  let path: string;
  const params = new URLSearchParams({ token });
  switch (input.platform) {
    case 'tiktok': {
      path = '/tt/keyword/search';
      params.set('name', query);
      const requested = input.period ?? 90;
      const period =
        ED_TIKTOK_PERIODS.find((bucket) => bucket >= requested) ?? 180;
      params.set('period', String(period));
      if (input.country) {
        params.set('country', input.country.toUpperCase());
      }
      break;
    }
    case 'instagram':
      path = '/instagram/search';
      params.set('text', query);
      break;
    case 'youtube':
      path = '/youtube/search';
      params.set('keyword', query);
      params.set('depth', '1');
      break;
    case 'threads':
      path = '/threads/keyword/search';
      params.set('name', query);
      break;
  }

  let { envelope, items } = await fetchSocialPage(path, params);
  let via: string | undefined;

  // TikTok's keyword index is sparse (multi-word and niche queries often
  // return zero even when hashtag content exists — live finding). Fall back
  // to hashtag search on the space-stripped query before reporting empty.
  if (items.length === 0 && input.platform === 'tiktok') {
    const hashtag = query.replace(/\s+/g, '').toLowerCase();
    const fallbackParams = new URLSearchParams({ token, name: hashtag, cursor: '0' });
    const fallback = await fetchSocialPage('/tt/hashtag/posts', fallbackParams);
    if (fallback.items.length > 0) {
      ({ envelope, items } = fallback);
      via = `tiktok hashtag #${hashtag} (keyword search returned no posts)`;
    }
  }

  const max = Math.min(Math.max(input.maxResults ?? 10, 1), 20);
  const posts = items.slice(0, max).map(slimSocialPost);
  return {
    platform: input.platform,
    query,
    resultCount: posts.length,
    posts,
    ...(via ? { note: via } : {}),
    ...(envelope['nextCursor'] !== undefined
      ? { nextCursor: envelope['nextCursor'] }
      : {}),
  };
}

async function fetchSocialPage(
  path: string,
  params: URLSearchParams,
): Promise<{ envelope: Record<string, unknown>; items: unknown[] }> {
  const response = await fetchWithTimeout(`${ED_BASE_URL}${path}?${params.toString()}`);
  const body = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!response.ok) {
    const detail =
      body && typeof body['detail'] === 'string' ? `: ${body['detail']}` : '';
    throw new Error(
      `EnsembleData API error: ${response.status} ${response.statusText}${detail}`,
    );
  }
  const envelope = (body?.['data'] ?? body ?? {}) as Record<string, unknown>;
  return { envelope, items: findPostArray(envelope) };
}

/** The post list lives at data.data (tiktok/threads) or in a named array. */
function findPostArray(envelope: Record<string, unknown>): unknown[] {
  if (Array.isArray(envelope)) {
    return envelope;
  }
  if (Array.isArray(envelope['data'])) {
    return envelope['data'] as unknown[];
  }
  for (const value of Object.values(envelope)) {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
      return value;
    }
  }
  return [];
}

/**
 * Unwrap the platform-specific nesting around a post (live-verified shapes):
 * TikTok keyword rows nest under `aweme_info`, YouTube search under
 * `videoRenderer`, Threads under `node.thread.thread_items[].post`.
 */
function unwrapPost(item: unknown): Record<string, any> {
  const post = (item ?? {}) as Record<string, any>;
  if (post.aweme_info) {
    return post.aweme_info;
  }
  if (post.videoRenderer) {
    return post.videoRenderer;
  }
  const threadsPost = post.node?.thread?.thread_items?.[0]?.post;
  if (threadsPost) {
    return threadsPost;
  }
  return post;
}

/** Best-effort field picker across the four platforms' post shapes. */
function slimSocialPost(item: unknown): SocialPost {
  const node = unwrapPost(item);
  const author = node.author ?? node.user ?? node.owner ?? {};
  const stats = node.statistics ?? node.stats ?? {};
  const text =
    firstString(
      node.desc,
      node.caption?.text,
      node.text,
      node.title,
      // YouTube title/snippet shapes: { runs: [{ text }] } / { simpleText }
      joinRuns(node.title),
      joinRuns(node.descriptionSnippet),
    ) ?? firstString(node.snippet, node.description);
  const created =
    typeof node.create_time === 'number'
      ? new Date(node.create_time * 1000).toISOString()
      : (typeof node.taken_at === 'number'
          ? new Date(node.taken_at * 1000).toISOString()
          : firstString(
              node.taken_at,
              node.published_at,
              node.publishedTimeText?.simpleText,
            ));
  const numeric = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : undefined;
  const slimStats: Record<string, number> = {};
  for (const [from, to] of [
    ['play_count', 'views'],
    ['view_count', 'views'],
    ['digg_count', 'likes'],
    ['like_count', 'likes'],
    ['comment_count', 'comments'],
    ['share_count', 'shares'],
  ] as const) {
    const value = numeric(stats[from]) ?? numeric(node[from]);
    if (value !== undefined && slimStats[to] === undefined) {
      slimStats[to] = value;
    }
  }
  // YouTube exposes views as display text, e.g. "12,345 views".
  if (slimStats.views === undefined) {
    const viewText = firstString(node.viewCountText?.simpleText);
    const digits = viewText?.replace(/[^0-9]/g, '');
    if (digits) {
      slimStats.views = Number(digits);
    }
  }
  const url =
    firstString(node.share_url, node.url, node.link, node.permalink) ??
    (typeof node.videoId === 'string'
      ? `https://www.youtube.com/watch?v=${node.videoId}`
      : undefined) ??
    (typeof node.code === 'string' // Threads post shortcode
      ? `https://www.threads.net/post/${node.code}`
      : undefined);
  const authorName = firstString(
    author.unique_id,
    author.username,
    author.nickname,
    author.name,
    joinRuns(node.ownerText), // YouTube channel name
  );
  return {
    ...(text ? { text: text.slice(0, 400) } : {}),
    ...(authorName ? { author: authorName } : {}),
    ...(url ? { url } : {}),
    ...(created ? { createdAt: created } : {}),
    ...(Object.keys(slimStats).length > 0 ? { stats: slimStats } : {}),
  };
}

/** Join YouTube's `{ runs: [{ text }] }` rich-text shape into a string. */
function joinRuns(value: unknown): string | undefined {
  const runs = (value as { runs?: Array<{ text?: string }> } | undefined)?.runs;
  if (!Array.isArray(runs)) {
    return undefined;
  }
  const joined = runs.map((run) => run?.text ?? '').join('');
  return joined.length > 0 ? joined : undefined;
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

// ── patent_search (from patent-search.ts, two-tier) ───────────────────────

const DEFAULT_PATENTSVIEW_URL = 'https://search.patentsview.org/api/v1/patent/';

export interface PatentSearchInput {
  companyName?: string;
  keywords?: string[];
  maxResults?: number;
}

export interface PatentRow {
  title?: string;
  url?: string;
  snippet: string;
  date?: string;
  assignee?: string;
}

export async function patentSearch(input: PatentSearchInput): Promise<{
  source: 'patentsview' | 'web';
  resultCount: number;
  patents: PatentRow[];
  warning?: string;
}> {
  const { companyName, keywords = [], maxResults = 10 } = input ?? {};
  const terms = [companyName, ...keywords].filter(
    (t): t is string => !!t && t.trim().length > 0,
  );
  if (terms.length === 0) {
    throw new Error('patent_search: provide companyName and/or keywords');
  }

  const pvKey = await lookupApiKey({
    envVar: 'PATENTSVIEW_API_KEY',
    secretName: process.env.PATENTSVIEW_SECRET_NAME,
  });

  if (pvKey) {
    try {
      const rows = await patentsViewSearch(terms, companyName, maxResults, pvKey);
      return { source: 'patentsview', resultCount: rows.length, patents: rows };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const rows = await googlePatentsFallback(terms, maxResults);
      return {
        source: 'web',
        resultCount: rows.length,
        patents: rows,
        warning: `patentsview: ${reason} (fell back to Google Patents web search)`,
      };
    }
  }

  const rows = await googlePatentsFallback(terms, maxResults);
  return { source: 'web', resultCount: rows.length, patents: rows };
}

async function patentsViewSearch(
  terms: string[],
  companyName: string | undefined,
  maxResults: number,
  apiKey: string,
): Promise<PatentRow[]> {
  const text = terms.join(' ');
  const textClause = {
    _or: [
      { _text_any: { patent_title: text } },
      { _text_any: { patent_abstract: text } },
    ],
  };
  const q = companyName
    ? {
        _and: [
          textClause,
          { _text_any: { 'assignees.assignee_organization': companyName } },
        ],
      }
    : textClause;

  const params = new URLSearchParams({
    q: JSON.stringify(q),
    f: JSON.stringify([
      'patent_id',
      'patent_title',
      'patent_date',
      'patent_abstract',
      'assignees.assignee_organization',
    ]),
    o: JSON.stringify({ size: Math.min(Math.max(maxResults, 1), 25) }),
    s: JSON.stringify([{ patent_date: 'desc' }]),
  });
  const base = (process.env.PATENTSVIEW_API_URL ?? DEFAULT_PATENTSVIEW_URL).replace(
    /\/?$/,
    '/',
  );
  const response = await fetchWithTimeout(`${base}?${params.toString()}`, {
    headers: { Accept: 'application/json', 'X-Api-Key': apiKey },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`PatentSearch API HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  let parsed: { patents?: unknown[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `PatentSearch API returned non-JSON (content-type: ${response.headers.get('content-type')}): ${body.slice(0, 120)}`,
    );
  }
  const patents = Array.isArray(parsed.patents) ? parsed.patents : [];
  return patents.map((p) => {
    const pat = p as Record<string, any>;
    const id = typeof pat.patent_id === 'string' ? pat.patent_id : undefined;
    const assignee = Array.isArray(pat.assignees)
      ? pat.assignees
          .map((a: any) => a?.assignee_organization)
          .filter(Boolean)
          .join('; ')
      : undefined;
    const abstract =
      typeof pat.patent_abstract === 'string' ? pat.patent_abstract : '';
    return {
      title: typeof pat.patent_title === 'string' ? pat.patent_title : undefined,
      ...(id ? { url: `https://patents.google.com/patent/US${id}` } : {}),
      snippet: abstract.slice(0, 500),
      ...(typeof pat.patent_date === 'string' ? { date: pat.patent_date } : {}),
      ...(assignee ? { assignee } : {}),
    };
  });
}

/** Keyless fallback: site-scoped Tavily search against patents.google.com. */
async function googlePatentsFallback(
  terms: string[],
  maxResults: number,
): Promise<PatentRow[]> {
  const query = `${terms.join(' ')} site:patents.google.com`.slice(0, 200);
  const data = (await tavilySearch({
    query,
    maxResults: Math.min(Math.max(maxResults, 1), 10),
  })) as { results?: unknown[] };
  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    const snippetRaw =
      (typeof row.content === 'string' && row.content) ||
      (typeof row.text === 'string' && row.text) ||
      '';
    return {
      ...(typeof row.title === 'string' ? { title: row.title } : {}),
      ...(typeof row.url === 'string' ? { url: row.url } : {}),
      snippet: snippetRaw.slice(0, 500),
      ...(typeof row.publishedDate === 'string'
        ? { date: row.publishedDate }
        : {}),
    };
  });
}
