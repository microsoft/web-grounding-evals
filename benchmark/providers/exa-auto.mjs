// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { bounded, limits, metadata, record, request, resultsArray, sourceUrl, text } from './shared.mjs';
import portable from '../freshsearch-confirmed-clock.cjs';
import normalization from './normalization.cjs';

export const providerId = 'exa-auto';
export const physicalRetries = 0;

/** @param {import('./shared.mjs').SearchOptions} options */
export async function search(options) {
  const input = limits(options);
  const data = await request({
    providerId, endpoint: 'https://api.exa.ai/search', keyEnv: 'EXA_API_KEY', authHeader: 'x-api-key',
    signal: input.signal, onDiagnostics: input.onDiagnostics,
    body: { query: input.query, type: 'auto', numResults: input.maxResults,
      contents: { text: { maxCharacters: input.maxLength } } },
  });
  return bounded(resultsArray(data).map(value => {
    const page = record(value, 'Exa result');
    return { url: sourceUrl(page.url), content: text(page.text, 'Exa text'),
      ...(input.includeMetadata ? { metadata: metadata(providerId, page,
        { publishedDate: 'estimated_publication' }) } : {}) };
  }), input);
}

export async function searchFullResponse(options) {
  const input = limits(options);
  const data = await request({
    providerId, endpoint: 'https://api.exa.ai/search', keyEnv: 'EXA_API_KEY', authHeader: 'x-api-key',
    signal: input.signal, onDiagnostics: input.onDiagnostics,
    body: { query: input.query, type: 'auto', numResults: input.maxResults,
      contents: { text: { maxCharacters: input.maxLength } } },
    readResponse: response => portable.readRetainedSearchResponse(response, providerId, input),
  });
  return normalization.mapExaSearchResponse(data, input.maxResults, input.maxLength, providerId);
}
