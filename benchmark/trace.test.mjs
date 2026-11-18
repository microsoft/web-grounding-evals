// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureSearch, retainDiagnostics, retainResults } from './trace.mjs';
import { main, scoreCapture } from './run.mjs';
import { parseReport, collectRuns } from './report.mjs';
import { renderViewer } from './report-ui.mjs';
import * as webiq from './providers/webiq.mjs';
import * as auto from './providers/webiq-auto.mjs';
import * as perplexity from './providers/perplexity.mjs';
import * as exa from './providers/exa-auto.mjs';
import * as parallel from './providers/parallel.mjs';

const query = '  =exact "query",\nnot rewritten  ';
const url = 'https://source.example/a';
const cases = [
  [webiq, 'WEBIQ_API_KEY', 'WEBIQ_ENDPOINT', 'webResults',
    { url, content: 'abcde', title: 'Title', datePublished: '2026-10-14', lastUpdatedAt: null, crawledAt: '2026-10-15' },
    ['published', 'updated', 'crawled', 'crawled']],
  [auto, 'WEBIQ_API_KEY', 'WEBIQ_AUTO_ENDPOINT', 'results',
    { evidence: { type: 'text', content: 'abcde' },
      citations: [{ url, title: 'Title', lastUpdatedAt: '2026-10-15', crawledAt: null }] },
    ['updated', 'crawled']],
  [perplexity, 'PERPLEXITY_API_KEY', null, 'results',
    { url, snippet: 'abcde', title: 'Title', date: '2026-10-14', last_updated: null },
    ['published', 'updated']],
  [exa, 'EXA_API_KEY', null, 'results',
    { url, text: 'abcde', title: 'Title', publishedDate: null }, ['estimated_publication']],
  [parallel, 'PARALLEL_API_KEY', null, 'results',
    { url, excerpts: ['abcde'], title: 'Title', publish_date: '2026-10-14' }, ['published']],
];

for (const [adapter, key, endpoint, field, page, kinds] of cases) {
  test(`${adapter.providerId}: opt-in exact query, safe effective request, raw attributed metadata and monotonic timing`, async t => {
    for (const [name, value] of [[key, 'never-retain-provider-secret'],
      ...(endpoint ? [[endpoint, 'https://configured.example/search']] : [])]) {
      const old = process.env[name]; process.env[name] = value;
      t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
    }
    let dispatches = 0;
    const checkpoints = [];
    t.mock.method(globalThis, 'fetch', async (_, options) => {
      dispatches++;
      assert.equal(checkpoints.at(-1).effectiveConfig.physicalRetries, 0);
      const body = JSON.parse(options.body);
      assert.equal(body.query ?? body.objective, query);
      return Response.json({ [field]: [page] });
    });
    const trace = { id: 'trace' };
    const results = await captureSearch(adapter, { query, signal: new AbortController().signal,
      maxResults: 1, maxLength: 3 }, trace, async () => checkpoints.push(structuredClone(trace)));
    assert.equal(dispatches, 1);
    assert.equal(trace.query, query);
    assert.equal(results[0].content, 'abc');
    assert.equal(results[0].metadata.contentTruncated, true);
    assert.deepEqual(results[0].metadata.timestamps.map(t => t.kind), kinds);
    assert.ok(results[0].metadata.timestamps.every(t => t.attribution === 'provider-reported'));
    assert.ok(results[0].metadata.timestamps.every(t => t.value === null || typeof t.value === 'string'));
    assert.ok(trace.searchMs >= 0);
    assert.ok(Date.parse(trace.responseTime) >= Date.parse(trace.requestTime));
    assert.ok(!JSON.stringify(trace).includes(process.env[key]));
    assert.ok(!JSON.stringify(trace.effectiveConfig).includes('Authorization'));
    assert.ok(!JSON.stringify(trace.effectiveConfig).includes(query));
  });
}

test('legacy custom search stays two-field compatible with explicitly unknown effective configuration', async () => {
  const adapter = { providerId: 'legacy', search: async options => {
    assert.equal(options.query, query);
    return [{ url, content: 'abc' }];
  } };
  const trace = {};
  await captureSearch(adapter, { query, maxResults: 1, maxLength: 3 }, trace, async () => {});
  assert.equal(trace.effectiveConfig, null);
  assert.equal(trace.results[0].metadata, undefined);
  assert.equal(trace.query, query);
});

test('diagnostics only retain allowlisted request fields; headers, arbitrary config and unsafe URLs cannot leak', () => {
  const base = { version: 'freshsearch-provider-diagnostics-v1', providerId: 'custom',
    endpoint: 'https://configured.example/search', method: 'POST', physicalRetries: 0,
    redirect: 'error', timeoutMs: 30000, settings: { maxResults: 10 },
    headers: { Authorization: 'secret' }, env: { KEY: 'secret' } };
  assert.ok(!JSON.stringify(retainDiagnostics(base, 'custom')).includes('secret'));
  for (const patch of [
    { settings: { token: 'secret' } }, { settings: { type: 'secret' } },
    { settings: { contents: { token: 'secret' } } },
    { endpoint: 'https://configured.example/search?api_key=secret' },
    { endpoint: 'https://secret@configured.example/search' }, { physicalRetries: 1 },
  ]) assert.throws(() => retainDiagnostics({ ...base, ...patch }, 'custom'));
  assert.throws(() => retainResults([{ url, content: 'abcd' }], 'custom', 1, 3), /unbounded/);
});

test('diagnostics checkpoint failure, preabort and post-search cancellation do not proceed', async t => {
  let called = 0;
  const adapter = { providerId: 'custom', search: async () => { called++; return []; } };
  await assert.rejects(captureSearch(adapter, { query, maxResults: 1, maxLength: 3 }, {},
    async () => { throw new Error('disk failure'); }), /disk failure/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(captureSearch(adapter, { query, signal: controller.signal, maxResults: 1, maxLength: 3 }, {},
    async () => {}), /abort/i);
  assert.equal(called, 0);
  const old = process.env.EXA_API_KEY; process.env.EXA_API_KEY = 'test-secret';
  t.after(() => { if (old === undefined) delete process.env.EXA_API_KEY; else process.env.EXA_API_KEY = old; });
  t.mock.method(globalThis, 'fetch', async () => { called++; return Response.json({ results: [] }); });
  let saves = 0;
  await assert.rejects(captureSearch(exa, { query, maxResults: 1, maxLength: 3 }, {}, async () => {
    if (++saves === 2) throw new Error('config checkpoint failure');
  }), /config checkpoint failure/);
  assert.equal(called, 0);
});

test('FCD retains exact query and metadata without recovering a fake query for legacy capture', async t => {
  const source = JSON.parse(await fs.readFile(new URL('./examples/fcd.json', import.meta.url), 'utf8'));
  const legacyRows = scoreCapture(source, 'fcd').rows;
  assert.ok(legacyRows.every(row => !Object.hasOwn(row, 'query')));
  const traced = structuredClone(source); traced.version = 'freshsearch-traced-input-v1';
  const target = traced.episodes[0].targets[0];
  target.trace = { id: 'target-trace', query, queryProvenance: 'exact-submitted',
    requestTime: target.requestTime, searchMs: 2, results: target.results };
  assert.equal(scoreCapture(traced, 'fcd').rows[0].query, query);
  assert.deepEqual(scoreCapture(traced, 'fcd').rows.map(row => row.score), legacyRows.map(row => row.score));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'freshsearch-fcd-trace-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const filename = path.join(temp, 'capture.json');
  await fs.writeFile(filename, JSON.stringify(traced));
  const report = await main(['--panel', 'fcd', '--input', filename, '--out', path.join(temp, 'run')]);
  const csv = await fs.readFile(path.join(temp, 'run', 'cases.csv'), 'utf8');
  assert.ok(csv.includes(`"'${query.replaceAll('"', '""')}"`));
  assert.equal(report.cases[1].query, null);
  assert.equal(report.cases[1].queryProvenance, 'unknown');
  assert.equal(parseReport(report).panel, 'fcd');
  const viewer = await collectRuns([path.join(temp, 'run')]);
  assert.equal(viewer.runs[0].status, 'complete');
  const malformed = structuredClone(report);
  malformed.cases[0].searchMs = -1;
  assert.throws(() => parseReport(malformed), /searchMs/);
  for (const [index, item] of report.cases.entries()) {
    if (item.status === 'scored') item.searchMs = 20 + index;
  }
  const parsed = parseReport(report);
  assert.ok(parsed.summary[0].searchSeconds > 0);
  const html = renderViewer({ version: 'freshsearch-viewer-v1',
    runs: [{ status: 'complete', id: 'run-1', groupId: 'group-1', report: parsed }] });
  assert.equal((html.match(/<svg /gu) ?? []).length, 2);
  assert.equal((html.match(/<circle /gu) ?? []).length, 1);
  assert.match(html, /mean adapter invocation/);
  assert.ok(!html.includes(query));
  assert.ok(!html.includes('target-trace'));
});

test('structured provider clocks retain raw observed values and full field paths, not publication substitutes', async t => {
  const old = process.env.WEBIQ_API_KEY; const previousEndpoint = process.env.WEBIQ_ENDPOINT;
  process.env.WEBIQ_API_KEY = 'offline-secret'; process.env.WEBIQ_ENDPOINT = 'https://configured.example/search';
  t.after(() => {
    if (old === undefined) delete process.env.WEBIQ_API_KEY; else process.env.WEBIQ_API_KEY = old;
    if (previousEndpoint === undefined) delete process.env.WEBIQ_ENDPOINT; else process.env.WEBIQ_ENDPOINT = previousEndpoint;
  });
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    weatherResults: [{ url, currentWeather: { observedAt: '2026-10-14T12:51:00Z' },
      answerSignals: { crawledAt: '2026-10-14T12:52:00Z' } }],
    financeResults: [{ url, context: { instrument: { timeLastTradedUtcInUnixMs: 1791982260000 } } }],
  }));
  const rows = await webiq.search({ query, includeMetadata: true });
  assert.deepEqual(rows[0].metadata.timestamps.find(t => t.kind === 'observed'), {
    attribution: 'provider-reported', field: 'currentWeather.observedAt',
    kind: 'observed', value: '2026-10-14T12:51:00Z',
  });
  assert.equal(rows[1].metadata.timestamps.find(t => t.field ===
    'context.instrument.timeLastTradedUtcInUnixMs').value, 1791982260000);
  assert.ok(rows.every(row => row.metadata.timestamps.every(t => t.kind !== 'published' || t.value === null)));
});
