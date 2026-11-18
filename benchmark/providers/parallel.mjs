// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { bounded, limits, metadata, record, request, resultsArray, sourceUrl, strings } from './shared.mjs';
import portable from '../freshsearch-confirmed-clock.cjs';
import normalization from './normalization.cjs';

export const providerId = 'parallel';
export const physicalRetries = 0;

/** @param {import('./shared.mjs').SearchOptions} options */
export async function search(options) {
  const input = limits(options);
  const data = await request({
    providerId, endpoint: 'https://api.parallel.ai/v1/search', keyEnv: 'PARALLEL_API_KEY',
    authHeader: 'x-api-key', signal: input.signal, onDiagnostics: input.onDiagnostics,
    body: { objective: input.query, search_queries: [input.query], mode: 'advanced',
      max_chars_total: input.maxResults * input.maxLength,
      // Omitting fetch_policy selects Parallel's indexed/cache-only Search policy.
      advanced_settings: { max_results: input.maxResults } },
  });
  return bounded(resultsArray(data).map(value => {
    const page = record(value, 'Parallel result');
    return { url: sourceUrl(page.url), content: strings(page.excerpts, 'Parallel excerpts').join('\n\n'),
      ...(input.includeMetadata ? { metadata: metadata(providerId, page,
        { publish_date: 'published' }) } : {}) };
  }), input);
}

export async function searchFullResponse(options) {
  const input = limits(options);
  const data = await request({
    providerId, endpoint: 'https://api.parallel.ai/v1/search', keyEnv: 'PARALLEL_API_KEY',
    authHeader: 'x-api-key', signal: input.signal, onDiagnostics: input.onDiagnostics,
    body: { objective: input.query, search_queries: [input.query], mode: 'advanced',
      max_chars_total: input.maxResults * input.maxLength,
      advanced_settings: { max_results: input.maxResults } },
    readResponse: response => portable.readRetainedSearchResponse(response, providerId, input),
  });
  return normalization.mapParallelSearchResponse(data, input.maxResults, input.maxLength);
}
