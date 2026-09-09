/**
 * Per-tool handler tests (D-25 independent targets): each gateway tool is
 * its own Lambda wrapping one executor via createToolHandler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler as newsSearch } from '../handlers-src/news-search';
import { handler as patentSearch } from '../handlers-src/patent-search';
import { handler as socialSearch } from '../handlers-src/social-search';
import { resetKeyCache } from '../src/secrets';

function gatewayContext(target: string, tool: string) {
  return {
    clientContext: {
      custom: { bedrockAgentCoreToolName: `${target}___${tool}` },
    },
  };
}

beforeEach(() => {
  resetKeyCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('news_search handler', () => {
  it('executes with the gateway-prefixed tool name and returns the house shape', async () => {
    vi.stubEnv('NEWSAPI_API_KEY', 'news-key');
    resetKeyCache();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ articles: [{ title: 'hit' }] }), { status: 200 }),
    );
    const result = await newsSearch(
      { query: 'prosecco' },
      gatewayContext('NewsSearchTarget1234', 'news_search'),
    );
    expect(result.success).toBe(true);
    expect(result.via).toBe('newsapi');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get('q')).toBe('prosecco');
  });

  it('works without gateway client context (direct invocation)', async () => {
    vi.stubEnv('NEWSAPI_API_KEY', 'news-key');
    resetKeyCache();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ articles: [] }), { status: 200 }),
    );
    const result = await newsSearch({ query: 'x' }, undefined);
    expect(result.success).toBe(true);
  });

  it('rejects a mismatched gateway tool name loudly', async () => {
    const result = await newsSearch(
      { query: 'x' },
      gatewayContext('Wrong', 'tavily_search'),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('serves only "news_search"');
  });

  it('reports missing keys with remediation guidance, never throws', async () => {
    const result = await newsSearch({ query: 'x' }, undefined);
    expect(result.success).toBe(false);
    expect(result.error).toContain('NEWSAPI');
  });
});

describe('handler error shaping', () => {
  it('surfaces upstream API errors as structured content', async () => {
    vi.stubEnv('NEWSAPI_API_KEY', 'news-key');
    resetKeyCache();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 429, statusText: 'Too Many Requests' }),
    );
    const result = await newsSearch({ query: 'x' }, undefined);
    expect(result.success).toBe(false);
    expect(result.error).toContain('429');
  });
});

describe('social_search handler', () => {
  it('dispatches to the EnsembleData TikTok keyword endpoint with slimmed posts', async () => {
    vi.stubEnv('ENSEMBLEDATA_API_KEY', 'ed-token');
    resetKeyCache();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            data: [
              {
                aweme_info: {
                  desc: 'best aussie shiraz haul',
                  author: { unique_id: 'winefan' },
                  statistics: { play_count: 12000, digg_count: 800 },
                  create_time: 1756600000,
                  share_url: 'https://tiktok.com/@winefan/video/1',
                },
              },
            ],
            nextCursor: 20,
          },
        }),
        { status: 200 },
      ),
    );
    const result = await socialSearch(
      { platform: 'tiktok', query: 'australian red wine', period: 60, country: 'au' },
      gatewayContext('SocialSearchTarget1234', 'social_search'),
    );
    expect(result.success).toBe(true);
    expect(result.via).toBe('ensembledata');
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/apis/tt/keyword/search');
    expect(url.searchParams.get('name')).toBe('australian red wine');
    expect(url.searchParams.get('period')).toBe('90'); // 60 snaps up to 90
    expect(url.searchParams.get('country')).toBe('AU');
    const data = result.data as {
      posts: Array<{ text?: string; author?: string; stats?: Record<string, number> }>;
      nextCursor?: unknown;
    };
    expect(data.posts[0]).toMatchObject({
      text: 'best aussie shiraz haul',
      author: 'winefan',
      stats: { views: 12000, likes: 800 },
    });
    expect(data.nextCursor).toBe(20);
  });

  it('maps each platform to its verified endpoint', async () => {
    vi.stubEnv('ENSEMBLEDATA_API_KEY', 'ed-token');
    resetKeyCache();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { data: [] } }), { status: 200 }),
    );
    await socialSearch({ platform: 'instagram', query: 'example' }, undefined);
    await socialSearch({ platform: 'youtube', query: 'example review' }, undefined);
    await socialSearch({ platform: 'threads', query: 'example' }, undefined);
    const urls = fetchMock.mock.calls.map((call) => new URL(String(call[0])));
    expect(urls[0]!.pathname).toBe('/apis/instagram/search');
    expect(urls[0]!.searchParams.get('text')).toBe('example');
    expect(urls[1]!.pathname).toBe('/apis/youtube/search');
    expect(urls[1]!.searchParams.get('keyword')).toBe('example review');
    expect(urls[2]!.pathname).toBe('/apis/threads/keyword/search');
    expect(urls[2]!.searchParams.get('name')).toBe('example');
  });

  it('falls back to TikTok hashtag search when the keyword index is empty (live finding)', async () => {
    vi.stubEnv('ENSEMBLEDATA_API_KEY', 'ed-token');
    resetKeyCache();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { data: [] } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              data: [
                {
                  desc: 'red wine tasting',
                  author: { unique_id: 'sommelier' },
                  statistics: { play_count: 500 },
                },
              ],
              nextCursor: 20,
            },
          }),
          { status: 200 },
        ),
      );
    const result = await socialSearch(
      { platform: 'tiktok', query: 'australian red wine' },
      undefined,
    );
    expect(result.success).toBe(true);
    const data = result.data as { posts: unknown[]; note?: string };
    expect(data.posts).toHaveLength(1);
    expect(data.note).toContain('#australianredwine');
    const fallbackUrl = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(fallbackUrl.pathname).toBe('/apis/tt/hashtag/posts');
    expect(fallbackUrl.searchParams.get('name')).toBe('australianredwine');
  });

  it('reports a missing EnsembleData key with remediation guidance', async () => {
    const result = await socialSearch({ platform: 'tiktok', query: 'x' }, undefined);
    expect(result.success).toBe(false);
    expect(result.error).toContain('ENSEMBLEDATA');
  });

  it('rejects unsupported platforms', async () => {
    vi.stubEnv('ENSEMBLEDATA_API_KEY', 'ed-token');
    resetKeyCache();
    const result = await socialSearch({ platform: 'linkedin', query: 'x' }, undefined);
    expect(result.success).toBe(false);
    expect(result.error).toContain('unsupported platform');
  });

  it('projects Instagram discovery results (hashtags/accounts/places) into non-empty posts (live finding)', async () => {
    // Live-verified response shape: /instagram/search returns three parallel
    // arrays under the envelope, each entry carrying a `position` rank. The
    // old generic slimmer projected every entry to {} because none of the
    // TikTok/YouTube/Threads unwrap keys apply here.
    vi.stubEnv('ENSEMBLEDATA_API_KEY', 'ed-token');
    resetKeyCache();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            hashtags: [
              {
                position: 0,
                hashtag: { name: 'australianredwine', media_count: 3910, id: 1 },
              },
              { position: 4, hashtag: { name: 'australianredwines', media_count: 181 } },
            ],
            users: [
              {
                position: 2,
                user: {
                  username: 'penfolds',
                  full_name: 'Penfolds Wines',
                  follower_count: 250000,
                },
              },
            ],
            places: [
              { position: 5, place: { name: 'Barossa Valley', location: { pk: 42 } } },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const result = await socialSearch(
      { platform: 'instagram', query: 'australian red wine', maxResults: 5 },
      undefined,
    );
    expect(result.success).toBe(true);
    const data = result.data as {
      resultCount: number;
      posts: Array<{
        text?: string;
        author?: string;
        url?: string;
        stats?: Record<string, number>;
      }>;
      note?: string;
    };
    // All four entries have real content — nothing should slim to {}.
    expect(data.resultCount).toBe(4);
    expect(data.posts.every((post) => Object.keys(post).length > 0)).toBe(true);
    // Interleaved by position: hashtag(0), user(2), hashtag(4), place(5).
    expect(data.posts[0]).toMatchObject({
      text: '#australianredwine',
      url: 'https://www.instagram.com/explore/tags/australianredwine/',
      stats: { mediaCount: 3910 },
    });
    expect(data.posts[1]).toMatchObject({
      author: 'penfolds',
      text: 'Penfolds Wines',
      url: 'https://www.instagram.com/penfolds/',
      stats: { followers: 250000 },
    });
    expect(data.posts[2]).toMatchObject({ text: '#australianredwines' });
    expect(data.posts[3]).toMatchObject({
      text: 'place: Barossa Valley',
      url: 'https://www.instagram.com/explore/locations/42/',
    });
    expect(data.note).toContain('brand-presence discovery');
  });

  it('filters slim entries that carry no usable content so resultCount is honest', async () => {
    // YouTube search interleaves videoRenderer entries with playlist/channel
    // cards that our unwrap logic doesn't recognise. Previously they became
    // {} and inflated resultCount; now they're dropped before slicing.
    vi.stubEnv('ENSEMBLEDATA_API_KEY', 'ed-token');
    resetKeyCache();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            data: [
              {
                videoRenderer: {
                  title: { runs: [{ text: 'Real Video' }] },
                  ownerText: { runs: [{ text: 'A Channel' }] },
                  videoId: 'abc123',
                  viewCountText: { simpleText: '1,234 views' },
                },
              },
              { playlistRenderer: { title: { simpleText: 'A playlist card' } } },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const result = await socialSearch(
      { platform: 'youtube', query: 'anything' },
      undefined,
    );
    expect(result.success).toBe(true);
    const data = result.data as { resultCount: number; posts: unknown[] };
    expect(data.resultCount).toBe(1);
    expect(data.posts).toHaveLength(1);
  });
});

describe('patent_search handler (shipped but not registered by default)', () => {
  it('falls back to Google Patents web search without a PatentsView key', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'tavily-key');
    resetKeyCache();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: 'Wine sensor patent',
              url: 'https://patents.google.com/patent/US1',
              content: 'A sensor for wine fermentation.',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await patentSearch({ keywords: ['wine', 'sensor'] }, undefined);
    expect(result.success).toBe(true);
    expect(result.via).toBe('web');
    const data = result.data as { source: string; patents: Array<{ title?: string }> };
    expect(data.source).toBe('web');
    expect(data.patents[0]?.title).toBe('Wine sensor patent');
  });
});
