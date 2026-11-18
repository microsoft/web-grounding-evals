// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @typedef {{version:'freshsearch-provider-diagnostics-v1', providerId:string,
 * endpoint:string, method:'POST', physicalRetries:0, redirect:'error',
 * timeoutMs:number, settings:object}} ProviderDiagnostics
 * @typedef {{query:string, signal?:AbortSignal, maxResults?:number, maxLength?:number,
 * includeMetadata?:boolean, onDiagnostics?:(value:ProviderDiagnostics)=>void|Promise<void>}} SearchOptions
 * @typedef {{url:string, content:string, metadata?:{
 * version:'freshsearch-result-metadata-v1', providerId:string, resultType:string,
 * title:string|null, titleTruncated:boolean, contentTruncated:boolean,
 * timestamps:Array<{attribution:'provider-reported', field:string,
 * kind:'published'|'estimated_publication'|'updated'|'crawled'|'observed', value:string|number|null}>
 * }}} SearchResult
 */

export function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function text(value, label) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

export function strings(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

export function sourceUrl(value, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim()) throw new Error('Result URL is missing');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Result URL must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Result URL must be HTTP(S) without credentials');
  }
  return value;
}

export function limits({ query, maxResults = 10, maxLength = 7000, signal, includeMetadata = false, onDiagnostics }) {
  if (signal != null && !(signal instanceof AbortSignal)) throw new Error('Search signal must be an AbortSignal');
  signal?.throwIfAborted();
  if (typeof query !== 'string' || !query.trim()) throw new Error('Search query must be nonempty');
  if (!Number.isInteger(maxResults) || maxResults < 1 ||
      !Number.isInteger(maxLength) || maxLength < 1) {
    throw new Error('Search limits must be positive integers');
  }
  if (onDiagnostics !== undefined && typeof onDiagnostics !== 'function') throw new Error('onDiagnostics must be a function');
  if (typeof includeMetadata !== 'boolean') throw new Error('includeMetadata must be a boolean');
  return { query, signal, includeMetadata, onDiagnostics,
    maxResults: Math.min(10, maxResults), maxLength: Math.min(7000, maxLength) };
}

export function resultsArray(data, field = 'results') {
  record(data, 'Provider response');
  if (data.error != null || data.errors != null || data.type === 'error') {
    throw new Error('Provider returned an error payload');
  }
  if (!Array.isArray(data[field])) throw new Error(`Provider response must contain ${field}[]`);
  return data[field];
}

export function bounded(results, { maxResults, maxLength, includeMetadata }) {
  return results.slice(0, maxResults).map(({ url, content, metadata }) => ({
    url, content: content.slice(0, maxLength),
    ...(includeMetadata ? { metadata: { ...metadata, contentTruncated: content.length > maxLength } } : {}),
  }));
}

export class ProviderRequestError extends Error {
  constructor(message, reason, options) {
    super(message, options);
    this.reason = reason;
  }
}

const networkCodes = /^(?:ECONNRESET|ECONNABORTED|ECONNREFUSED|EPIPE|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|UND_ERR_[A-Z_]+)$/u;

// Network failures surface as undici TypeErrors ('fetch failed', 'terminated') or coded socket errors.
// Validation failures (SyntaxError, schema/size checks in readResponse) are deliberately not matched.
export function isNetworkError(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    if (typeof current.code === 'string' && networkCodes.test(current.code)) return true;
  }
  return error instanceof TypeError && ['fetch failed', 'terminated', 'network error'].includes(error.message);
}

export async function request({ providerId, endpoint, endpointEnv, keyEnv, authHeader,
  bearer = false, body, signal, onDiagnostics, readResponse, timeoutMs = 30000 }) {
  signal?.throwIfAborted();
  const override = endpointEnv ? process.env[endpointEnv]?.trim() : '';
  const configured = override || endpoint;
  if (!configured) throw new Error(`Set ${endpointEnv}`);
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`${endpointEnv ?? providerId} endpoint must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${endpointEnv ?? providerId} endpoint must be HTTPS without credentials/query/fragment`);
  }
  const key = process.env[keyEnv];
  if (typeof key !== 'string' || !key.trim()) throw new Error(`Set ${keyEnv}`);
  const { query, objective, search_queries, ...settings } = body;
  if (onDiagnostics) await onDiagnostics({
    version: 'freshsearch-provider-diagnostics-v1', providerId,
    endpoint: url.href, method: 'POST', physicalRetries: 0, redirect: 'error',
    timeoutMs, settings,
  });
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(
    `${providerId} request timed out`, 'TimeoutError',
  )), timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: requestSignal,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
          [authHeader]: bearer ? `Bearer ${key}` : key },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.signal.aborted || error instanceof TypeError) {
        throw new ProviderRequestError(`${providerId} request failed`, 'provider-transport-failed', { cause: error });
      }
      throw error;
    }
    if (!response.ok) throw new ProviderRequestError(`${providerId} returned HTTP ${response.status}`,
      `http-${response.status}`);
    let data;
    try {
      data = readResponse ? await readResponse(response) : await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.signal.aborted || isNetworkError(error)) {
        throw new ProviderRequestError(`${providerId} request failed`, 'provider-transport-failed', { cause: error });
      }
      throw error;
    }
    signal?.throwIfAborted();
    if (controller.signal.aborted) {
      throw new ProviderRequestError(`${providerId} request failed`, 'provider-transport-failed',
        { cause: controller.signal.reason });
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Raw provider claims only. These fields never establish a qualifying evidence clock.
export function metadata(providerId, page, fields = {}, resultType = 'web') {
  const timestamps = Object.entries(fields).map(([field, kind]) => {
    const value = field.split('.').reduce((value, part) => value?.[part], page);
    if (value !== undefined && value !== null && typeof value !== 'string' &&
      !(kind === 'observed' && typeof value === 'number' && Number.isFinite(value))) {
      throw new Error(`${providerId} ${field} has an invalid timestamp value`);
    }
    return { attribution: 'provider-reported', field, kind, value: value ?? null };
  });
  return { version: 'freshsearch-result-metadata-v1', providerId, resultType,
    title: page.title == null ? null : text(page.title, `${providerId} title`).slice(0, 1000),
    titleTruncated: typeof page.title === 'string' && page.title.length > 1000,
    timestamps };
}

export const webiqBody = ({ query, maxResults, maxLength }) => ({
  query, maxResults, maxResultsWeb: maxResults, maxAnswerTypes: 6,
  maxLength, contentFormat: 'HTML',
});

export function evidenceContent(value, label) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  throw new Error(`${label} must be text or structured content`);
}

export function weatherContent(value) {
  const page = record(value, 'WebIQ weather card');
  for (const field of ['location', 'title', 'snippet']) text(page[field], `WebIQ weather ${field}`);
  for (const field of ['units', 'currentWeather', 'historicalWeather', 'answerSignals']) {
    if (page[field] != null) record(page[field], `WebIQ weather ${field}`);
  }
  for (const field of ['alerts', 'forecastedWeather']) {
    if (page[field] != null && !Array.isArray(page[field])) {
      throw new Error(`WebIQ weather ${field} must be an array`);
    }
  }
  return evidenceContent(page, 'WebIQ weather card');
}
