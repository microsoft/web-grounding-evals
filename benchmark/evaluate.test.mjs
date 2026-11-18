// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { cli, main, runEvaluation, replaceEvaluationFileAtomically, persistEvaluationCheckpoint } from './evaluate.mjs';
import { scoreCapture, summarize, benchmarkSourceHashes } from './run.mjs';
import { adapterIdentity, hash } from './trace.mjs';
import { metadataReport, safeLiveFailure, sharedFCDReference } from './retention.mjs';
import { ProviderRequestError } from './providers/shared.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
const environment = { EXA_API_KEY: 'test-only-search-key', FRESHSEARCH_JUDGE_API_KEY: 'test-only-judge-key' };

test('checkpoint files progress independently but each replacement waits for its complete private write', async () => {
  const out = path.resolve('checkpoint-test');
  const files = [['evaluation.json', 'manifest'], ['summary.json', 'summary'], ['results.html', 'viewer']];
  const writes = [];
  const replacements = [];
  const gate = Promise.withResolvers();
  const checkpoint = persistEvaluationCheckpoint(out, files, {
    writeFile: async (pending, content, options) => {
      writes.push({ pending, content, options });
      await gate.promise;
    },
    replace: async (pending, destination) => {
      replacements.push({ pending, destination });
    },
  });
  try {
    assert.deepEqual(writes, files.map(([filename, content]) => ({
      pending: path.join(out, `${filename}.pending`), content, options: { mode: 0o600 },
    })));
    assert.deepEqual(replacements, []);
  } finally {
    gate.resolve();
    await checkpoint;
  }
  assert.deepEqual(replacements, files.map(([filename]) => ({
    pending: path.join(out, `${filename}.pending`), destination: path.join(out, filename),
  })));
});

test('failed checkpoints wait for all file operations and retain the original failure', async () => {
  const failure = new Error('checkpoint write failed');
  const gate = Promise.withResolvers();
  let settled = false;
  const checkpoint = persistEvaluationCheckpoint(path.resolve('checkpoint-test'),
    [['evaluation.json', 'manifest'], ['summary.json', 'summary']], {
      writeFile: async pending => {
        if (pending.endsWith('evaluation.json.pending')) throw failure;
      },
      replace: async () => gate.promise,
    });
  const rejection = assert.rejects(checkpoint, error => error === failure).then(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
  } finally {
    gate.resolve();
    await rejection;
  }
});

test('atomic evaluation replacement retries Windows sharing locks without changing source or destination', async () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const waits = [];
    let attempts = 0;
    await replaceEvaluationFileAtomically('summary.json.pending', 'summary.json', {
      platform: 'win32',
      rename: async (pending, destination) => {
        assert.equal(pending, 'summary.json.pending');
        assert.equal(destination, 'summary.json');
        if (++attempts < 3) throw Object.assign(new Error('sharing violation'), { code });
      },
      wait: async delay => waits.push(delay),
    });
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [10, 20]);
  }
});

test('atomic evaluation replacement does not retry unrelated errors or non-Windows failures', async () => {
  for (const [platform, code] of [['win32', 'ENOENT'], ['linux', 'EPERM']]) {
    const failure = Object.assign(new Error('original rename failure'), { code });
    let attempts = 0;
    await assert.rejects(replaceEvaluationFileAtomically('pending', 'destination', {
      platform,
      rename: async () => { attempts++; throw failure; },
      wait: async () => assert.fail('failure must not be retried'),
    }), error => error === failure);
    assert.equal(attempts, 1);
  }
});

test('atomic evaluation replacement bounds sharing-lock retries and preserves the final error', async () => {
  const failure = Object.assign(new Error('persistent sharing violation'), { code: 'EPERM' });
  const waits = [];
  let attempts = 0;
  await assert.rejects(replaceEvaluationFileAtomically('pending', 'destination', {
    platform: 'win32',
    rename: async () => { attempts++; throw failure; },
    wait: async delay => waits.push(delay),
  }), error => error === failure);
  assert.equal(attempts, 6);
  assert.deepEqual(waits, [10, 20, 40, 80, 160]);
});

function mockPublisher(t) {
  const previousRequest = https.request;
  const previousLookup = dns.lookup;
  const previousKey = process.env.FRESHSEARCH_JUDGE_API_KEY;
  let requests = 0;
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  https.request = (_url, _options, callback) => {
    requests++;
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 503;
      response.headers = {};
      response.destroy = () => {};
      callback(response);
      response.emit('end');
    });
    return request;
  };
  process.env.FRESHSEARCH_JUDGE_API_KEY = environment.FRESHSEARCH_JUDGE_API_KEY;
  t.after(() => {
    https.request = previousRequest;
    dns.lookup = previousLookup;
    if (previousKey === undefined) delete process.env.FRESHSEARCH_JUDGE_API_KEY;
    else process.env.FRESHSEARCH_JUDGE_API_KEY = previousKey;
  });
  return () => requests;
}

async function setup(t, { feeds = 1, tasks = 1, providers = 1 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freshsearch-evaluation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const catalog = await read(path.join(root, 'datasets/current-launch-fcd96.json'));
  const input = await read(path.join(root, 'examples/ef-tasks.json'));
  input.tasks = Array.from({ length: tasks }, (_, i) => ({ ...input.tasks[0], queryId: `task-${i + 1}` }));
  const taskFile = path.join(directory, 'tasks.json');
  const feedFile = path.join(directory, 'feeds.txt');
  const judgeFile = path.join(directory, 'judge.json');
  const judge = { ...(await read(path.join(root, 'examples/judge-config.json'))),
    endpoint: 'https://judge.example.com/v1/chat/completions', model: 'test-deployment' };
  await fs.writeFile(taskFile, JSON.stringify(input));
  await fs.writeFile(feedFile, catalog.sources.slice(0, feeds).map(feed => feed.sourceId).join('\n') + '\n');
  await fs.writeFile(judgeFile, JSON.stringify(judge));
  const modules = [];
  for (let i = 0; i < providers; i++) {
    const file = path.join(directory, `provider-${i + 1}.mjs`);
    await fs.writeFile(file, `import portable from '${pathToFileURL(path.join(root, 'freshsearch-confirmed-clock.cjs')).href}';\n` +
      `import normalization from '${pathToFileURL(path.join(root, 'providers', 'normalization.cjs')).href}';\n` +
      `export const providerId = 'provider-${i + 1}';\n` +
      'export const physicalRetries = 0;\nexport async function search() { return []; }\n' +
      'export async function searchFullResponse(options) {\n' +
      '  const data = await portable.readRetainedSearchResponse(new Response(\'{"results":[]}\'), providerId, options);\n' +
      "  return normalization.mapExaSearchResponse(data, options.maxResults, options.maxLength, 'exa-auto');\n}\n");
    modules.push(file);
  }
  const values = { live: true, 'confirm-authorized-use': true, provider: modules, 'fcd-feeds': feedFile, 'ef-input': taskFile,
    'judge-config': judgeFile, 'max-fcd-calls': String(feeds * providers * 10),
    'max-ef-calls': String(tasks * providers), 'max-judge-calls': String(tasks * providers * 2),
    out: path.join(directory, 'evaluation') };
  return { directory, values, catalog, taskFile, feedFile, judgeFile };
}

function fcdOnlyValues(context) {
  const values = { ...context.values, 'fcd-only': true };
  for (const name of ['ef-input', 'judge-config', 'max-ef-calls', 'max-judge-calls']) delete values[name];
  return values;
}

function efOnlyValues(context) {
  const values = { ...context.values, 'ef-only': true };
  for (const name of ['fcd-feed-id', 'fcd-feeds', 'max-fcd-calls']) delete values[name];
  return values;
}

function fakeEvaluator(context, { mutate, failAt = 0, signal } = {}) {
  const calls = [];
  const captures = new Map();
  const identities = new Map();
  const options = [];
  let sourceMetadata;
  const invoke = async (args, { fcdReference, efTasks, judgeConfig, receiptKey } = {}) => {
    calls.push(args);
    options.push({ fcdReference, efTasks, judgeConfig });
    const arg = name => args[args.indexOf(name) + 1];
    const panel = arg('--panel');
    const out = arg('--out');
    const adapter = await import(pathToFileURL(arg('--provider')));
    await fs.mkdir(out, { recursive: true });
    if (calls.length === failAt) {
      await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ status: 'failed' }));
      signal?.abort(new Error('interrupted mock call'));
      throw new Error('mock dispatch failed');
    }
    // Cache immutable mock fixtures, not task or judge input snapshots.
    if (!captures.has(panel)) captures.set(panel, await read(path.join(root, `examples/${panel}.json`)));
    const input = structuredClone(captures.get(panel));
    if (panel === 'fcd') {
      const feed = context.catalog.sources.find(feed => feed.sourceId === arg('--feed-id'));
      input.episodes = input.episodes.filter(episode => episode.eligible).slice(0, 1);
      input.episodes[0].id = feed.contract.queryId;
      input.episodes[0].providerId = adapter.providerId;
      input.version = 'freshsearch-fcd-capture-v1';
      input.episodes[0].referenceAsOf = '2026-11-05T18:00:00.000Z';
    } else {
      input.records = input.records.slice(0, 1);
      input.records[0].providerId = adapter.providerId;
      input.records[0].queryId = efTasks.tasks[0].queryId;
      input.records[0].category = efTasks.tasks[0].category;
      input.records[0].tier = efTasks.tasks[0].tier;
    }
    const scored = scoreCapture(input, panel);
    if (!sourceMetadata) {
      sourceMetadata = { sourceHashes: await benchmarkSourceHashes() };
    }
    const sourceHashes = { ...sourceMetadata.sourceHashes };
    const judge = panel === 'ef' ? judgeConfig : null;
    const providerFile = arg('--provider');
    if (!identities.has(providerFile)) identities.set(providerFile, await adapterIdentity(pathToFileURL(providerFile)));
    const shared = panel === 'fcd' ? fcdReference ?? {
      referenceId: `00000000-0000-4000-8000-${String(calls.length).padStart(12, '0')}`,
      feedId: arg('--feed-id'), fixture: true,
    } : null;
    const full = { version: 'freshsearch-launch-report-v1', panel, kind: 'live-capture',
      source: { outputSha256: sourceHashes[panel === 'ef' ? 'freshsearch-confirmed-clock.cjs' : 'freshsearch.cjs'] },
      policy: scored.policy,
      cases: scored.rows.map(row => ({
        ...row, searchMs: calls.length * 100, effectiveConfigHash: hash({ panel, provider: adapter.providerId }),
      })), summary: summarize(scored, panel),
      execution: { sourceHashes, adapter: structuredClone(identities.get(providerFile)),
        ...(shared ? { fcdReferenceId: shared.referenceId } : {}),
        judgeConfigHash: judge ? hash(judge) : null,
        reserved: { search: panel === 'fcd' ? 10 : 1, judge: panel === 'ef' ? 2 : 0 } } };
    const raw = metadataReport(full,
      `00000000-0000-4000-8000-${String(calls.length).padStart(12, '0')}`, receiptKey);
    if (shared) Object.defineProperty(raw, sharedFCDReference, { value: shared });
    await mutate?.(raw, calls.length);
    await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(raw));
    return raw;
  };
  return { invoke, calls, options };
}

test('one launch runs EF then FCD, preserves per-invocation budgets and automatically writes one private static report', async t => {
  const context = await setup(t, { feeds: 2, tasks: 2, providers: 2 });
  const mock = fakeEvaluator(context);
  const { manifest, summary } = await runEvaluation(context.values, { evaluate: mock.invoke, environment });
  assert.equal(manifest.status, 'complete');
  assert.equal(summary.completed, 8);
  assert.deepEqual(mock.calls.map(args => args[1]), ['ef', 'ef', 'ef', 'ef', 'fcd', 'fcd', 'fcd', 'fcd']);
  assert.deepEqual(manifest.assignments.map(row => row.panel), mock.calls.map(args => args[1]));
  assert.deepEqual(mock.options.slice(0, 4).map(options => options.efTasks.tasks[0].queryId),
    ['task-1', 'task-1', 'task-2', 'task-2']);
  assert.deepEqual(manifest.assignments.map(row => row.providerId),
    ['provider-1', 'provider-2', 'provider-1', 'provider-2',
      'provider-1', 'provider-2', 'provider-1', 'provider-2']);
  for (const [first, second] of [[4, 5], [6, 7]]) {
    assert.equal(mock.options[first].fcdReference, undefined);
    assert.equal(mock.options[second].fcdReference.referenceId, manifest.assignments[first].referenceId);
  }
  for (const args of mock.calls) {
    assert.equal(args[args.indexOf('--max-calls') + 1], args[1] === 'fcd' ? '10' : '1');
    if (args[1] === 'ef') assert.equal(args[args.indexOf('--max-judge-calls') + 1], '2');
  }
  const html = await fs.readFile(path.join(context.values.out, 'results.html'), 'utf8');
  assert.match(html, /Evaluation complete: 8\/8/);
  assert.equal((html.match(/class="provider-name"/g) ?? []).length, 2);
  assert.equal((html.match(/<svg\b/g) ?? []).length, 2);
  assert.equal((html.match(/<table\b/g) ?? []).length, 1);
  assert.ok(!/<(?:script|iframe|img|input|button|select)\b/i.test(html));
  assert.doesNotMatch(html, /Combined score not approved/);
  assert.ok(!html.includes(environment.FRESHSEARCH_JUDGE_API_KEY));
  assert.ok(!html.includes('judge.example.com'));
  assert.ok(!html.includes('requestTime'));
  assert.ok(!html.includes('https://publisher.example.com/'));
  assert.match(html, /scored targets found/);
  for (const file of ['evaluation.json', 'summary.json', 'results.html']) {
    const content = await fs.readFile(path.join(context.values.out, file), 'utf8');
    assert.ok(!content.includes(environment.FRESHSEARCH_JUDGE_API_KEY));
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(context.values.out, file))).mode & 0o777, 0o600);
  }
  await assert.rejects(runEvaluation(context.values, { evaluate: mock.invoke, environment }), /EEXIST/);
  assert.equal(mock.calls.length, 8);
});

test('FCD-only launch runs selected FCD96 feeds without EF input or judge configuration', async t => {
  const context = await setup(t, { feeds: 2, providers: 2 });
  const values = { ...fcdOnlyValues(context), 'search-delay-ms': '1500' };
  const mock = fakeEvaluator(context);
  const waits = [];
  const { manifest, summary } = await runEvaluation(values, {
    evaluate: mock.invoke, environment, wait: async (...args) => waits.push(args),
  });
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.judgeHash, null);
  assert.deepEqual(manifest.budgets, {
    'max-fcd-calls': 40, 'max-ef-calls': 0, 'max-judge-calls': 0,
  });
  assert.deepEqual(manifest.maximumAttempts, {
    'max-fcd-calls': 40, 'max-ef-calls': 0, 'max-judge-calls': 0,
  });
  assert.equal(summary.assigned, 4);
  assert.equal(summary.completed, 4);
  assert.ok(summary.panels.every(row => row.panel === 'fcd'));
  assert.deepEqual(manifest.pacing, { searchDelayMs: 1500 });
  assert.equal(waits.length, 3);
  assert.ok(mock.calls.every(args =>
    args.slice(args.indexOf('--search-delay-ms'), args.indexOf('--search-delay-ms') + 2).join(' ') ===
      '--search-delay-ms 1500'));
  assert.ok(mock.calls.every(args => args[1] === 'fcd' && !args.includes('--judge-config')));
  await assert.rejects(fs.stat(path.join(values.out, 'inputs')), /ENOENT/);
  assert.match(await fs.readFile(path.join(values.out, 'results.html'), 'utf8'), /Evaluation complete: 4\/4/);
});

test('FCD-only all-feed selection dispatches the complete current-launch FCD96 catalog', async t => {
  const context = await setup(t);
  const values = { ...fcdOnlyValues(context), 'all-fcd-feeds': true, 'max-fcd-calls': '960' };
  delete values['fcd-feeds'];
  const mock = fakeEvaluator(context);
  const { manifest, summary } = await runEvaluation(values, { evaluate: mock.invoke, environment });
  assert.equal(summary.completed, 96);
  assert.deepEqual(manifest.assignments.map(row => row.feedId),
    context.catalog.sources.map(feed => feed.sourceId));
});

test('EF-only launch runs selected tasks without FCD selection or budget', async t => {
  const context = await setup(t, { tasks: 2, providers: 2 });
  const values = { ...efOnlyValues(context), 'search-delay-ms': '1500' };
  const mock = fakeEvaluator(context);
  const waits = [];
  const { manifest, summary } = await runEvaluation(values, {
    evaluate: mock.invoke, environment, wait: async (...args) => waits.push(args),
  });
  assert.equal(manifest.status, 'complete');
  assert.match(manifest.judgeHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.budgets, {
    'max-fcd-calls': 0, 'max-ef-calls': 4, 'max-judge-calls': 8,
  });
  assert.deepEqual(manifest.maximumAttempts, {
    'max-fcd-calls': 0, 'max-ef-calls': 4, 'max-judge-calls': 8,
  });
  assert.equal(summary.assigned, 4);
  assert.equal(summary.completed, 4);
  assert.deepEqual(manifest.pacing, { searchDelayMs: 1500 });
  assert.equal(waits.length, 3);
  assert.ok(summary.panels.every(row => row.panel === 'ef'));
  assert.ok(mock.calls.every(args =>
    args.slice(args.indexOf('--search-delay-ms'), args.indexOf('--search-delay-ms') + 2).join(' ') ===
      '--search-delay-ms 1500'));
  assert.ok(mock.calls.every(args => args[1] === 'ef' && !args.includes('--feed-id')));
  await assert.rejects(fs.stat(path.join(values.out, 'inputs')), /ENOENT/);
  assert.match(await fs.readFile(path.join(values.out, 'results.html'), 'utf8'), /Evaluation complete: 4\/4/);
});

test('combined runner allocates corrective headroom without raising the requested aggregate judge cap', async t => {
  for (const budget of [6, 8, 12]) {
    const context = await setup(t, { providers: 3 });
    context.values['max-judge-calls'] = String(budget);
    let remaining = budget;
    let completed = 0;
    const mock = fakeEvaluator(context, { mutate(raw) {
      if (raw.panel !== 'ef') return;
      const grant = Math.min(2000, remaining - (2 - completed) * 2);
      const used = Math.min(grant, completed === 0 ? 1 : 3);
      raw.execution.reserved.judge = used;
      remaining -= used;
      completed++;
    } });
    await runEvaluation(context.values, { evaluate: mock.invoke, environment });
    const grants = mock.calls.filter(args => args[1] === 'ef')
      .map(args => Number(args[args.indexOf('--max-judge-calls') + 1]));
    assert.equal(grants[0], Math.min(2000, budget - 4));
    assert.equal(grants[1], Math.min(2000, budget - 3));
    assert.ok(remaining >= 0);
  }
});

test('invalid child judge accounting stops subsequent assignments', async t => {
  const context = await setup(t, { providers: 2 });
  const mock = fakeEvaluator(context, { mutate(raw) {
    if (raw.panel === 'ef') raw.execution.reserved.judge = 5;
  } });
  await assert.rejects(runEvaluation(context.values, { evaluate: mock.invoke, environment }),
    /judge reservation accounting/);
  assert.equal(mock.calls.length, 1);
});

test('current launch 96 feeds, 120 tasks and five providers generate one results.html without explicit-folder viewer limits', async t => {
  const context = await setup(t, { feeds: 96, tasks: 120, providers: 5 });
  const mock = fakeEvaluator(context);
  const { summary } = await runEvaluation(context.values, { evaluate: mock.invoke, environment });
  assert.equal(summary.assigned, 1080);
  assert.equal(summary.completed, 1080);
  assert.equal(mock.calls.length, 1080);
  for (const row of summary.panels) assert.equal(row.assigned, row.panel === 'fcd' ? 960 : 120);
  const html = await fs.readFile(path.join(context.values.out, 'results.html'), 'utf8');
  assert.match(html, /1080\/1080 invocations complete/);
  assert.equal((html.match(/class="provider-name"/g) ?? []).length, 5);
});

test('omitted EF selection uses native finance-first EF120 only with adequate explicit budgets', async t => {
  const context = await setup(t);
  delete context.values['ef-input'];
  const mock = fakeEvaluator(context);
  await assert.rejects(runEvaluation(context.values, { evaluate: mock.invoke, environment }),
    /max-ef-calls must be an integer from 120/);
  assert.equal(mock.calls.length, 0);
  context.values['max-ef-calls'] = '120';
  context.values['max-judge-calls'] = '240';
  const { manifest } = await runEvaluation(context.values, { evaluate: mock.invoke, environment });
  const current = await read(path.join(root, 'datasets/current-launch-ef120.json'));
  assert.deepEqual(manifest.assignments.slice(0, 120).map(row => row.unitId),
    current.queryIds);
  assert.ok(mock.calls.slice(0, 120).every(args => args[1] === 'ef'));
  assert.ok(mock.options.slice(0, 60).every(options => options.efTasks.tasks[0].category === 'finance'));
  assert.ok(mock.options.slice(60, 120).every(options => options.efTasks.tasks[0].category === 'weather'));
  assert.equal(mock.calls[120][1], 'fcd');
});

test('FCD aggregate uses earned/possible points and latency is weighted by scored cases, not run averages', async t => {
  const context = await setup(t, { feeds: 2 });
  const reports = [];
  const mock = fakeEvaluator(context, { mutate(raw) {
    if (raw.panel === 'fcd' && reports.length === 1) {
      raw.cases = Array.from({ length: 10 }, (_, i) => ({
        id: `${context.catalog.sources[1].contract.queryId}/${i + 1}`,
        providerId: 'provider-1', status: 'scored', score: 100, reason: 'hit',
        ageMinutes: 1500, points: 1, earnedPoints: 1, searchMs: 300,
        effectiveConfigHash: raw.cases[0].effectiveConfigHash,
      }));
      raw.summary = [{ providerId: 'provider-1', assignedRows: 10, scoredRows: 10, heldRows: 0,
        unknownRows: 0, zeroScoreRows: 0, assignedTargets: 10, heldFeeds: 0,
        coverage: 1, score: 100, earnedPoints: 10, possiblePoints: 10,
        eligibleTargets: 10, unavailableTargets: 0, excludedAgeTargets: 0 }];
    }
    if (raw.panel === 'fcd') reports.push(raw);
  } });
  const { summary } = await runEvaluation(context.values, { evaluate: mock.invoke, environment });
  const fcd = summary.panels.find(row => row.panel === 'fcd');
  const earned = reports.reduce((sum, raw) => sum + raw.summary[0].earnedPoints, 0);
  const possible = reports.reduce((sum, raw) => sum + raw.summary[0].possiblePoints, 0);
  assert.equal(fcd.score, 100 * earned / possible);
  assert.notEqual(fcd.score, reports.reduce((sum, raw) => sum + raw.summary[0].score, 0) / 2);
  const rows = reports.flatMap(raw => raw.cases).filter(row => row.status === 'scored');
  assert.equal(fcd.searchSeconds, rows.reduce((sum, row) => sum + row.searchMs, 0) / rows.length / 1000);
  assert.equal(fcd.coverage, rows.length / 20);
  assert.equal(fcd.retrieval.hits, rows.filter(row => row.score === 100).length);
  assert.equal(fcd.retrieval.misses, rows.filter(row => row.score === 0).length);
  assert.equal(fcd.retrieval.ageBands.reduce((sum, band) => sum + band.earnedPoints, 0), earned);
  assert.equal(fcd.retrieval.ageBands.reduce((sum, band) => sum + band.possiblePoints, 0), possible);
  assert.equal(fcd.retrieval.ageBands.find(band => band.label === '24h+').scored,
    rows.filter(row => row.ageMinutes >= 1440).length);
});

test('missing timing stays unmeasured rather than averaging a measured subset', async t => {
  const context = await setup(t, { tasks: 2 });
  const mock = fakeEvaluator(context, { mutate(raw, call) {
    if (raw.panel === 'ef' && call === 2) delete raw.cases[0].searchMs;
  } });
  const { summary } = await runEvaluation(context.values, { evaluate: mock.invoke, environment });
  assert.equal(summary.panels.find(row => row.panel === 'ef').searchSeconds, null);
});

test('EF averages scored tasks only while retaining held tasks in the full assignment denominator', async t => {
  const context = await setup(t, { tasks: 3 });
  const mock = fakeEvaluator(context, { mutate(raw, call) {
    if (raw.panel !== 'ef') return;
    const held = call === 3;
    raw.cases[0].status = held ? 'held' : 'scored';
    raw.cases[0].score = held ? null : call === 1 ? 100 : 0;
    Object.assign(raw.summary[0], { scoredRows: held ? 0 : 1, heldRows: held ? 1 : 0,
      zeroScoreRows: call === 2 ? 1 : 0, score: raw.cases[0].score, coverage: held ? 0 : 1 });
  } });
  const { summary } = await runEvaluation(context.values, { evaluate: mock.invoke, environment });
  const ef = summary.panels.find(row => row.panel === 'ef');
  assert.equal(ef.score, 50);
  assert.equal(ef.coverage, 2 / 3);
  assert.equal(ef.held, 1);
  assert.equal(ef.unknown, 0);
});

test('bound combined score averages category/tier cells rather than uneven task counts', async t => {
  const context = await setup(t, { tasks: 7 });
  const catalog = await read(path.join(root, 'datasets/current-launch-ef120.json'));
  const selected = ['weather', 'finance'].flatMap(category =>
    ['head', 'torso', 'tail'].map(tier =>
      catalog.tasks.find(candidate => candidate.category === category && candidate.tier === tier)));
  selected.splice(1, 0, { ...selected[0], queryId: 'extra-weather-head' });
  await fs.writeFile(context.taskFile, JSON.stringify({
    version: 'freshsearch-rt-tasks-v1', tasks: selected,
  }));
  const mock = fakeEvaluator(context, { mutate(raw, call) {
    if (raw.panel !== 'ef') return;
    const score = call === 1 || call === 2 ? 100 : 0;
    raw.cases[0].score = score;
    Object.assign(raw.summary[0], { score, zeroScoreRows: Number(score === 0) });
  } });
  const { summary } = await runEvaluation(context.values, { evaluate: mock.invoke, environment });
  const ef = summary.panels.find(panel => panel.panel === 'ef');
  const fcd = summary.panels.find(panel => panel.panel === 'fcd');
  assert.equal(ef.cells.length, 6);
  assert.equal(ef.score, 100 / 6);
  assert.notEqual(ef.score, 200 / 7);
  assert.equal(summary.combined[0].status, 'scored');
  assert.equal(summary.combined[0].score, 0.2 * ef.score + 0.8 * fcd.score);
});

test('combined score is withheld when the selected EF cohort omits required cells', async t => {
  const context = await setup(t);
  const mock = fakeEvaluator(context);
  const { summary } = await runEvaluation(context.values, { evaluate: mock.invoke, environment });
  assert.equal(summary.combined[0].status, 'incomplete');
  assert.equal(summary.combined[0].score, null);
});

for (const failAt of [1, 2, 3]) {
  test(`dispatch failure ${failAt} stops without retries and writes an incomplete report with pending opportunities`, async t => {
    const context = await setup(t, { tasks: 2 });
    const mock = fakeEvaluator(context, { failAt });
    await assert.rejects(runEvaluation(context.values, { evaluate: mock.invoke, environment }), error =>
      error.name === 'LiveRunError' && error.cause?.message === 'mock dispatch failed');
    assert.equal(mock.calls.length, failAt);
    const manifest = await read(path.join(context.values.out, 'evaluation.json'));
    const summary = await read(path.join(context.values.out, 'summary.json'));
    assert.equal(manifest.status, 'failed');
    assert.equal(summary.completed, failAt - 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.pending, 3 - failAt);
    assert.equal(summary.panels.find(row => row.panel === 'ef').assigned, 2);
    assert.equal(summary.panels.find(row => row.panel === 'ef').coverage, (failAt - 1) / 2);
    assert.match(await fs.readFile(path.join(context.values.out, 'results.html'), 'utf8'), /INCOMPLETE evaluation \(failed\)/);
    const fcd = summary.panels.find(row => row.panel === 'fcd');
    assert.equal(fcd.retrieval.hits + fcd.retrieval.misses, fcd.scored);
    if (failAt === 1) {
      assert.match(await fs.readFile(path.join(context.values.out, 'results.html'), 'utf8'), /hit rate unavailable/);
    }
    assert.deepEqual(await read(path.join(context.values.out, manifest.assignments[failAt - 1].directory, 'failure.json')),
      { status: 'failed' });
  });
}

test('cancellation retains an interrupted HTML report and does not start another assignment', async t => {
  const context = await setup(t);
  const controller = new AbortController();
  const mock = fakeEvaluator(context, { failAt: 1, signal: controller });
  await assert.rejects(runEvaluation(context.values, {
    evaluate: mock.invoke, environment, signal: controller.signal,
  }), /interrupted or timed out/);
  assert.equal(mock.calls.length, 1);
  const summary = await read(path.join(context.values.out, 'summary.json'));
  assert.equal(summary.status, 'interrupted');
  assert.match(await fs.readFile(path.join(context.values.out, 'results.html'), 'utf8'), /INCOMPLETE evaluation \(interrupted\)/);
});

const classified = message => safeLiveFailure(new Error(message)).error;

// Throws the given errors at 1-based call numbers; a numeric `judge` writes the child's checkpoint counters.
function failingEvaluator(context, failures, { controller } = {}) {
  const mock = fakeEvaluator(context);
  const invoke = async (args, options) => {
    const failure = failures[mock.calls.length + 1];
    if (!failure) return mock.invoke(args, options);
    mock.calls.push(args);
    mock.options.push(options);
    const out = args[args.indexOf('--out') + 1];
    await fs.mkdir(out, { recursive: true });
    if (failure.judge !== undefined) {
      await fs.writeFile(path.join(out, 'checkpoint.json'), JSON.stringify({ execution: {
        reserved: { search: 1, judge: failure.judge }, budgets: { search: 1, judge: 2 } } }));
    }
    if (failure.abort) controller.abort(new Error('interrupted mock call'));
    throw failure.error;
  };
  return { ...mock, invoke };
}

const progressWriter = () => {
  const lines = [];
  return { lines, write: text => { lines.push(...text.trimEnd().split('\n')); } };
};

test('continue-after-failure records a classified EF failure, deducts an unreadable allotment and ends partial', async t => {
  const context = await setup(t, { tasks: 3 });
  const values = { ...efOnlyValues(context), 'max-judge-calls': '10', 'continue-after-failure': true };
  const mock = failingEvaluator(context, { 1: { error: classified('Judge returned HTTP 503') } });
  const progress = progressWriter();
  const { manifest, summary } = await runEvaluation(values, { evaluate: mock.invoke, environment, progress });
  assert.equal(manifest.status, 'partial');
  assert.equal(manifest.failurePolicy, 'continue-after-classified-failure');
  assert.deepEqual(manifest.assignments.map(row => row.status), ['failed', 'complete', 'complete']);
  // No readable checkpoint: the whole first allotment (10 - 2 * 2 = 6) is deducted before the next allotment.
  assert.deepEqual(mock.calls.map(args => args[args.indexOf('--max-judge-calls') + 1]), ['6', '2', '2']);
  const { message, hint, ...failure } = manifest.assignments[0].failure;
  assert.deepEqual(failure, { reason: 'judge-http-503', panel: 'ef', category: 'weather', unitId: 'task-1',
    providerId: 'provider-1', calls: { search: null, searchLimit: 1, judge: null, judgeLimit: 6 } });
  assert.match(message, /HTTP 503/);
  assert.match(hint, /\S/);
  assert.equal(summary.status, 'partial');
  assert.deepEqual([summary.assigned, summary.completed, summary.failed, summary.skipped, summary.pending], [3, 2, 1, 0, 0]);
  assert.deepEqual(summary.coverage.byPanel, [{ panel: 'ef', completed: 2, assigned: 3 }]);
  assert.deepEqual(summary.coverage.byProvider, [{ providerId: 'provider-1', panel: 'ef', completed: 2, assigned: 3 }]);
  assert.equal(summary.combined[0].status, 'incomplete');
  assert.equal(summary.combined[0].score, null);
  const persisted = await read(path.join(context.values.out, 'summary.json'));
  assert.equal(persisted.status, 'partial');
  assert.equal(persisted.failures[0].reason, 'judge-http-503');
  const html = await fs.readFile(path.join(context.values.out, 'results.html'), 'utf8');
  assert.match(html, /PARTIAL evaluation/);
  assert.match(html, /EF 2\/3 tasks/);
  assert.match(html, /failed · judge-http-503 · EF · weather · provider-1 · task-1/);
  assert.equal((html.match(/<table\b/g) ?? []).length, 1);
  assert.ok(!/<(?:script|iframe|img|input|button|select)\b/i.test(html));
  assert.ok(!html.includes('judge.example.com') && !html.includes(environment.FRESHSEARCH_JUDGE_API_KEY));
  assert.match(progress.lines[0],
    /^\[1\/3\] EF weather · provider-1 · task-1 … running \| done 0 · failed 0 · skipped 0 \| judge 0\/10$/);
  assert.match(progress.lines[1], /^\[1\/3\] EF .* failed \(judge-http-503\) \| done 0 · failed 1 · skipped 0 \| judge 6\/10$/);
  assert.match(progress.lines.at(-1), /^\[3\/3\] .* complete \| done 2 · failed 1 · skipped 0 \| judge 10\/10$/);
});

test('continue-after-failure deducts readable child judge usage and caps implausible usage at the allotment', async t => {
  const context = await setup(t, { tasks: 3 });
  const values = { ...efOnlyValues(context), 'max-judge-calls': '10', 'continue-after-failure': true };
  const mock = failingEvaluator(context, { 1: { error: classified('Judge returned HTTP 503'), judge: 1 },
    3: { error: classified('Judge returned HTTP 429'), judge: 9 } });
  const progress = progressWriter();
  const { manifest } = await runEvaluation(values, { evaluate: mock.invoke, environment, progress });
  assert.deepEqual(mock.calls.map(args => Number(args[args.indexOf('--max-judge-calls') + 1])), [6, 7, 7]);
  assert.deepEqual(manifest.assignments.map(row => row.status), ['failed', 'complete', 'failed']);
  assert.equal(manifest.assignments[0].failure.calls.judge, 1);
  assert.match(progress.lines.at(-1), /judge 10\/10$/);
});

test('continue-after-failure still stops on unclassified errors and on interruption', async t => {
  const context = await setup(t, { tasks: 2 });
  const mock = failingEvaluator(context, { 1: { error: new Error('mock dispatch failed') } });
  await assert.rejects(runEvaluation({ ...efOnlyValues(context), 'continue-after-failure': true },
    { evaluate: mock.invoke, environment, progress: null }), { name: 'LiveRunError', reason: 'collection-or-validation-failed' });
  const stopped = await read(path.join(context.values.out, 'evaluation.json'));
  assert.equal(stopped.status, 'failed');
  assert.deepEqual(stopped.assignments.map(row => row.status), ['failed', 'pending']);
  assert.equal(stopped.failure.providerId, 'provider-1');
  assert.ok(!JSON.stringify(stopped).includes('mock dispatch failed'));

  const second = await setup(t, { tasks: 2 });
  const controller = new AbortController();
  const aborted = failingEvaluator(second, { 1: { error: classified('Judge returned HTTP 503'), abort: true } },
    { controller });
  await assert.rejects(runEvaluation({ ...efOnlyValues(second), 'continue-after-failure': true }, {
    evaluate: aborted.invoke, environment, signal: controller.signal, progress: null }));
  const interrupted = await read(path.join(second.values.out, 'evaluation.json'));
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(aborted.calls.length, 1);
});

test('default fail-fast stops on a classified failure with an actionable sanitized message', async t => {
  const context = await setup(t, { tasks: 2 });
  const mock = failingEvaluator(context, { 1: { error: classified('Judge returned HTTP 503'), judge: 2 } });
  const error = await runEvaluation(efOnlyValues(context), { evaluate: mock.invoke, environment, progress: null })
    .then(() => assert.fail('expected failure'), caught => caught);
  assert.equal(error.reason, 'judge-http-503');
  assert.match(error.message,
    /^judge-http-503 at EF · weather · provider-1 · task-1 \(search calls 1\/1, judge calls 2\/2\): .+ Hint: \S/);
  const manifest = await read(path.join(context.values.out, 'evaluation.json'));
  assert.equal(manifest.failurePolicy, 'fail-fast');
  assert.equal(manifest.status, 'failed');
  assert.deepEqual(manifest.assignments.map(row => row.status), ['failed', 'pending']);
  assert.deepEqual(manifest.failure.calls, { search: 1, searchLimit: 1, judge: 2, judgeLimit: 2 });
  assert.match(await fs.readFile(path.join(context.values.out, 'results.html'), 'utf8'), /FAILED evaluation \(failed\)/);
});

test('FCD failure before a shared reference skips the feed\'s remaining providers instead of rebinding', async t => {
  const context = await setup(t, { feeds: 2, providers: 2 });
  const transport = safeLiveFailure(new ProviderRequestError('mock request failed', 'provider-transport-failed')).error;
  const mock = failingEvaluator(context, { 1: { error: transport } });
  const progress = progressWriter();
  const { manifest, summary } = await runEvaluation({ ...fcdOnlyValues(context), 'continue-after-failure': true },
    { evaluate: mock.invoke, environment, progress });
  assert.equal(manifest.status, 'partial');
  assert.deepEqual(manifest.assignments.map(row => [row.status, row.reason]),
    [['failed', undefined], ['skipped', 'fcd-reference-unavailable'], ['complete', undefined], ['complete', undefined]]);
  assert.equal(mock.calls.length, 3);
  assert.equal(mock.options[1].fcdReference, undefined);
  assert.equal(mock.options[2].fcdReference.referenceId, manifest.assignments[2].referenceId);
  assert.equal(manifest.assignments[0].failure.reason, 'provider-transport-failed');
  assert.deepEqual([summary.completed, summary.failed, summary.skipped], [2, 1, 1]);
  assert.deepEqual(summary.coverage.byPanel, [{ panel: 'fcd', completed: 2, assigned: 4 }]);
  assert.ok(progress.lines.some(line => /^\[2\/4\] FCD · provider-2 · .* skipped \(fcd-reference-unavailable\)/.test(line)));
  assert.ok(progress.lines.every(line => !/https?:|judge \d/.test(line)));

  const bound = await setup(t, { feeds: 1, providers: 3 });
  const later = failingEvaluator(bound, { 2: { error: transport } });
  const result = await runEvaluation({ ...fcdOnlyValues(bound), 'continue-after-failure': true },
    { evaluate: later.invoke, environment, progress: null });
  assert.deepEqual(result.manifest.assignments.map(row => row.status), ['complete', 'failed', 'complete']);
  assert.equal(later.options[2].fcdReference.referenceId, result.manifest.assignments[0].referenceId);
  assert.equal(result.manifest.assignments[2].referenceId, result.manifest.assignments[0].referenceId);
});

test('quiet suppresses progress lines and the CLI exits 2 with a summary pointer for partial runs', async t => {
  const context = await setup(t);
  const progress = progressWriter();
  await runEvaluation({ ...efOnlyValues(context), quiet: true },
    { evaluate: fakeEvaluator(context).invoke, environment, progress });
  assert.deepEqual(progress.lines, []);
  const stderr = progressWriter();
  const partial = { manifest: { status: 'partial' }, output: 'out-dir', summary: { failed: 1, skipped: 2 } };
  assert.equal(await cli([], { stderr, run: async () => partial }), 2);
  assert.deepEqual(stderr.lines, [`Evaluation partial: 1 failed, 2 skipped; see ${path.join('out-dir', 'summary.json')}`]);
  assert.equal(await cli([], { stderr, run: async () => ({ manifest: { status: 'complete' } }) }), undefined);
  assert.equal(stderr.lines.length, 1);
});

for (const [name, mutate, message] of [
  ['policy', raw => { raw.policy.extraVersion = 'different'; }, /policy or provenance changed/],
  ['source', raw => { raw.source.outputSha256 = 'b'.repeat(64); }, /scorer or adapter changed/],
  ['adapter', raw => { raw.execution.adapter.entrySha256 = 'f'.repeat(64); }, /scorer or adapter changed/],
  ['settings', raw => { raw.cases.forEach(row => { row.effectiveConfigHash = 'f'.repeat(64); }); }, /provider configuration changed/],
  ['duplicate receipt', raw => { raw.receiptId = '00000000-0000-4000-8000-000000000001'; }, /Duplicate or missing/],
  ['wrong assignment', raw => { raw.cases[0].id = 'unrelated/1'; }, /another assignment/],
]) {
  test(`incompatible ${name} is excluded rather than pooled into the evaluation`, async t => {
    const context = await setup(t, { feeds: 2 });
    const mock = fakeEvaluator(context, { mutate(raw, call) { if (call === 3) mutate(raw); } });
    await assert.rejects(runEvaluation(context.values, { evaluate: mock.invoke, environment }), message);
    const summary = await read(path.join(context.values.out, 'summary.json'));
    assert.equal(summary.completed, 2);
    assert.equal(summary.failed, 1);
  });
}

test('preflight rejects invalid selections, budgets and credentials before dispatch or output creation', async t => {
  const context = await setup(t);
  let calls = 0;
  const evaluate = async () => { calls++; };
  for (const [updates, env, message] of [
    [{ live: false }, environment, /explicit --live/],
    [{ 'confirm-authorized-use': false }, environment, /confirm-authorized-use/],
    [{ 'max-fcd-calls': '9' }, environment, /max-fcd-calls/],
    [{ 'max-ef-calls': '0' }, environment, /max-ef-calls/],
    [{ 'max-judge-calls': '1' }, environment, /max-judge-calls/],
    [{}, {}, /FRESHSEARCH_JUDGE_API_KEY/],
    [{ provider: [path.join(root, 'providers/exa-auto.mjs')] }, { FRESHSEARCH_JUDGE_API_KEY: 'test-only' }, /EXA_API_KEY/],
    [{ 'fcd-feed-id': 'missing-feed', 'fcd-feeds': undefined }, environment, /Unknown FCD feed ID/],
    [{ 'fcd-feed-id': 'anything' }, environment, /Select exactly one/],
    [{ provider: [...context.values.provider, ...context.values.provider],
      'max-fcd-calls': '20', 'max-ef-calls': '2', 'max-judge-calls': '4' }, environment, /Duplicate provider/],
  ]) {
    await assert.rejects(runEvaluation({ ...context.values, ...updates }, { evaluate, environment: env }), message);
    await assert.rejects(fs.stat(context.values.out), /ENOENT/);
  }
  assert.equal(calls, 0);
  const input = await read(context.taskFile);
  input.tasks.push(input.tasks[0]);
  await fs.writeFile(context.taskFile, JSON.stringify(input));
  await assert.rejects(runEvaluation(context.values, { evaluate, environment }), /unique freshness query IDs/);
});

test('preflight reports feed-list lines and rejects placeholder judge before any call', async t => {
  const context = await setup(t);
  let calls = 0;
  const evaluate = async () => { calls++; };
  await fs.writeFile(context.feedFile, `# feed list\n\n${context.catalog.sources[0].sourceId}\nmissing-feed\n`);
  await assert.rejects(runEvaluation(context.values, { evaluate, environment }), /Unknown FCD feed ID on line 4: missing-feed/);
  await fs.writeFile(context.feedFile, `${context.catalog.sources[0].sourceId}\n${context.catalog.sources[0].sourceId}\n`);
  await assert.rejects(runEvaluation(context.values, { evaluate, environment }), /Duplicate FCD feed ID on line 2/);
  await fs.writeFile(context.feedFile, Buffer.from([0xff, 0xfe, 0x61, 0]));
  await assert.rejects(runEvaluation(context.values, { evaluate, environment }), /UTF-8, not UTF-16/);
  await fs.writeFile(context.feedFile, `${context.catalog.sources[0].sourceId}\n`);
  await fs.copyFile(path.join(root, 'examples/judge-config.json'), context.judgeFile);
  await assert.rejects(runEvaluation(context.values, { evaluate, environment }), /placeholder/);
  await assert.rejects(fs.stat(context.values.out), /ENOENT/);
  assert.equal(calls, 0);
});

test('FCD-only preflight requires exact FCD budgets and rejects ignored EF options', async t => {
  const context = await setup(t, { feeds: 2 });
  const values = fcdOnlyValues(context);
  const evaluate = async () => assert.fail('Preflight must not dispatch');
  await assert.rejects(runEvaluation({ ...values, 'max-fcd-calls': '19' }, { evaluate, environment }),
    /max-fcd-calls must be an integer from 20/);
  await assert.rejects(runEvaluation({ ...values, 'search-delay-ms': '60001' }, { evaluate, environment }),
    /search-delay-ms/);
  await assert.rejects(runEvaluation({ ...values, 'all-fcd-feeds': true }, { evaluate, environment }),
    /Select exactly one/);
  for (const update of [
    { 'ef-input': context.taskFile },
    { 'judge-config': context.judgeFile },
    { 'max-ef-calls': '1' },
    { 'max-judge-calls': '2' },
  ]) {
    await assert.rejects(runEvaluation({ ...values, ...update }, { evaluate, environment }),
      /--fcd-only does not accept EF input/);
  }
  await assert.rejects(fs.stat(values.out), /ENOENT/);
});

test('a locally extended feed catalog is not limited to the launch cohort size', async t => {
  const context = await setup(t);
  const copy = path.join(context.directory, 'benchmark');
  await fs.cp(root, copy, { recursive: true });
  const catalog = structuredClone(context.catalog);
  catalog.sources.push({ ...catalog.sources[0], sourceId: 'additional-feed',
    contract: { ...catalog.sources[0].contract, queryId: 'additional-feed' } });
  await fs.writeFile(path.join(copy, 'datasets', 'current-launch-fcd96.json'), JSON.stringify(catalog));
  const { runEvaluation: runCopy } = await import(pathToFileURL(path.join(copy, 'evaluate.mjs')));
  const values = { ...fcdOnlyValues(context), 'all-fcd-feeds': true, 'max-fcd-calls': '969' };
  delete values['fcd-feeds'];
  await assert.rejects(runCopy(values, { environment }), /max-fcd-calls must be an integer from 970/);
  await assert.rejects(fs.stat(values.out), /ENOENT/);
});

test('EF-only preflight requires EF budgets and rejects ignored FCD options', async t => {
  const context = await setup(t, { tasks: 2 });
  const values = efOnlyValues(context);
  const evaluate = async () => assert.fail('Preflight must not dispatch');
  await assert.rejects(runEvaluation({ ...values, 'max-ef-calls': '1' }, { evaluate, environment }),
    /max-ef-calls must be an integer from 2/);
  await assert.rejects(runEvaluation({ ...values, 'max-judge-calls': '3' }, { evaluate, environment }),
    /max-judge-calls must be an integer from 4/);
  for (const update of [
    { 'fcd-feed-id': context.catalog.sources[0].sourceId },
    { 'fcd-feeds': context.feedFile },
    { 'all-fcd-feeds': true },
    { 'max-fcd-calls': '10' },
  ]) {
    await assert.rejects(runEvaluation({ ...values, ...update }, { evaluate, environment }),
      /--ef-only does not accept FCD selection/);
  }
  await assert.rejects(runEvaluation({ ...values, 'fcd-only': true }, { evaluate, environment }),
    /Select only one/);
  await assert.rejects(runEvaluation({ ...values, 'search-delay-ms': '60001' }, { evaluate, environment }),
    /search-delay-ms/);
  await assert.rejects(fs.stat(values.out), /ENOENT/);
});

test('preflight uses built-in WebIQ endpoints and validates explicit overrides without dispatching', async t => {
  const context = await setup(t);
  const values = { ...context.values,
    provider: [path.join(root, 'providers/webiq.mjs'), path.join(root, 'providers/webiq-auto.mjs')],
    'max-fcd-calls': '20', 'max-ef-calls': '2', 'max-judge-calls': '4' };
  const env = { ...environment, WEBIQ_ENDPOINT: 'https://default.example.invalid/search' };
  const evaluate = async () => { assert.fail('Preflight must not dispatch'); };
  await assert.rejects(runEvaluation(values, { evaluate, environment: env }), /WEBIQ_API_KEY/);
  await assert.rejects(runEvaluation(values, {
    evaluate, environment: { ...env, WEBIQ_API_KEY: 'test-only', WEBIQ_ENDPOINT: 'http://web.example.invalid/search' },
  }), /HTTPS/);
  await assert.rejects(runEvaluation(values, {
    evaluate, environment: { ...env, WEBIQ_API_KEY: 'test-only', WEBIQ_AUTO_ENDPOINT: 'http://auto.example.invalid/search' },
  }), /HTTPS/);
});

test('judge configuration changes are rejected without incorporating the inconsistent result', async t => {
  const context = await setup(t);
  const mock = fakeEvaluator(context, { mutate(raw) {
    if (raw.panel === 'ef') raw.execution.judgeConfigFingerprint = 'f'.repeat(64);
  } });
  await assert.rejects(runEvaluation(context.values, { evaluate: mock.invoke, environment }), /judge configuration changed/);
  const summary = await read(path.join(context.values.out, 'summary.json'));
  assert.equal(summary.completed, 0);
  assert.equal(summary.panels.find(row => row.panel === 'ef').scored, 0);
});

test('judge input is snapshotted before dispatch so editing the original does not change later EF calls', async t => {
  const context = await setup(t, { tasks: 2 });
  const original = await read(context.judgeFile);
  const mock = fakeEvaluator(context, { async mutate(raw) {
    if (raw.panel === 'ef') await fs.writeFile(context.judgeFile, JSON.stringify({ ...original, model: 'changed-deployment' }));
  } });
  await runEvaluation(context.values, { evaluate: mock.invoke, environment });
  const judges = mock.options.filter((_, index) => mock.calls[index][1] === 'ef')
    .map(options => options.judgeConfig.model);
  assert.deepEqual(judges, [original.model, original.model]);
  assert.equal((await read(context.judgeFile)).model, 'changed-deployment');
  await assert.rejects(fs.stat(path.join(context.values.out, 'inputs')), /ENOENT/);
});

test('CLI help is offline and documents FCD-only and combined flags', async () => {
  await main(['--help']);
  await assert.rejects(main([]), /explicit --live/);
});

test('Node explicitly loads a local .env, keeps default and Auto endpoints distinct, and preserves terminal overrides', async t => {
  const context = await setup(t);
  await fs.writeFile(path.join(context.directory, '.env'),
    'WEBIQ_API_KEY="test-only-key#with-hash"\n' +
    'WEBIQ_ENDPOINT="https://default.example.invalid/search"\n' +
    'WEBIQ_AUTO_ENDPOINT="https://auto.example.invalid/search"\n');
  const env = { ...process.env };
  for (const name of ['WEBIQ_API_KEY', 'WEBIQ_ENDPOINT', 'WEBIQ_AUTO_ENDPOINT']) delete env[name];
  const check = `const assert=require('node:assert/strict');
    assert.equal(process.env.WEBIQ_API_KEY,'test-only-key#with-hash');
    assert.equal(process.env.WEBIQ_ENDPOINT,'https://default.example.invalid/search');
    assert.equal(process.env.WEBIQ_AUTO_ENDPOINT,'https://auto.example.invalid/search');`;
  const loaded = spawnSync(process.execPath, ['--env-file=.env', '-e', check],
    { cwd: context.directory, env, encoding: 'utf8' });
  assert.equal(loaded.status, 0, loaded.stderr);
  const unloaded = spawnSync(process.execPath, ['-e',
    "require('node:assert/strict').equal(process.env.WEBIQ_API_KEY,undefined)"],
  { cwd: context.directory, env, encoding: 'utf8' });
  assert.equal(unloaded.status, 0, unloaded.stderr);
  const overridden = spawnSync(process.execPath, ['--env-file=.env', '-e',
    "require('node:assert/strict').equal(process.env.WEBIQ_ENDPOINT,'https://override.example.invalid/search')"],
  { cwd: context.directory, env: { ...env, WEBIQ_ENDPOINT: 'https://override.example.invalid/search' }, encoding: 'utf8' });
  assert.equal(overridden.status, 0, overridden.stderr);
  const help = spawnSync(process.execPath, ['--env-file=.env', path.join(root, 'evaluate.mjs'), '--help'],
    { cwd: context.directory, env, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--max-fcd-calls/);
  assert.match(help.stdout, /--fcd-only/);
  assert.match(help.stdout, /--ef-only/);
  assert.match(help.stdout, /Runs EF then FCD/);
  assert.ok(!help.stdout.includes('test-only-key'));
});

test('real FCD-only entrypoint runs through the launcher with mocked publisher responses', async t => {
  const context = await setup(t, { feeds: 2 });
  const requests = mockPublisher(t);
  const { summary } = await runEvaluation(fcdOnlyValues(context));
  assert.equal(summary.status, 'complete');
  assert.equal(summary.completed, 2);
  assert.ok(summary.panels.every(row => row.panel === 'fcd'));
  assert.ok(requests() > 0);
  assert.match(await fs.readFile(path.join(context.values.out, 'results.html'), 'utf8'), /Evaluation complete/);
});

test('real EF-only entrypoint runs through the launcher without publisher requests', async t => {
  const context = await setup(t, { tasks: 2 });
  const requests = mockPublisher(t);
  const { summary } = await runEvaluation(efOnlyValues(context));
  assert.equal(summary.status, 'complete');
  assert.equal(summary.completed, 2);
  assert.ok(summary.panels.every(row => row.panel === 'ef'));
  assert.equal(requests(), 0);
  assert.match(await fs.readFile(path.join(context.values.out, 'results.html'), 'utf8'), /Evaluation complete/);
});

test('real FCD and EF entrypoints run unchanged through the launcher with mocked publisher responses and empty search evidence', async t => {
  const context = await setup(t);
  const requests = mockPublisher(t);
  const { summary } = await runEvaluation(context.values);
  assert.equal(summary.status, 'complete');
  assert.equal(summary.completed, 2);
  const fcd = summary.panels.find(row => row.panel === 'fcd');
  assert.equal(fcd.score, null);
  assert.equal(fcd.held, 10);
  assert.equal(fcd.coverage, 0);
  assert.equal(summary.panels.find(row => row.panel === 'ef').score, 0);
  assert.ok(requests() > 0);
  assert.match(await fs.readFile(path.join(context.values.out, 'results.html'), 'utf8'), /Evaluation complete/);
});

test('external cancellation reaches the real EF transport and retains reservations and an incomplete report', async t => {
  const context = await setup(t);
  mockPublisher(t);
  const controller = new AbortController();
  const previousAbort = globalThis.__freshsearchTestAbort;
  globalThis.__freshsearchTestAbort = () => controller.abort(new Error('test cancellation'));
  t.after(() => {
    if (previousAbort === undefined) delete globalThis.__freshsearchTestAbort;
    else globalThis.__freshsearchTestAbort = previousAbort;
  });
  await fs.writeFile(context.values.provider[0],
    "export const providerId = 'provider-1'; export const physicalRetries = 0;\n" +
    'export async function search() { return []; }\n' +
    'export async function searchFullResponse({ signal }) { globalThis.__freshsearchTestAbort(); signal.throwIfAborted(); return []; }\n');
  await assert.rejects(runEvaluation(context.values, { signal: controller.signal }), /interrupted or timed out/);
  const manifest = await read(path.join(context.values.out, 'evaluation.json'));
  assert.equal(manifest.status, 'interrupted');
  assert.equal(manifest.assignments[0].panel, 'ef');
  assert.equal(manifest.assignments[0].status, 'interrupted');
  assert.equal(manifest.assignments[1].panel, 'fcd');
  assert.equal(manifest.assignments[1].status, 'pending');
  const capture = await read(path.join(context.values.out, manifest.assignments[0].directory, 'checkpoint.json'));
  assert.equal(capture.execution.reserved.search, 1);
  assert.equal(capture.execution.reserved.judge, 0);
  assert.equal(capture.replayable, false);
  assert.match(capture.pendingTraceId, /^[a-f0-9-]{36}$/u);
  assert.match(await fs.readFile(path.join(context.values.out, 'results.html'), 'utf8'), /INCOMPLETE evaluation \(interrupted\)/);
});
