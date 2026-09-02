/**
 * patent_search — standalone gateway tool Lambda (D-25 independent
 * targets). Not registered in the example stack by default — see the
 * executorTools note in the marketing-workflow stack for how to enable
 * it. Secrets: PATENTSVIEW_SECRET_NAME, with the keyless Google Patents
 * fallback riding on TAVILY_SECRET_NAME.
 */
import { createToolHandler } from '../src/handler-factory';
import { patentSearch, type PatentSearchInput } from '../src/executors';

export const handler = createToolHandler({
  toolName: 'patent_search',
  via: (data: Awaited<ReturnType<typeof patentSearch>>) =>
    data.source === 'patentsview' ? 'patentsview' : 'web',
  executor: (input: PatentSearchInput) => patentSearch(input),
});
