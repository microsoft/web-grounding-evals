// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { bounded, evidenceContent, limits, metadata, record, request, resultsArray, sourceUrl,
  text, weatherContent, webiqBody } from './shared.mjs';
import portable from '../freshsearch-confirmed-clock.cjs';
import normalization from './normalization.cjs';

export const providerId = 'webiq-auto';
export const physicalRetries = 0;
export const defaultEndpoint = 'https://api.microsoft.ai/v3/auto';

/** @param {import('./shared.mjs').SearchOptions} options */
export async function search(options) {
  const input = limits(options);
  const data = await request({
    providerId, endpoint: defaultEndpoint, endpointEnv: 'WEBIQ_AUTO_ENDPOINT', keyEnv: 'WEBIQ_API_KEY',
    authHeader: 'x-apikey', signal: input.signal, onDiagnostics: input.onDiagnostics, body: webiqBody(input),
  });
  return bounded(resultsArray(data).map(value => {
    const page = record(value, 'WebIQ Auto result');
    const evidence = record(page.evidence, 'WebIQ Auto evidence');
    const type = text(evidence.type, 'WebIQ Auto evidence type');
    if (!type) throw new Error('WebIQ Auto evidence type is missing');
    if (!Array.isArray(page.citations)) throw new Error('WebIQ Auto citations must be an array');
    const structured = type !== 'text';
    if (type === 'structured/weather' && evidence.content != null) {
      record(evidence.content, 'WebIQ Auto weather content');
    }
    const citations = page.citations.map(value => {
      const citation = record(value, 'WebIQ Auto citation');
      return sourceUrl(citation.url, { optional: structured });
    });
    const content = type === 'structured/weather' && evidence.content != null
      ? weatherContent(evidence.content)
      : structured ? evidenceContent(evidence.content, 'WebIQ Auto evidence content')
        : text(evidence.content, 'WebIQ Auto text');
    const weatherUrl = type === 'structured/weather' && evidence.content != null &&
      typeof evidence.content === 'object' && !Array.isArray(evidence.content)
      ? sourceUrl(evidence.content.url, { optional: true }) : '';
    const url = weatherUrl || citations[0] || '';
    if (!structured && !url) throw new Error('WebIQ Auto text result URL is missing');
    if (structured && !url && !content) throw new Error('WebIQ Auto structured evidence is missing');
    return { url, content, ...(input.includeMetadata ? { metadata: metadata(providerId,
      { ...page, title: page.citations[0]?.title },
      { 'citations.0.lastUpdatedAt': 'updated', 'citations.0.crawledAt': 'crawled',
        ...(type === 'structured/weather' ? { 'evidence.content.currentWeather.observedAt': 'observed' } : {}) },
      type) } : {}) };
  }), input);
}

export async function searchFullResponse(options) {
  const input = limits(options);
  const data = await request({
    providerId, endpoint: defaultEndpoint, endpointEnv: 'WEBIQ_AUTO_ENDPOINT', keyEnv: 'WEBIQ_API_KEY',
    authHeader: 'x-apikey', signal: input.signal, onDiagnostics: input.onDiagnostics,
    body: webiqBody(input),
    readResponse: response => portable.readRetainedSearchResponse(response, providerId, input),
  });
  record(data, 'WebIQ Auto response');
  if (data.error != null || data.errors != null || data.type === 'error') {
    throw new Error('WebIQ Auto returned an error payload');
  }
  return normalization.mapWebIQAutoFullResponse(data, input.maxResults, input.maxLength,
    portable.retainedResponseReceivedAt(data));
}
