// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import freshsearch from '../freshsearch.cjs';
import portable from '../freshsearch-confirmed-clock.cjs';
import * as webiq from './webiq.mjs';
import * as auto from './webiq-auto.mjs';
import * as perplexity from './perplexity.mjs';
import * as exa from './exa-auto.mjs';
import * as parallel from './parallel.mjs';
import * as custom from '../examples/provider.mjs';
import { retainResults } from '../trace.mjs';
import { ProviderRequestError, request } from './shared.mjs';

const query = '  site:example.org Exact "article" title  ';
const url = 'https://example.org/article?edition=1#section';
test('custom example bounds and normalizes results before runner validation', async t => {
  const calls = setup(t, { key: 'FRESHSEARCH_PROVIDER_KEY', endpointEnv: 'FRESHSEARCH_PROVIDER_ENDPOINT',
    endpoint: 'https://provider.example.com/search' }, { results: [
    { url, content: 'abcdef', metadata: { arbitrary: true } },
    { url, content: null }, { url, content: 'discarded' },
  ] });
  const rows = await custom.search({ query, maxResults: 2, maxLength: 3 });
  assert.equal(calls[0].cache, 'no-store');
  assert.equal(calls[0].headers['Cache-Control'], 'no-store');
  assert.deepEqual(rows, [{ url, content: 'abc' }, { url, content: '' }]);
  assert.deepEqual(retainResults(rows, custom.providerId, 2, 3), rows);
});
const webiqBody = (maxResults, maxLength) => ({
  query, maxResults, maxResultsWeb: maxResults, maxAnswerTypes: 6, maxLength, contentFormat: 'HTML',
});
const providers = [
  { adapter: webiq, key: 'WEBIQ_API_KEY', endpointEnv: 'WEBIQ_ENDPOINT',
    endpoint: 'https://configured.example/search', header: 'x-apikey', field: 'webResults',
    page: (url, content) => ({ url, content }), body: webiqBody },
  { adapter: auto, key: 'WEBIQ_API_KEY', endpointEnv: 'WEBIQ_AUTO_ENDPOINT',
    endpoint: 'https://auto.example/search', header: 'x-apikey', field: 'results',
    page: (url, content) => ({ evidence: { type: 'text', content }, citations: [{ url }] }),
    body: webiqBody },
  { adapter: perplexity, key: 'PERPLEXITY_API_KEY', endpoint: 'https://api.perplexity.ai/search',
    header: 'Authorization', field: 'results',
    page: (url, snippet) => ({ url, snippet }),
    body: maxResults => ({ query, max_results: maxResults, search_type: 'web' }) },
  { adapter: exa, key: 'EXA_API_KEY', endpoint: 'https://api.exa.ai/search',
    header: 'x-api-key', field: 'results', page: (url, text) => ({ url, text }),
    body: (maxResults, maxLength) => ({ query, type: 'auto', numResults: maxResults,
      contents: { text: { maxCharacters: maxLength } } }) },
  { adapter: parallel, key: 'PARALLEL_API_KEY', endpoint: 'https://api.parallel.ai/v1/search',
    header: 'x-api-key', field: 'results',
    page: (url, content) => ({ url, excerpts: content == null ? content : [content] }),
    body: (maxResults, maxLength) => ({ objective: query, search_queries: [query], mode: 'advanced',
      max_chars_total: maxResults * maxLength, advanced_settings: { max_results: maxResults } }) },
];

test('full-response adapters retain every received group and long evidence without changing legacy search', async t => {
  for (const provider of providers) {
    await t.test(provider.adapter.providerId, async child => {
      const { adapter, field, page } = provider;
      const content = `${'Observation '.repeat(700)}TAIL`;
      const payload = { [field]: Array.from({ length: 11 }, (_, index) =>
        page(`https://example.org/${index}`, content)) };
      const calls = setup(child, provider, payload);
      let responses;
      const result = await portable.captureSearchResponses(
        () => adapter.searchFullResponse({ query, maxResults: 10, maxLength: 7000 }),
        captured => { responses = captured; },
      );
      assert.equal(result.length, 11);
      assert.ok(result.every(row => row.content.endsWith('TAIL')));
      assert.equal(responses.length, 1);
      assert.equal(responses[0].mapping.receivedCount, 11);
      assert.deepEqual(responses[0].mapping.sources.map(row => row.rank),
        Array.from({ length: 11 }, (_, index) => index + 1));
      assert.equal(calls.length, 1);
    });
  }
});

test('full-response capture rejects response and source sizes over the private limits', async t => {
  const provider = providers.find(row => row.adapter === auto);
  let payload = { results: [provider.page(url, 'x'.repeat(60001))] };
  setup(t, provider, () => Response.json(payload));
  const capture = () => portable.captureSearchResponses(
    () => auto.searchFullResponse({ query }), () => {},
  );
  await assert.rejects(capture(), /complete-source input limit/u);
  payload = { results: Array.from({ length: 101 }, () => provider.page(url, 'x')) };
  await assert.rejects(capture(), /group count exceeds/u);
  payload = { results: [provider.page(url, 'x'.repeat(1_048_577))] };
  await assert.rejects(capture(), /body exceeds/u);
});

test('parallel full response sends the configured result limit and retains an empty result set', async t => {
  const provider = providers.find(row => row.adapter === parallel);
  const calls = setup(t, provider, { results: [] });
  let responses;
  const result = await portable.captureSearchResponses(
    () => parallel.searchFullResponse({ query, maxResults: 3, maxLength: 7000 }),
    captured => { responses = captured; },
  );
  assert.deepEqual(result, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, provider.body(3, 7000));
  assert.equal(responses.length, 1);
  assert.equal(responses[0].mapping.receivedCount, 0);
});

function setup(t, provider, response) {
  for (const [name, value] of [[provider.key, 'offline-test-key'],
    ...(provider.endpointEnv ? [[provider.endpointEnv, provider.endpoint]] : [])]) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (endpoint, options) => {
    calls.push({ endpoint: endpoint.href, ...options, body: JSON.parse(options.body) });
    return typeof response === 'function' ? response(options) : Response.json(response);
  });
  return calls;
}

for (const provider of providers) {
  const { adapter, field, page } = provider;
  const payload = rows => ({ [field]: rows });

  test(`${adapter.providerId}: exact request/auth/defaults and one dispatch`, async t => {
    const calls = setup(t, provider, payload([page(url, 'article')]));
    assert.equal(adapter.physicalRetries, 0);
    assert.equal(adapter.evaluateEF, undefined);
    assert.deepEqual(await adapter.search({ query }), [{ url, content: 'article' }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, provider.endpoint);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].redirect, 'error');
    assert.equal(calls[0].cache, 'no-store');
    assert.deepEqual(calls[0].headers, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      [provider.header]: provider.header === 'Authorization' ? 'Bearer offline-test-key' : 'offline-test-key',
    });
    assert.deepEqual(calls[0].body, provider.body(10, 7000));
    assert.ok(calls[0].signal instanceof AbortSignal);
  });

  test(`${adapter.providerId}: ranking, requested limits and hard ceilings`, async t => {
    const pages = Array.from({ length: 12 }, (_, i) => page(`${url}&rank=${i}`, 'x'.repeat(8000)));
    const calls = setup(t, provider, payload(pages));
    const limited = await adapter.search({ query, maxResults: 2, maxLength: 3 });
    assert.deepEqual(limited, pages.slice(0, 2).map((_, i) => ({ url: `${url}&rank=${i}`, content: 'xxx' })));
    assert.deepEqual(calls[0].body, provider.body(2, 3));
    const capped = await adapter.search({ query, maxResults: 99, maxLength: 99999 });
    assert.equal(capped.length, 10);
    assert.ok(capped.every(row => row.content.length === 7000));
    assert.deepEqual(calls[1].body, provider.body(10, 7000));
    assert.equal(calls.length, 2);
  });

  test(`${adapter.providerId}: missing/null/empty text preserves URL and FCD hit`, async t => {
    const calls = setup(t, provider, payload([page(url, undefined), page(url, null), page(url, '')]));
    const rows = await adapter.search({ query });
    assert.deepEqual(rows, Array.from({ length: 3 }, () => ({ url, content: '' })));
    const fixture = JSON.parse(await fs.readFile(new URL('../examples/fcd.json', import.meta.url), 'utf8'));
    const target = { ...fixture.episodes[0].targets[0], url, aliases: [url] };
    assert.equal(freshsearch.scoreKnownItem(target, rows).hit, true);
    assert.equal(freshsearch.scoreKnownItem(target, rows).withText, false);
    assert.equal(calls.length, 1);
  });

  test(`${adapter.providerId}: successful empty result is a scored miss`, async t => {
    const calls = setup(t, provider, payload([]));
    const rows = await adapter.search({ query });
    assert.deepEqual(rows, []);
    const fixture = JSON.parse(await fs.readFile(new URL('../examples/fcd.json', import.meta.url), 'utf8'));
    assert.equal(freshsearch.scoreKnownItem(fixture.episodes[0].targets[0], rows).hit, false);
    assert.equal(calls.length, 1);
  });

  test(`${adapter.providerId}: malformed payloads/results fail, including beyond the cutoff`, async t => {
    let response;
    const calls = setup(t, provider, () => Response.json(response));
    const invalid = [null, [], {}, { [field]: null }, { [field]: {} },
      payload([null]), payload([[]]), payload([{}]), payload([page(url, 42)]),
      payload([page('', 'text')]), payload([page('/relative', 'text')]),
      payload([page('javascript:alert(1)', 'text')]),
      payload([page('https://name:password@example.org/', 'text')]),
      { ...payload([]), error: 'rejected' }, { ...payload([]), errors: ['rejected'] },
      { ...payload([]), type: 'error' },
      payload([page(url, 'text'), null])];
    for (response of invalid) {
      await assert.rejects(adapter.search({ query, maxResults: 1 }));
    }
    assert.equal(calls.length, invalid.length);
  });

  test(`${adapter.providerId}: HTTP 401/429/5xx and redirects never retry or disclose response`, async t => {
    let status;
    const calls = setup(t, provider, () => new Response('confidential upstream error', { status }));
    for (status of [401, 429, 500, 502, 503, 504, 302]) {
      await assert.rejects(adapter.search({ query }), new RegExp(`^Error: ${adapter.providerId} returned HTTP ${status}$`));
    }
    assert.equal(calls.length, 7);
  });

  test(`${adapter.providerId}: invalid JSON and transport failure never retry`, async t => {
    let failTransport = false;
    const calls = setup(t, provider, () => {
      if (failTransport) throw new TypeError('offline transport failure');
      return new Response('{invalid');
    });
    await assert.rejects(adapter.search({ query }), SyntaxError);
    failTransport = true;
    await assert.rejects(adapter.search({ query }), /request failed/);
    assert.equal(calls.length, 2);
  });

  test(`${adapter.providerId}: missing key and invalid arguments fail before dispatch`, async t => {
    const calls = setup(t, provider, payload([]));
    delete process.env[provider.key];
    await assert.rejects(adapter.search({ query }), new RegExp(provider.key));
    process.env[provider.key] = '   ';
    await assert.rejects(adapter.search({ query }), new RegExp(provider.key));
    process.env[provider.key] = 'offline-test-key';
    for (const options of [{ query: '' }, { query: 42 }, { query, maxResults: 0 },
      { query, maxResults: 1.5 }, { query, maxLength: -1 }, { query, maxLength: NaN },
      { query, signal: {} }]) {
      await assert.rejects(adapter.search(options));
    }
    assert.equal(calls.length, 0);
  });

  test(`${adapter.providerId}: pre-abort and in-flight cancellation`, async t => {
    const calls = setup(t, provider, ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const before = new AbortController();
    before.abort(new Error('cancelled before'));
    await assert.rejects(adapter.search({ query, signal: before.signal }), /cancelled before/);
    assert.equal(calls.length, 0);
    const during = new AbortController();
    const pending = adapter.search({ query, signal: during.signal });
    during.abort(new Error('cancelled during'));
    await assert.rejects(pending, /cancelled during/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, true);
  });

  test(`${adapter.providerId}: timeout covers response body and timer is cleared on success`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let hang = true;
    const calls = setup(t, provider, ({ signal }) => hang ? {
      ok: true,
      json: () => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    } : Response.json(payload([])));
    const pending = adapter.search({ query });
    const rejected = assert.rejects(pending, error => error instanceof ProviderRequestError &&
      error.reason === 'provider-transport-failed' && error.cause?.name === 'TimeoutError');
    await Promise.resolve();
    t.mock.timers.tick(adapter === perplexity ? 60000 : 30000);
    await rejected;
    assert.equal(calls.length, 1);
    hang = false;
    await adapter.search({ query });
    t.mock.timers.tick(60001);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].signal.aborted, false);
  });
}

for (const provider of providers.filter(item => item.endpointEnv)) {
  test(`${provider.adapter.providerId}: uses its own public endpoint, never the sibling's; validates overrides`, async t => {
    const calls = setup(t, provider, { [provider.field]: [] });
    const sibling = provider.endpointEnv === 'WEBIQ_ENDPOINT' ? 'WEBIQ_AUTO_ENDPOINT' : 'WEBIQ_ENDPOINT';
    const previous = process.env[sibling];
    process.env[sibling] = 'https://sibling.example/search';
    t.after(() => {
      if (previous === undefined) delete process.env[sibling];
      else process.env[sibling] = previous;
    });
    const builtIn = provider.endpointEnv === 'WEBIQ_ENDPOINT'
      ? 'https://api.microsoft.ai/v3/search/web' : 'https://api.microsoft.ai/v3/auto';
    assert.equal(provider.adapter.defaultEndpoint, builtIn);
    for (const unset of [undefined, '', '  ']) {
      if (unset === undefined) delete process.env[provider.endpointEnv];
      else process.env[provider.endpointEnv] = unset;
      await provider.adapter.search({ query });
      assert.equal(calls.at(-1).endpoint, builtIn);
    }
    calls.length = 0;
    for (const endpoint of ['invalid', 'http://example.org/', 'https://user:key@example.org/',
      'https://example.org/?key=hidden', 'https://example.org/#fragment']) {
      process.env[provider.endpointEnv] = endpoint;
      await assert.rejects(provider.adapter.search({ query }), /endpoint must/);
    }
    assert.equal(calls.length, 0);
  });
}

const resetError = () => Object.assign(new TypeError('terminated'), {
  cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) });
const transportFailure = error => error instanceof ProviderRequestError &&
  error.reason === 'provider-transport-failed';

test('response-body transport failures are classified without reclassifying validation or caller aborts', async t => {
  const provider = { key: 'BODY_TEST_KEY', endpointEnv: 'BODY_TEST_ENDPOINT', endpoint: 'https://body.example/search' };
  let respond;
  setup(t, provider, options => respond(options));
  const call = (options = {}) => request({ providerId: 'body-test', endpointEnv: provider.endpointEnv,
    keyEnv: provider.key, authHeader: 'x-api-key', body: { query }, ...options });
  respond = () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"results":['));
    controller.error(resetError());
  } }));
  await assert.rejects(call(), error => transportFailure(error) && error.cause.cause.code === 'ECONNRESET');
  await assert.rejects(call({ readResponse: response =>
    portable.readRetainedSearchResponse(response, 'body-test', { query, maxResults: 1, maxLength: 1 }) }),
  transportFailure);
  respond = () => ({ ok: true, json: () => Promise.reject(Object.assign(new Error('undici'), {
    code: 'UND_ERR_SOCKET' })) });
  await assert.rejects(call(), transportFailure);
  respond = () => new Response('{malformed');
  await assert.rejects(call(), error => error instanceof SyntaxError);
  const invalid = new Error('Provider response must contain results[]');
  respond = () => Response.json({});
  await assert.rejects(call({ readResponse: async () => { throw invalid; } }), error => error === invalid);
  await assert.rejects(call({ readResponse: async () => { throw new TypeError('bad shape'); } }),
    error => error.message === 'bad shape' && !(error instanceof ProviderRequestError));
  respond = ({ signal }) => ({ ok: true, json: () => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const caller = new AbortController();
  const cancelled = new Error('caller cancelled body');
  const pending = call({ signal: caller.signal });
  await new Promise(resolve => setImmediate(resolve));
  caller.abort(cancelled);
  await assert.rejects(pending, error => error === cancelled);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timed = call({ timeoutMs: 50 });
  const rejected = assert.rejects(timed, error => transportFailure(error) && error.cause?.name === 'TimeoutError');
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(50);
  await rejected;
});

test('WebIQ: web-first weather/finance/news combined ordering and overall cap', async t => {
  let response = {
    webResults: [{ url, snippet: 'web snippet' }],
    weatherResults: [{ url: 'https://example.org/weather', currentWeather: { temperature: 22 } }],
    financeResults: [{ snippets: ['finance snippet'], context: { instrument: { price: 12 } } }],
    newsResults: [{ url: 'https://example.org/news', groundingContent: { content: 'news prose' } }],
  };
  const calls = setup(t, providers[0], () => Response.json(response));
  const rows = await webiq.search({ query });
  assert.deepEqual(rows.map(row => row.url), [url, 'https://example.org/weather', '', 'https://example.org/news']);
  assert.equal(rows[0].content, 'web snippet');
  assert.match(rows[1].content, /"temperature":22/);
  assert.equal(rows[2].content, 'finance snippet\n\n{"instrument":{"price":12}}');
  assert.equal(rows[3].content, 'news prose');
  response.webResults = Array.from({ length: 10 }, () => ({ url, content: 'web' }));
  assert.equal((await webiq.search({ query })).length, 10);
  assert.ok((await webiq.search({ query })).every(row => row.content === 'web'));
  response = { weatherResults: [] };
  assert.deepEqual(await webiq.search({ query }), []);
  response = { webResults: [], newsResults: {} };
  await assert.rejects(webiq.search({ query }), /newsResults/);
  response = { financeResults: [{ context: 42 }] };
  await assert.rejects(webiq.search({ query }), /finance context/);
  response = { weatherResults: [{}] };
  await assert.rejects(webiq.search({ query }), /structured result/);
  assert.equal(calls.length, 7);
});

test('WebIQ Auto: unified ranking retains structured and unknown evidence, first citation only', async t => {
  let response = { results: [
    { evidence: { type: 'structured/weather', content: { currentWeather: { temperature: 22 } } },
      citations: [{ url: 'https://example.org/weather' }] },
    { evidence: { type: 'text', content: 'article' }, citations: [{ url }, { url: 'https://example.org/secondary' }] },
    { evidence: { type: 'structured/unknown', content: { actual: 'provider data' } }, citations: [] },
  ] };
  const calls = setup(t, providers[1], () => Response.json(response));
  const rows = await auto.search({ query, maxLength: 7000 });
  assert.deepEqual(rows.map(row => row.url), ['https://example.org/weather', url, '']);
  assert.equal(rows[0].content, '{"currentWeather":{"temperature":22}}');
  assert.equal(rows[2].content, '{"actual":"provider data"}');
  assert.equal((await auto.search({ query, maxResults: 1, maxLength: 5 }))[0].content, '{"cur');
  response.results[0].evidence.content.url = 'https://example.org/weather-source';
  assert.equal((await auto.search({ query }))[0].url, 'https://example.org/weather-source');
  for (const entry of [
    { citations: [{ url }] }, { evidence: {}, citations: [{ url }] },
    { evidence: { type: 'text', content: 'a' }, citations: [] },
    { evidence: { type: 'text' }, citations: 'invalid' },
    { evidence: { type: 'structured/weather', content: [] }, citations: [] },
    { evidence: { type: 'structured/unknown', content: 42 }, citations: [] },
    { evidence: { type: 'structured/unknown' }, citations: [] },
  ]) {
    response = { results: [entry] };
    await assert.rejects(auto.search({ query }));
  }
  assert.equal(calls.length, 10);
});

test('Parallel: join actual ordered excerpts without dropping empty-text URLs', async t => {
  setup(t, providers[4], { results: [{ url, excerpts: ['first', '', 'last'] }] });
  assert.deepEqual(await parallel.search({ query }), [{ url, content: 'first\n\n\n\nlast' }]);
});

test('WebIQ: malformed card fields fail; empty primary news prose is preserved', async t => {
  let response;
  setup(t, providers[0], () => Response.json(response));
  for (response of [
    { weatherResults: [{ url, currentWeather: 42 }] },
    { weatherResults: [{ url, forecastedWeather: {} }] },
    { weatherResults: [{ url, location: [] }] },
    { financeResults: [{ url, snippets: 'not-an-array' }] },
    { newsResults: [{ url, groundingContent: { content: 42 } }] },
  ]) {
    await assert.rejects(webiq.search({ query }));
  }
  response = { newsResults: [{ url, groundingContent: { content: '' }, snippet: 'secondary' }] };
  assert.deepEqual(await webiq.search({ query }), [{ url, content: '' }]);
});

test('WebIQ Auto: malformed known weather shape fails without discarding valid missing-text URL', async t => {
  let content;
  setup(t, providers[1], () => Response.json({ results: [
    { evidence: { type: 'structured/weather', content }, citations: [{ url }] },
  ] }));
  for (content of [{ currentWeather: 42 }, { alerts: 'invalid' }, { units: [] }]) {
    await assert.rejects(auto.search({ query }));
  }
  content = undefined;
  assert.deepEqual(await auto.search({ query }), [{ url, content: '' }]);
});

test('Parallel: malformed excerpt array fails rather than dropping a source', async t => {
  let excerpts;
  setup(t, providers[4], () => Response.json({ results: [{ url, excerpts }] }));
  for (excerpts of ['invalid', {}, ['text', null]]) {
    await assert.rejects(parallel.search({ query }), /excerpts/);
  }
});
