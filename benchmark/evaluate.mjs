// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import portable from './freshsearch-confirmed-clock.cjs';
import { main as runPanel, scorerIdentity, benchmarkSourceHashes } from './run.mjs';
import { adapterIdentity, ensure, hash, httpsEndpoint } from './trace.mjs';
import { judgeConfiguration } from './ef.mjs';
import { currentEFTask } from './ef-clock.mjs';
import { createTotals, addReport, evaluationSummary, renderEvaluation } from './evaluation-report.mjs';
import { continuableFailure, contextualFailure, failureRecord, newReceiptKey, receiptFingerprint,
  requireAuthorizedUse, requireSafeIdentifier, safeLiveFailure, sharedFCDReference } from './retention.mjs';
import { runCli } from './cli.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
const required = (environment, name) => ensure(typeof environment[name] === 'string' &&
  environment[name].trim(), `Set ${name}`);
const credentials = {
  'webiq.mjs': ['WEBIQ_API_KEY'],
  'webiq-auto.mjs': ['WEBIQ_API_KEY'],
  'perplexity.mjs': ['PERPLEXITY_API_KEY'],
  'exa-auto.mjs': ['EXA_API_KEY'],
  'parallel.mjs': ['PARALLEL_API_KEY'],
};
// Optional overrides of each adapter's built-in public endpoint.
const endpointOverrides = { 'webiq.mjs': 'WEBIQ_ENDPOINT', 'webiq-auto.mjs': 'WEBIQ_AUTO_ENDPOINT' };

export async function replaceEvaluationFileAtomically(pending, destination, {
  rename = fs.rename, wait = pause, platform = process.platform,
} = {}) {
  const delays = [10, 20, 40, 80, 160];
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(pending, destination);
      return;
    } catch (error) {
      if (platform !== 'win32' || !['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)
        || attempt >= delays.length) throw error;
      await wait(delays[attempt]);
    }
  }
}

export async function persistEvaluationCheckpoint(out, files, {
  writeFile = fs.writeFile, replace = replaceEvaluationFileAtomically,
} = {}) {
  const results = await Promise.allSettled(files.map(async ([filename, content]) => {
    const pending = path.join(out, `${filename}.pending`);
    await writeFile(pending, content, { mode: 0o600 });
    await replace(pending, path.join(out, filename));
  }));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Evaluation checkpoint failed');
}

async function prepare(values, environment) {
  ensure(values.live, 'Evaluation requires explicit --live authorization. Run with --help for usage.');
  requireAuthorizedUse(values);
  ensure(Array.isArray(values.provider) && values.provider.length > 0 && values.provider.length <= 20,
    'Select between 1 and 20 providers with --provider');
  const fcdOnly = values['fcd-only'] === true;
  const efOnly = values['ef-only'] === true;
  ensure(!(fcdOnly && efOnly), 'Select only one of --fcd-only or --ef-only');
  ensure(values.out, 'Require --out NEW_DIRECTORY');
  if (fcdOnly) {
    ensure(!values['ef-input'] && !values['judge-config'] &&
      values['max-ef-calls'] === undefined && values['max-judge-calls'] === undefined,
    '--fcd-only does not accept EF input, judge configuration or EF/judge budgets');
  } else if (efOnly) {
    ensure(!values['fcd-feed-id'] && !values['fcd-feeds'] && !values['all-fcd-feeds'] &&
      values['max-fcd-calls'] === undefined,
      '--ef-only does not accept FCD selection or an FCD budget');
    ensure(values['judge-config'], 'EF-only evaluation requires --judge-config FILE');
  } else {
    ensure(values['judge-config'], 'Combined evaluation requires --judge-config FILE');
  }
  const catalog = await read(path.join(root, 'datasets/current-launch-fcd96.json'));
  let feeds = [];
  if (!efOnly) {
    const selections = [values['fcd-feed-id'], values['fcd-feeds'], values['all-fcd-feeds']].filter(Boolean);
    ensure(selections.length === 1,
      'Select exactly one of --fcd-feed-id ID, --fcd-feeds FILE or --all-fcd-feeds');
    let lines;
    if (values['fcd-feeds']) {
      const data = await fs.readFile(path.resolve(values['fcd-feeds']));
      ensure(!(data[0] === 0xff && data[1] === 0xfe) && !(data[0] === 0xfe && data[1] === 0xff),
        'FCD feed list must be UTF-8, not UTF-16');
      lines = data.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
        .map((text, index) => ({ id: text.trim(), line: index + 1 }))
        .filter(row => row.id && !row.id.startsWith('#'));
    } else {
      lines = (values['all-fcd-feeds'] ? catalog.sources.map(feed => feed.sourceId) :
        [values['fcd-feed-id']]).map((id, index) => ({ id, line: index + 1 }));
    }
    const seenFeeds = new Set();
    for (const { id, line } of lines) {
      ensure(catalog.sources.some(feed => feed.sourceId === id), `Unknown FCD feed ID on line ${line}: ${id}`);
      ensure(!seenFeeds.has(id), `Duplicate FCD feed ID on line ${line}: ${id}`);
      seenFeeds.add(id);
    }
    feeds = lines.map(row => row.id);
    ensure(feeds.length > 0, 'FCD selection must contain at least one unique feed ID');
  }
  let tasks = [];
  if (!fcdOnly) {
    const input = await read(values['ef-input'] ? path.resolve(values['ef-input']) :
      path.join(root, 'datasets/current-launch-ef120.json'));
    ensure(input.version === 'freshsearch-rt-tasks-v1' && Array.isArray(input.tasks) &&
      input.tasks.length > 0 && input.tasks.length <= 1000, 'Require 1-1000 EF task contracts');
    tasks = input.tasks.map(currentEFTask);
    for (const task of tasks) requireSafeIdentifier(task.queryId, 'EF task ID');
    ensure(tasks.every(task => task.panel === 'freshness') &&
      new Set(tasks.map(task => task.queryId)).size === tasks.length, 'EF tasks require unique freshness query IDs');
  }
  const count = values.provider.length;
  const searchDelayMs = Number(values['search-delay-ms'] ?? 0);
  ensure(Number.isSafeInteger(searchDelayMs) && searchDelayMs >= 0 && searchDelayMs <= 60000,
    'search-delay-ms must be an integer from 0 to 60000');
  ensure((feeds.length + tasks.length) * count <= 5000, 'Evaluation exceeds 5000 assignments');
  const needed = { 'max-fcd-calls': feeds.length * count * 10,
    'max-ef-calls': tasks.length * count, 'max-judge-calls': tasks.length * count * 2 };
  const budgets = { 'max-fcd-calls': 0, 'max-ef-calls': 0, 'max-judge-calls': 0 };
  for (const [name, minimum] of Object.entries(needed).filter(([name]) =>
    fcdOnly ? name === 'max-fcd-calls' : efOnly ? name !== 'max-fcd-calls' : true)) {
    const budget = Number(values[name]);
    ensure(Number.isSafeInteger(budget) && budget >= minimum && budget <= 50000,
      `${name} must be an integer from ${minimum} to 50000 for this selection`);
    budgets[name] = budget;
  }
  const judge = fcdOnly ? null :
    judgeConfiguration(await read(path.resolve(values['judge-config'])), environment);
  if (tasks.some(task => task.category === 'weather')) {
    portable.assertFreshSearchClockRuntime(portable.FRESH_SEARCH_SUPPORTED_WEATHER_CLOCK_VALIDATION.runtime);
  }
  const providers = [];
  for (const filename of values.provider) {
    const file = path.resolve(filename);
    const names = path.dirname(file) === path.join(root, 'providers') ? credentials[path.basename(file)] : null;
    for (const name of names ?? []) required(environment, name);
    const overrideName = names ? endpointOverrides[path.basename(file)] : undefined;
    if (overrideName && environment[overrideName]?.trim()) httpsEndpoint(environment[overrideName].trim());
    const adapter = await import(pathToFileURL(file));
    requireSafeIdentifier(adapter.providerId, 'Provider ID');
    ensure(typeof adapter.providerId === 'string' && adapter.providerId.length > 0 &&
      adapter.providerId.length <= 200 && adapter.physicalRetries === 0 && typeof adapter.search === 'function',
    'Provider must export providerId, physicalRetries=0 and search');
    if (tasks.length) ensure(typeof adapter.searchFullResponse === 'function',
      'EF provider must export searchFullResponse');
    ensure(!providers.some(provider => provider.providerId === adapter.providerId), 'Duplicate provider ID');
    providers.push({ file, providerId: adapter.providerId, identity: await adapterIdentity(pathToFileURL(file)) });
  }
  const sourceHashes = await benchmarkSourceHashes();
  return { feeds: feeds.map(id => catalog.sources.find(feed => feed.sourceId === id)),
    tasks, providers, budgets, needed, judge, fcdOnly, efOnly, searchDelayMs, sourceHashes,
    source: await scorerIdentity(sourceHashes['freshsearch.cjs']),
    confirmedClockSource: await scorerIdentity(sourceHashes['freshsearch-confirmed-clock.cjs'], true) };
}

// Reads only call counters from a child's metadata-only checkpoint; null when unavailable.
async function childCalls(directory) {
  try {
    const { execution } = await read(path.join(directory, 'checkpoint.json'));
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    return { search: count(execution?.reserved?.search), searchLimit: count(execution?.budgets?.search),
      judge: count(execution?.reserved?.judge), judgeLimit: count(execution?.budgets?.judge) };
  } catch {
    return null;
  }
}

export async function runEvaluation(values, {
  evaluate = runPanel, environment = process.env, signal, wait = pause, progress = process.stderr,
} = {}) {
  const plan = await prepare(values, environment);
  signal?.throwIfAborted();
  const continueAfterFailure = values['continue-after-failure'] === true;
  const write = values.quiet === true || !progress ? () => {} : line => progress.write(`${line}\n`);
  const receiptKey = newReceiptKey();
  const out = path.resolve(values.out);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(out, { mode: 0o700 });
  const manifest = { version: 'freshsearch-evaluation-v1', id: randomUUID(), status: 'running',
    startedAt: new Date().toISOString(), finishedAt: null,
    sourceHash: hash(plan.sourceHashes), scorerHash: plan.source.outputSha256,
    confirmedClockScorerHash: plan.confirmedClockSource.outputSha256,
    cohortHash: receiptFingerprint(receiptKey, { feeds: plan.feeds.map(feed => feed.sourceId),
      tasks: plan.tasks.map(task => hash(task)) }),
    combinedPolicy: { version: 'freshsearch-combined-v1',
      weights: { evidenceFreshness: 0.2, freshContentDiscovery: 0.8 } },
    judgeHash: plan.judge ? receiptFingerprint(receiptKey, hash(plan.judge)) : null,
    pacing: { searchDelayMs: plan.searchDelayMs },
    failurePolicy: continueAfterFailure ? 'continue-after-classified-failure' : 'fail-fast',
    budgets: plan.budgets, maximumAttempts: { ...plan.needed,
      'max-judge-calls': plan.judge ? plan.budgets['max-judge-calls'] : 0 },
    providers: plan.providers.map(provider => ({
      providerId: provider.providerId, adapterHash: hash(provider.identity),
    })), assignments: [] };
  for (const [taskIndex, task] of plan.tasks.entries()) {
    for (const [providerIndex, provider] of plan.providers.entries()) {
      manifest.assignments.push({ panel: 'ef', providerId: provider.providerId, providerIndex,
        unitId: task.queryId, category: task.category, tier: task.tier, taskIndex,
        taskHash: receiptFingerprint(receiptKey, hash(task)),
        directory: `ef/provider-${providerIndex + 1}/task-${taskIndex + 1}`, status: 'pending' });
    }
  }
  for (const [feedIndex, feed] of plan.feeds.entries()) {
    for (const [providerIndex, provider] of plan.providers.entries()) {
      manifest.assignments.push({ panel: 'fcd', providerId: provider.providerId, providerIndex,
        unitId: feed.contract.queryId, feedId: feed.sourceId,
        directory: `fcd/provider-${providerIndex + 1}/feed-${feedIndex + 1}`, status: 'pending' });
    }
  }
  const totals = createTotals(manifest.assignments);
  const fingerprints = new Map();
  const fcdReferences = new Map();
  const persist = async () => {
    await persistEvaluationCheckpoint(out, [
      ['evaluation.json', JSON.stringify(manifest, null, 2) + '\n'],
      ['summary.json', JSON.stringify(evaluationSummary(manifest, totals), null, 2) + '\n'],
      ['results.html', renderEvaluation(manifest, totals)],
    ]);
  };
  let current;
  let currentJudgeLimit = 0;
  let failure;
  let remainingJudgeCalls = plan.budgets['max-judge-calls'];
  let remainingEF = plan.tasks.length * plan.providers.length;
  let priorAssignment = false;
  const total = manifest.assignments.length;
  const tally = status => manifest.assignments.filter(row => row.status === status).length;
  const describe = (assignment, index) => `[${index + 1}/${total}] ${assignment.panel.toUpperCase()}` +
    `${assignment.category ? ` ${assignment.category}` : ''} · ${assignment.providerId} · ` +
    `${assignment.feedId ?? assignment.unitId}`;
  const status = () => `done ${tally('complete')} · failed ${tally('failed')} · skipped ${tally('skipped')}` +
    (plan.judge ? ` | judge ${plan.budgets['max-judge-calls'] - remainingJudgeCalls}/${plan.budgets['max-judge-calls']}` : '');
  const contextFor = async (assignment, judgeLimit) => {
    const calls = await childCalls(path.join(out, assignment.directory));
    return { panel: assignment.panel, category: assignment.category, unitId: assignment.unitId,
      feedId: assignment.feedId, providerId: assignment.providerId,
      calls: { search: calls?.search ?? null, searchLimit: assignment.panel === 'fcd' ? 10 : 1,
        judge: assignment.panel === 'ef' ? calls?.judge ?? null : 0, judgeLimit } };
  };
  try {
    await persist();
    for (const [index, assignment] of manifest.assignments.entries()) {
      signal?.throwIfAborted();
      if (assignment.status === 'skipped') {
        write(`${describe(assignment, index)} … skipped (${assignment.reason}) | ${status()}`);
        continue;
      }
      if (priorAssignment && plan.searchDelayMs > 0) {
        await wait(plan.searchDelayMs, undefined, { signal });
        signal?.throwIfAborted();
      }
      current = assignment;
      assignment.status = 'running';
      await persist();
      write(`${describe(assignment, index)} … running | ${status()}`);
      const provider = plan.providers[assignment.providerIndex];
      const args = ['--panel', assignment.panel, '--live', '--confirm-authorized-use', '--provider', provider.file,
        '--max-calls', assignment.panel === 'fcd' ? '10' : '1',
        '--search-delay-ms', String(plan.searchDelayMs),
        '--out', path.join(out, assignment.directory)];
      if (assignment.panel === 'fcd') args.push('--feed-id', assignment.feedId);
      const judgeLimit = assignment.panel === 'ef'
        ? Math.min(2000, remainingJudgeCalls - (remainingEF - 1) * 2) : 0;
      if (assignment.panel === 'ef') args.push('--max-judge-calls', String(judgeLimit));
      currentJudgeLimit = judgeLimit;
      let report;
      try {
        report = await evaluate(args, {
          signal,
          fcdReference: fcdReferences.get(assignment.feedId),
          efTasks: assignment.panel === 'ef'
            ? { version: 'freshsearch-rt-tasks-v1', tasks: [plan.tasks[assignment.taskIndex]] } : undefined,
          judgeConfig: assignment.panel === 'ef' ? plan.judge : undefined,
          receiptKey,
        });
      } catch (error) {
        const safe = safeLiveFailure(error, signal?.aborted);
        if (!continueAfterFailure || signal?.aborted || !continuableFailure(safe.reason)) throw error;
        const context = await contextFor(assignment, judgeLimit);
        if (assignment.panel === 'ef') {
          // Conservative: an unreadable or implausible judge count consumes the whole allotment.
          const used = context.calls.judge;
          remainingJudgeCalls -= Number.isSafeInteger(used) && used <= judgeLimit ? used : judgeLimit;
          remainingEF--;
        } else if (!fcdReferences.has(assignment.feedId)) {
          for (const row of manifest.assignments) {
            if (row.panel === 'fcd' && row.feedId === assignment.feedId && row.status === 'pending') {
              row.status = 'skipped';
              row.reason = 'fcd-reference-unavailable';
            }
          }
        } else if (assignment.providerIndex + 1 === plan.providers.length) fcdReferences.delete(assignment.feedId);
        assignment.status = 'failed';
        assignment.failure = failureRecord(safe.error, context);
        priorAssignment = true;
        current = null;
        await persist();
        write(`${describe(assignment, index)} … failed (${safe.reason}) | ${status()}`);
        continue;
      }
      if (assignment.panel === 'fcd') {
        const shared = report[sharedFCDReference];
        ensure(shared && shared.feedId === assignment.feedId &&
          report.execution?.fcdReferenceId === shared.referenceId, 'FCD report lacks its bound reference');
        const previous = fcdReferences.get(assignment.feedId);
        ensure(!previous || hash(previous) === hash(shared), 'FCD providers used different reference cohorts');
        if (assignment.providerIndex + 1 === plan.providers.length) fcdReferences.delete(assignment.feedId);
        else fcdReferences.set(assignment.feedId, shared);
        assignment.referenceId = shared.referenceId;
      }
      if (assignment.panel === 'ef') {
        const used = report.execution?.reserved?.judge;
        ensure(Number.isSafeInteger(used) && used >= 0 && used <= judgeLimit,
          'Evaluation report has invalid judge reservation accounting');
        remainingJudgeCalls -= used;
        remainingEF--;
      }
      addReport(totals, assignment, report, { sourceHash: manifest.sourceHash,
        scorerHash: assignment.panel === 'ef' ? manifest.confirmedClockScorerHash : manifest.scorerHash,
        adapterHash: hash(provider.identity),
        judgeHash: manifest.judgeHash }, fingerprints);
      assignment.status = 'complete';
      priorAssignment = true;
      current = null;
      await persist();
      write(`${describe(assignment, index)} … complete | ${status()}`);
    }
    manifest.status = manifest.assignments.every(row => row.status === 'complete') ? 'complete' : 'partial';
  } catch (error) {
    const safe = safeLiveFailure(error, signal?.aborted).error;
    const record = failureRecord(safe, current ? await contextFor(current, currentJudgeLimit) : {});
    failure = current ? contextualFailure(safe, record) : safe;
    manifest.failure = record;
    manifest.status = signal?.aborted ? 'interrupted' : 'failed';
    if (current) {
      current.status = manifest.status;
      current.failure = record;
    }
  } finally {
    manifest.finishedAt = new Date().toISOString();
    try {
      await persist();
    } catch (error) {
      if (failure) throw new AggregateError([failure, error], 'Evaluation failed and reporting failed; inspect retained outputs');
      throw error;
    }
  }
  console.log(JSON.stringify({ status: manifest.status, output: out, report: path.join(out, 'results.html') }));
  if (failure) throw failure;
  return { manifest, output: out, summary: evaluationSummary(manifest, totals) };
}

export async function main(args = process.argv.slice(2), { progress = process.stderr } = {}) {
  const { values } = parseArgs({ args, options: {
    live: { type: 'boolean', default: false }, provider: { type: 'string', multiple: true },
    'fcd-only': { type: 'boolean', default: false },
    'ef-only': { type: 'boolean', default: false },
    'fcd-feed-id': { type: 'string' }, 'fcd-feeds': { type: 'string' },
    'all-fcd-feeds': { type: 'boolean', default: false }, 'search-delay-ms': { type: 'string' },
    'ef-input': { type: 'string' }, 'judge-config': { type: 'string' }, out: { type: 'string' },
    'max-fcd-calls': { type: 'string' }, 'max-ef-calls': { type: 'string' },
    'max-judge-calls': { type: 'string' }, help: { type: 'boolean', default: false },
    'confirm-authorized-use': { type: 'boolean', default: false },
    'continue-after-failure': { type: 'boolean', default: false }, quiet: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage:\n  FCD only: node evaluate.mjs --live --confirm-authorized-use --fcd-only --provider MODULE [--provider MODULE ...] ' +
      '(--fcd-feed-id ID | --fcd-feeds FILE | --all-fcd-feeds) [--search-delay-ms N] ' +
      '--max-fcd-calls N --out NEW_DIRECTORY\n' +
      '  EF only: node evaluate.mjs --live --confirm-authorized-use --ef-only --provider MODULE [--provider MODULE ...] ' +
      '[--ef-input FILE] --judge-config FILE [--search-delay-ms N] ' +
      '--max-ef-calls N --max-judge-calls N --out NEW_DIRECTORY\n' +
      '  Both: node evaluate.mjs --live --confirm-authorized-use --provider MODULE [--provider MODULE ...] ' +
      '(--fcd-feed-id ID | --fcd-feeds FILE | --all-fcd-feeds) [--search-delay-ms N] ' +
      '[--ef-input FILE] --judge-config FILE ' +
      '--max-fcd-calls N --max-ef-calls N --max-judge-calls N --out NEW_DIRECTORY\n' +
      '\nOptions:\n' +
      '  --live                         Authorize live calls.\n' +
      '  --confirm-authorized-use       Affirm rights to collect, judge and retain derived scores.\n' +
      '  --provider MODULE              Search adapter; repeat for each provider.\n' +
      '  --fcd-only / --ef-only         Run one panel instead of both.\n' +
      '  --fcd-feed-id ID               Select one feed.\n' +
      '  --fcd-feeds FILE               Select feed IDs from a UTF-8 file.\n' +
      '  --all-fcd-feeds                Select all feeds.\n' +
      '  --ef-input FILE                EF tasks (default: EF120).\n' +
      '  --judge-config FILE            EF judge configuration.\n' +
      '  --max-fcd-calls N              FCD search budget.\n' +
      '  --max-ef-calls N               EF search budget.\n' +
      '  --max-judge-calls N            Judge call budget.\n' +
      '  --search-delay-ms N            Search pacing, 0-60000 (default 0).\n' +
      '  --out NEW_DIRECTORY            Destination; must not exist.\n' +
      '  --continue-after-failure       Record classified assignment failures and continue; ends partial (exit 2).\n' +
      '  --quiet                        Suppress per-assignment progress lines on stderr.\n' +
      '  --help                         Show this help.\n\n' +
      'Runs EF then FCD when both are selected. Default EF120 runs Finance before Weather; ' +
      'custom EF input keeps its supplied task order. ' +
      'Automatically writes results.html, including incomplete runs. ' +
      '--search-delay-ms N (0-60000; default 0) paces invocations and searches within FCD feeds; ' +
      'it does not automatically retry rate-limit errors. ' +
      'Confirmed-clock judging may require multiple calls per returned source, including repair attempts. ' +
      'The judge budget caps attempts, not spending; an exhausted budget stops the run. ' +
      'Live outputs are metadata-only and cannot replay provider evidence or judge responses.');
    return;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Evaluation interrupted; inspect results.html and retained outputs'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    return await runEvaluation(values, { signal: controller.signal, progress });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

// Returns the process exit code: 2 for a partial run, otherwise undefined (errors propagate).
export async function cli(args = process.argv.slice(2), { stderr = process.stderr, run = main } = {}) {
  const result = await run(args, { progress: stderr });
  if (result?.manifest?.status !== 'partial') return undefined;
  const { failed, skipped } = result.summary;
  const output = result.output;
  stderr.write(`Evaluation partial: ${failed} failed, ${skipped} skipped; see ${path.join(output, 'summary.json')}\n`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(async () => {
    const code = await cli();
    if (code) process.exitCode = code;
  });
}
