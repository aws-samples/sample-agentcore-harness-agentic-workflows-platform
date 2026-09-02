/**
 * news_search — standalone gateway tool Lambda (D-25 independent targets).
 * Secret: NEWSAPI_SECRET_NAME only.
 */
import { createToolHandler } from '../src/handler-factory';
import { newsSearch, type NewsSearchInput } from '../src/executors';

export const handler = createToolHandler<NewsSearchInput, unknown>({
  toolName: 'news_search',
  via: 'newsapi',
  executor: newsSearch,
});
