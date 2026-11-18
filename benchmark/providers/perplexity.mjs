// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { bounded, limits, metadata, record, request, resultsArray, sourceUrl, text } from './shared.mjs';
import portable from '../freshsearch-confirmed-clock.cjs';
import normalization from './normalization.cjs';

export const providerId = 'perplexity';
export const physicalRetries = 0;

/** @param {import('./shared.mjs').SearchOptions} options */
export async function search(options) {
  const input = limits(options);
  const data = await request({
    providerId, endpoint: 'https://api.perplexity.ai/search', keyEnv: 'PERPLEXITY_API_KEY',
    authHeader: 'Authorization', bearer: true, timeoutMs: 60000, signal: input.signal,
    onDiagnostics: input.onDiagnostics,
    body: { query: input.query, max_results: input.maxResults, search_type: 'web' },
  });
  return bounded(resultsArray(data).map(value => {
    const page = record(value, 'Perplexity result');
    return { url: sourceUrl(page.url), content: text(page.snippet, 'Perplexity snippet'),
      ...(input.includeMetadata ? { metadata: metadata(providerId, page,
        { date: 'published', last_updated: 'updated' }) } : {}) };
  }), input);
}

export async function searchFullResponse(options) {
  const input = limits(options);
  const data = await request({
    providerId, endpoint: 'https://api.perplexity.ai/search', keyEnv: 'PERPLEXITY_API_KEY',
    authHeader: 'Authorization', bearer: true, timeoutMs: 60000, signal: input.signal,
    onDiagnostics: input.onDiagnostics,
    body: { query: input.query, max_results: input.maxResults, search_context_size: 'high' },
    readResponse: response => portable.readRetainedSearchResponse(response, providerId, input),
  });
  record(data, 'Perplexity response');
  if (data.error != null || data.errors != null || data.type === 'error') {
    throw new Error('Perplexity returned an error payload');
  }
  return normalization.mapPerplexitySearchResponse(data, input.maxResults, input.maxLength);
}
