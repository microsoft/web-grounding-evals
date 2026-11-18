// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Adapt this module to an authorized provider. Keys belong in environment variables.
export const providerId = 'your-provider';
export const physicalRetries = 0;
export async function search({ query, signal, maxResults, maxLength }) {
  const endpoint = process.env.FRESHSEARCH_PROVIDER_ENDPOINT;
  const key = process.env.FRESHSEARCH_PROVIDER_KEY;
  if (!endpoint || !key) throw new Error('Set FRESHSEARCH_PROVIDER_ENDPOINT and FRESHSEARCH_PROVIDER_KEY');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Provider endpoint must be HTTPS without credentials/query/fragment');
  }
  const response = await fetch(url, {
    method: 'POST', signal, redirect: 'error', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, maxResults, maxLength }),
  });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.results)) throw new Error('Provider response must contain results[] with url/content');
  return body.results.slice(0, maxResults).map(result => {
    if (!result || typeof result.url !== 'string' ||
      (result.content != null && typeof result.content !== 'string')) {
      throw new Error('Provider result must contain a URL string and optional content string');
    }
    return { url: result.url, content: (result.content ?? '').slice(0, maxLength) };
  });
}
