// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { sourceUrl } from './providers/shared.mjs';

export const hash = value => createHash('sha256').update(JSON.stringify(value, (_, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
export const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function httpsEndpoint(value) {
  const url = new URL(value);
  ensure(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    'Endpoint must be HTTPS without credentials/query/fragment');
  return url.href;
}

const numericSettings = new Set(['maxResults', 'maxResultsWeb', 'maxAnswerTypes', 'maxLength',
  'max_results', 'numResults', 'maxCharacters', 'max_chars_total']);
const stringSettings = { type: 'auto', mode: 'advanced', contentFormat: 'HTML', search_type: 'web',
  search_context_size: 'high' };
const nestedSettings = new Set(['contents', 'text', 'advanced_settings']);
function settings(value) {
  ensure(object(value), 'Diagnostics settings must be an object');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (numericSettings.has(key)) ensure(Number.isSafeInteger(item) && item > 0 && item <= 70000,
      'Invalid numeric diagnostics setting');
    else if (Object.hasOwn(stringSettings, key)) ensure(item === stringSettings[key], 'Invalid pinned diagnostics setting');
    else if (nestedSettings.has(key)) return [key, settings(item)];
    else throw new Error('Unsupported diagnostics setting (arbitrary configuration is not retained)');
    return [key, item];
  }));
}

export function retainDiagnostics(value, providerId) {
  ensure(object(value) && value.version === 'freshsearch-provider-diagnostics-v1' &&
    value.providerId === providerId && value.method === 'POST' && value.physicalRetries === 0 &&
    value.redirect === 'error' && Number.isInteger(value.timeoutMs) && value.timeoutMs > 0 &&
    value.timeoutMs <= 120000, 'Invalid provider diagnostics');
  return { version: value.version, providerId, endpoint: httpsEndpoint(value.endpoint),
    method: 'POST', physicalRetries: 0, redirect: 'error', timeoutMs: value.timeoutMs,
    settings: settings(value.settings) };
}

export function retainResults(value, providerId, maxResults, maxLength) {
  ensure(Array.isArray(value) && value.length <= maxResults, 'Search results exceed the requested budget');
  return value.map(item => {
    ensure(object(item) && typeof item.url === 'string' && typeof item.content === 'string' &&
      item.content.length <= maxLength, 'Invalid or unbounded normalized search result');
    sourceUrl(item.url, { optional: true });
    const result = { url: item.url, content: item.content };
    if (item.metadata !== undefined) {
      const m = item.metadata;
      ensure(object(m) && m.version === 'freshsearch-result-metadata-v1' && m.providerId === providerId &&
        typeof m.resultType === 'string' && m.resultType.length <= 100 &&
        (m.title === null || typeof m.title === 'string' && m.title.length <= 1000) &&
        typeof m.titleTruncated === 'boolean' &&
        typeof m.contentTruncated === 'boolean' &&
        Array.isArray(m.timestamps) && m.timestamps.length <= 10, 'Invalid result metadata');
      result.metadata = { version: m.version, providerId, resultType: m.resultType,
        title: m.title, titleTruncated: m.titleTruncated, contentTruncated: m.contentTruncated,
        timestamps: m.timestamps.map(t => {
          ensure(object(t) && t.attribution === 'provider-reported' &&
            ['published', 'estimated_publication', 'updated', 'crawled', 'observed'].includes(t.kind) &&
            typeof t.field === 'string' && /^[a-zA-Z][a-zA-Z0-9_.]{0,80}$/u.test(t.field) &&
            (t.value === null || typeof t.value === 'string' && t.value.length <= 500 ||
              t.kind === 'observed' && typeof t.value === 'number' && Number.isFinite(t.value)),
          'Invalid provider timestamp metadata');
          return { attribution: t.attribution, field: t.field, kind: t.kind, value: t.value };
        }) };
    }
    return result;
  });
}

export async function adapterIdentity(filename) {
  const files = [filename];
  const builtin = new URL('./providers/', import.meta.url);
  if (new URL(filename).href.startsWith(builtin.href)) files.push(new URL('./providers/shared.mjs', import.meta.url));
  return { version: 'freshsearch-adapter-source-v1',
    entrySha256: createHash('sha256').update(await fs.readFile(filename)).digest('hex'),
    sharedSha256: files.length === 2 ? createHash('sha256').update(await fs.readFile(files[1])).digest('hex') : null,
    dependencyIdentity: files.length === 2 ? 'builtin-node-fetch-no-runtime-dependencies' : 'custom-dependencies-unknown' };
}

export async function captureSearch(adapter, options, trace, save) {
  ensure(typeof adapter.search === 'function', 'Adapter must export search');
  trace.query = options.query;
  trace.queryProvenance = 'reserved-not-confirmed';
  trace.request = { maxResults: options.maxResults, maxLength: options.maxLength };
  trace.effectiveConfig = null;
  trace.requestTime = new Date().toISOString();
  trace.status = 'capture-unknown';
  await save();
  options.signal?.throwIfAborted();
  const started = performance.now();
  let diagnosticsSeen = false;
  try {
    const results = await adapter.search({ ...options, includeMetadata: true, onDiagnostics: async value => {
      ensure(!diagnosticsSeen, 'Adapter emitted duplicate request diagnostics');
      diagnosticsSeen = true;
      trace.effectiveConfig = retainDiagnostics(value, adapter.providerId);
      trace.effectiveConfigHash = hash(trace.effectiveConfig);
      await save();
      options.signal?.throwIfAborted();
    } });
    options.signal?.throwIfAborted();
    trace.results = retainResults(results, adapter.providerId, options.maxResults, options.maxLength);
    trace.queryProvenance = 'exact-submitted';
    trace.status = 'captured';
    return trace.results;
  } finally {
    trace.responseTime = new Date().toISOString();
    trace.searchMs = performance.now() - started;
    await save();
  }
}

export function caseTrace(trace) {
  return { traceId: trace.id, query: trace.query ?? null,
    queryProvenance: trace.queryProvenance ?? 'unknown',
    requestTime: trace.requestTime ?? null, responseTime: trace.responseTime ?? null,
    searchMs: trace.searchMs ?? null, judgeMs: trace.judgeMs ?? null,
    referenceMs: trace.referenceMs ?? null, totalMs: trace.totalMs ?? null,
    effectiveConfig: trace.effectiveConfig ?? null, effectiveConfigHash: trace.effectiveConfigHash ?? null,
    adapter: trace.adapter ?? null, results: trace.results ?? null,
    reference: trace.reference ?? null, judge: trace.judge ?? null };
}
