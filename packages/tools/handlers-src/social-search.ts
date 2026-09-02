/**
 * social_search — standalone gateway tool Lambda (D-25 independent
 * targets). Secret: ENSEMBLEDATA_SECRET_NAME only.
 */
import { createToolHandler } from '../src/handler-factory';
import { socialSearch, type SocialSearchInput } from '../src/executors';

export const handler = createToolHandler<SocialSearchInput, unknown>({
  toolName: 'social_search',
  via: 'ensembledata',
  executor: socialSearch,
});
