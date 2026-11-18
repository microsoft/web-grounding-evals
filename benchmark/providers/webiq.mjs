// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { bounded, evidenceContent, limits, metadata, record, request, resultsArray, sourceUrl,
  strings, text, weatherContent, webiqBody } from './shared.mjs';
import portable from '../freshsearch-confirmed-clock.cjs';
import normalization from './normalization.cjs';

export const providerId = 'webiq';
export const physicalRetries = 0;
export const defaultEndpoint = 'https://api.microsoft.ai/v3/search/web';
const fields = ['webResults', 'weatherResults', 'financeResults', 'newsResults'];

/** @param {import('./shared.mjs').SearchOptions} options */
export async function search(options) {
  const input = limits(options);
  const data = await request({
    providerId, endpoint: defaultEndpoint, endpointEnv: 'WEBIQ_ENDPOINT', keyEnv: 'WEBIQ_API_KEY',
    authHeader: 'x-apikey', signal: input.signal, onDiagnostics: input.onDiagnostics, body: webiqBody(input),
  });
  record(data, 'WebIQ response');
  if (!fields.some(field => Object.hasOwn(data, field))) {
    throw new Error('WebIQ response must contain a recognized results array');
  }
  const combined = fields.flatMap(field => {
    if (!Object.hasOwn(data, field)) return [];
    return resultsArray(data, field).map(value => {
      const page = record(value, `WebIQ ${field} result`);
      const structured = field === 'weatherResults' || field === 'financeResults';
      const url = sourceUrl(page.url, { optional: structured });
      if (structured && !url && !Object.keys(page).some(key => [
        'location', 'units', 'alerts', 'currentWeather', 'forecastedWeather',
        'historicalWeather', 'groundingContent', 'snippet', 'snippets', 'context',
      ].includes(key) && page[key] != null)) {
        throw new Error('WebIQ structured result must contain a source URL or evidence');
      }
      let content;
      if (field === 'financeResults') {
        if (page.context != null) record(page.context, 'WebIQ finance context');
        content = [strings(page.snippets, 'WebIQ finance snippets').join('\n\n'),
          evidenceContent(page.context, 'WebIQ finance context')].filter(Boolean).join('\n\n');
      } else if (field === 'weatherResults') {
        content = weatherContent(page);
      } else {
        const prose = text(page.content, 'WebIQ content');
        const snippet = text(page.snippet, 'WebIQ snippet');
        const grounding = page.groundingContent == null ? '' :
          text(record(page.groundingContent, 'WebIQ groundingContent').content, 'WebIQ grounding content');
        content = page.content != null ? prose :
          field === 'newsResults' && page.groundingContent?.content != null ? grounding : snippet;
      }
      const timestampFields = field === 'webResults'
        ? { datePublished: 'published', lastUpdatedAt: 'updated', dateLastCrawled: 'crawled', crawledAt: 'crawled' }
        : field === 'financeResults'
          ? { 'context.instrument.lastTradedAt': 'observed', 'context.instrument.timeLastTradedUtcInUnixMs': 'observed',
            'context.instrument.currentTimeUtcInUnixMs': 'observed' }
          : { 'answerSignals.publishedAt': 'published', 'answerSignals.lastUpdatedAt': 'updated',
            'answerSignals.crawledAt': 'crawled',
            ...(field === 'weatherResults' ? { 'currentWeather.observedAt': 'observed' } : {}) };
      return { url, content, ...(input.includeMetadata ? { metadata: metadata(providerId,
        page, timestampFields, field) } : {}) };
    });
  });
  return bounded(combined, input);
}

export async function searchFullResponse(options) {
  const input = limits(options);
  const data = await request({
    providerId, endpoint: defaultEndpoint, endpointEnv: 'WEBIQ_ENDPOINT', keyEnv: 'WEBIQ_API_KEY',
    authHeader: 'x-apikey', signal: input.signal, onDiagnostics: input.onDiagnostics,
    body: webiqBody(input),
    readResponse: response => portable.readRetainedSearchResponse(response, providerId, input),
  });
  record(data, 'WebIQ response');
  if (data.error != null || data.errors != null || data.type === 'error') {
    throw new Error('WebIQ returned an error payload');
  }
  const groups = Object.entries(data).filter(([key]) => key.endsWith('Results'));
  if (!groups.length || groups.some(([, value]) => !Array.isArray(value))) {
    throw new Error('WebIQ response must contain complete result arrays');
  }
  return normalization.mapWebIQClassicResponse(data, input.maxResults, input.maxLength);
}
