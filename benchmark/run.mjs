// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import freshsearch from './freshsearch.cjs';
import { runtimeIdentity } from './runtime.mjs';
import { ProviderRequestError } from './providers/shared.mjs';
import { adapterIdentity, captureSearch, caseTrace, hash } from './trace.mjs';
import { judgeConfiguration, validateEFTrace } from './ef.mjs';
import { currentEFTask, evaluateConfirmedClockEF, scoreConfirmedClockEFCapture,
  CONFIRMED_CLOCK_EF_CAPTURE_VERSION } from './ef-clock.mjs';
import { failureHint, metadataCheckpoint, metadataReport, newReceiptKey, requireAuthorizedUse, requireSafeIdentifier,
  safeLiveFailure, sharedFCDReference } from './retention.mjs';
import { runCli } from './cli.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const usage = [
  'Usage:',
  '  node run.mjs --panel ef|fcd --input CAPTURE.json --out NEW_DIRECTORY',
  '  node run.mjs --panel fcd --live --confirm-authorized-use --provider MODULE.mjs --feed-id FEED_ID --max-calls N [--search-delay-ms N] --out NEW_DIRECTORY',
  '  node run.mjs --panel ef --live --confirm-authorized-use --provider MODULE.mjs [--input TASKS.json] --judge-config FILE',
  '    --max-calls N --max-judge-calls N --out NEW_DIRECTORY',
  '',
  'Without --live, scores a retained capture offline; no provider, publisher or judge calls are made.',
  '--live calls the provider adapter, publishers (FCD) and the judge (EF). Authorize access and spending first.',
  '--confirm-authorized-use affirms rights for collection, judging, derived scores and sharing.',
  'Live outputs contain metadata only and cannot replay provider evidence or judge responses.',
  'Live FCD needs at least 10 searches per feed; EF requires explicit search and judge call budgets.',
  '--search-delay-ms N (0-60000; default 0) delays subsequent FCD searches within an invocation.',
  'Use evaluate.mjs for pacing between feed/task/provider invocations. Delays are not automatic rate-limit retries.',
  '--out must be a new folder; existing results are never overwritten.',
].join('\n');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = async name => JSON.parse(await fs.readFile(name, 'utf8'));
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const timestamp = value => typeof value === 'string' && /(Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const fcdCaptureVersion = 'freshsearch-fcd-capture-v1';
const fcdScoringVersion = 'freshsearch-fcd-provider-performance-v1';
const fcdAgeWeightVersion = 'freshsearch-fcd-age-weight-v1';
const logger = {
  info: message => console.error(message),
  warn: message => console.error(message),
  error: message => console.error(message),
};

export async function replaceCaptureFileAtomically(pending, destination, {
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
const csvCell = value => {
  const text = String(value ?? '');
  const formula = typeof value === 'string' &&
    (/^[\s\u0000-\u001f\u007f-\u009f\u200b]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text));
  return `"${(formula ? `'${text}` : text).replaceAll('"', '""')}"`;
};

export async function waitForSearchPacing(previousCalls, delayMs, {
  wait = pause, signal,
} = {}) {
  ensure(Number.isSafeInteger(previousCalls) && previousCalls >= 0, 'previous search calls must be non-negative');
  ensure(Number.isSafeInteger(delayMs) && delayMs >= 0 && delayMs <= 60000,
    'search-delay-ms must be an integer from 0 to 60000');
  if (previousCalls > 0 && delayMs > 0) await wait(delayMs, undefined, { signal });
}

export function knownItemCaptureDeadline(referenceAsOf, publishedAt, executionDeadlineAtMs) {
  const referenceMs = Date.parse(referenceAsOf);
  const publishedMs = Date.parse(publishedAt);
  const ageMs = referenceMs - publishedMs;
  ensure(Number.isFinite(ageMs) && ageMs >= 0,
    'Known-item capture requires a valid publication at or before its reference');
  ensure(executionDeadlineAtMs === undefined || Number.isFinite(executionDeadlineAtMs),
    'Known-item capture requires a finite worker execution deadline');
  const policy = freshsearch.knownItemPolicy;
  const band = policy.FRESH_CONTENT_DISCOVERY_AGE_BANDS.find(item =>
    item.maxAgeMinutes === null || ageMs < item.maxAgeMinutes * 60000);
  ensure(band, 'Known-item capture has no canonical freshness age band');
  const episodeEnd = referenceMs + policy.KNOWN_ITEM_CAPTURE_MAX_AGE_MS;
  const workerEnd = executionDeadlineAtMs === undefined ? Infinity :
    executionDeadlineAtMs - policy.KNOWN_ITEM_CAPTURE_SETTLEMENT_RESERVE_MS;
  const captureEnd = Math.min(episodeEnd, workerEnd);
  const bandEnd = band.maxAgeMinutes === null ? Infinity : publishedMs + band.maxAgeMinutes * 60000;
  return bandEnd <= captureEnd ? { expiresAtMs: bandEnd, reason: 'scoring-age-band-expired' } :
    { expiresAtMs: captureEnd, reason: workerEnd < episodeEnd ?
      'worker-settlement-window' : 'capture-window-expired' };
}

function validateFCDReference(input, episode) {
  const shared = input.execution?.fcdReference;
  ensure(shared && shared.reference && shared.contract && shared.contractHash === hash(shared.contract) &&
    input.execution.fcdReferenceHash === hash(shared) && shared.contract.queryId === episode.id &&
    hash(shared.reference) === hash(episode.reference) && shared.reference.eligible === episode.eligible &&
    episode.referenceAsOf === shared.reference.observedAt, 'FCD shared-reference binding mismatch');
  if (!episode.eligible) {
    ensure(shared.proof === null, 'Ineligible FCD reference cannot have an access proof');
    return;
  }
  const proof = shared.proof;
  ensure(proof && hash(proof) === hash(episode.accessProof), 'FCD access proof binding mismatch');
  const binding = { batchId: proof.batchId, itemId: proof.itemId,
    generation: proof.generation, manifestHash: proof.manifestHash };
  ensure(proof.itemId === episode.id &&
    hash(freshsearch.createJustInTimeAccessProof(shared.contract, shared.reference, binding)) === hash(proof),
  'FCD access proof differs from its reference');
  const targetIdentity = target => ({ rank: target.rank, url: target.url, title: target.title,
    aliases: target.aliases, publishedAt: target.publishedAt });
  ensure(hash(episode.targets.map(targetIdentity)) === hash(shared.reference.targets.map(targetIdentity)),
    'FCD target cohort differs from its shared reference');
  ensure(timestamp(episode.admittedAt) && Number.isFinite(episode.executionDeadlineAtMs) &&
    episode.executionDeadlineAtMs <= Date.parse(episode.admittedAt) + 300000,
  'FCD execution timing is missing or invalid');
  const admissionAge = Date.parse(episode.admittedAt) - Date.parse(episode.referenceAsOf);
  ensure(admissionAge >= 0, 'FCD admission cannot precede its reference');
  for (const target of episode.targets.filter(item => item.status === 'captured')) {
    ensure(admissionAge <= freshsearch.knownItemPolicy.KNOWN_ITEM_REFERENCE_AGE_MS &&
      timestamp(target.requestTime) && timestamp(target.trace?.responseTime) &&
      target.requestTime === target.trace.requestTime &&
      Date.parse(target.requestTime) >= Date.parse(episode.admittedAt) &&
      Date.parse(target.trace.responseTime) >= Date.parse(target.requestTime) &&
      hash(target.results) === hash(target.trace.results), 'Captured FCD target has invalid timing or trace');
    const deadline = knownItemCaptureDeadline(episode.referenceAsOf, target.publishedAt,
      episode.executionDeadlineAtMs);
    ensure(Date.parse(target.trace.responseTime) < deadline.expiresAtMs,
      'Captured FCD target exceeded its original timing deadline');
    const reservations = input.execution.reservations.filter(row =>
      row.reservationId === target.trace.reservationId);
    ensure(reservations.length === 1 && reservations[0].stage === 'search' &&
      reservations[0].traceId === target.trace.id && reservations[0].status === 'settled',
    'Captured FCD target lacks its settled search reservation');
  }
}

function scoreCaptureCore(input, panel) {
  const reliabilityScoring = ['freshsearch-reliability-input-v1', fcdCaptureVersion].includes(input?.version) &&
    panel === 'fcd';
  const traced = ['freshsearch-traced-input-v1', 'freshsearch-reliability-input-v1', fcdCaptureVersion]
    .includes(input?.version);
  ensure((traced || input?.version === 'freshsearch-portable-input-v1') && input.panel === panel,
    'Input must be a capture with the selected panel and a supported capture version; task lists require --live');
  ensure(['synthetic-fixture', 'retained-capture', 'live-capture'].includes(input.kind), 'Input needs its explicit capture kind');
  const rows = [];
  if (panel === 'ef') {
    ensure(input.kind === 'synthetic-fixture',
      'Legacy EF scoring is limited to synthetic fixtures; historical captures require their original scorer');
    const parsed = freshsearch.parseFreshSearchScoreRequest({ records: input.records, policy: input.policy });
    ensure(parsed.records.length > 0 || input.pendingTask || traced && input.assignments?.length,
      'EF input has no records or retained pending task');
    const policy = parsed.policy ?? freshsearch.DEFAULT_FRESH_SEARCH_POLICY;
    const seen = new Set();
    for (const record of parsed.records) {
      ensure(record.panel === 'freshness', 'This EF entrypoint does not score the separate dated-correctness panel');
      const key = `${record.providerId}/${record.queryId}/${record.runId}`;
      ensure(!seen.has(key), `Duplicate EF record ${key}`); seen.add(key);
      const result = freshsearch.scoreFreshnessRun(record, policy);
      const trace = traced ? input.traces?.find(item => item.id === record.runId) : null;
      if (traced) {
        ensure(trace && trace.providerId === record.providerId && trace.queryId === record.queryId,
          'EF record has no bound trace');
        validateEFTrace(trace, record, input);
      }
      rows.push({
        id: record.queryId, providerId: record.providerId, category: record.category,
        status: result.score === null ? 'held' : 'scored', score: result.score,
        reason: result.score === null ? record.exclusionReason ?? 'not_scored' :
          result.evidenceScores.map(item => item.reason).join(';'),
        details: result, recordHash: digest(record),
        ...(traced ? { ...caseTrace(trace), reason: trace.reason ?? (result.score === null ?
          record.exclusionReason ?? 'not_scored' : result.evidenceScores.map(item => item.reason).join(';')) } : {}),
      });
    }
    if (input.pendingTask) {
      ensure(typeof input.pendingTask.queryId === 'string' && typeof input.pendingTask.providerId === 'string',
        'Pending EF task needs task/provider identity');
      rows.push({ id: input.pendingTask.queryId, providerId: input.pendingTask.providerId,
        status: 'capture-unknown', score: null, reason: 'reserved-or-interrupted-dispatch',
        ...(traced ? caseTrace(input.traces.find(item => item.id === input.pendingTask.traceId) ?? {}) : {}) });
    }
    if (traced && input.assignments) {
      for (const assignment of input.assignments) {
        if (rows.some(row => row.id === assignment.queryId && row.providerId === assignment.providerId)) continue;
        rows.push({ id: assignment.queryId, providerId: assignment.providerId,
          category: assignment.contract.category, status: 'capture-unknown', score: null,
          reason: 'not-dispatched', query: null, queryProvenance: 'not-dispatched' });
      }
    }
    return { rows, policy, observations: [] };
  }
  ensure(Array.isArray(input.episodes) && input.episodes.length > 0, 'FCD input requires non-empty episodes');
  const observations = [];
  const seen = new Set();
  for (const episode of input.episodes) {
    ensure(typeof episode.id === 'string' && episode.id && typeof episode.providerId === 'string' &&
      episode.providerId, 'FCD episode needs ID and provider identity');
    const key = `${episode.providerId}/${episode.id}`;
    ensure(!seen.has(key), `Duplicate FCD episode ${key}`); seen.add(key);
    ensure(typeof episode.eligible === 'boolean', 'FCD eligibility must be explicit');
    if (input.version === fcdCaptureVersion && input.kind !== 'synthetic-fixture') {
      validateFCDReference(input, episode);
    }
    if (!episode.eligible) {
      ensure(typeof episode.reason === 'string' && episode.reason, 'Held episode needs a reason');
      rows.push({ id: episode.id, providerId: episode.providerId, status: 'held', score: null, reason: episode.reason });
      continue;
    }
    ensure(Array.isArray(episode.targets) && episode.targets.length === 10, 'Eligible FCD episode must contain exactly ten targets');
    ensure(!freshsearch.knownItemIdentityCollision(episode.targets), 'FCD targets contain colliding known-item identities');
    if (reliabilityScoring) ensure(timestamp(episode.referenceAsOf), 'FCD episode requires its original reference time');
    const targets = new Set();
    for (const [index, target] of episode.targets.entries()) {
      ensure(target.rank === index + 1 && freshsearch.canonicalUrl(target.url) &&
        typeof target.title === 'string' && target.title &&
        Array.isArray(target.aliases) && target.aliases.length >= 1 && target.aliases.length <= 2 &&
        target.aliases.every(alias => freshsearch.canonicalUrl(alias) === alias) &&
        target.aliases.includes(freshsearch.canonicalUrl(target.url)) && timestamp(target.publishedAt),
      'FCD targets require ordered unique identities, canonical aliases, titles and zoned publication timestamps');
      ensure(!targets.has(freshsearch.canonicalUrl(target.url)), 'Duplicate FCD target identity'); targets.add(freshsearch.canonicalUrl(target.url));
      ensure(['captured', 'provider-error', 'capture-unknown', 'access-held'].includes(target.status), 'FCD capture status is required');
      const referenceAge = reliabilityScoring
        ? (Date.parse(episode.referenceAsOf) - Date.parse(target.publishedAt)) / 60000 : null;
      if (reliabilityScoring && referenceAge < 0) {
        rows.push({ id: `${episode.id}/${target.rank}`, providerId: episode.providerId,
          status: 'age-excluded', score: null, reason: 'publication-after-reference',
          ...(traced ? caseTrace(target.trace ?? {}) : {}) });
        continue;
      }
      if (target.status !== 'captured') {
        ensure(typeof target.reason === 'string' && target.reason, 'Unknown/error capture needs a reason');
        if (reliabilityScoring) observations.push({ providerId: episode.providerId, hit: false, ageMinutes: referenceAge });
        rows.push({ id: `${episode.id}/${target.rank}`, providerId: episode.providerId,
          status: target.status, score: null, reason: target.reason,
          ...(reliabilityScoring ? { ageMinutes: referenceAge,
            points: freshsearch.freshContentDiscoveryAgePoints(referenceAge), earnedPoints: 0 } : {}),
          ...(traced ? caseTrace(target.trace ?? {}) : {}) });
        continue;
      }
      ensure(timestamp(target.requestTime) && Array.isArray(target.results) && target.results.length <= 10,
        'Captured target needs zoned requestTime and at most ten results');
      if (reliabilityScoring) ensure(Date.parse(target.requestTime) >= Date.parse(episode.referenceAsOf),
        'FCD capture cannot precede its reference');
      const ageMinutes = reliabilityScoring ? referenceAge :
        (Date.parse(target.requestTime) - Date.parse(target.publishedAt)) / 60000;
      ensure(ageMinutes >= 0, 'FCD target publication cannot be after requestTime');
      const result = freshsearch.scoreKnownItem(target, target.results);
      const points = freshsearch.freshContentDiscoveryAgePoints(ageMinutes);
      observations.push({ providerId: episode.providerId, hit: result.hit, ageMinutes });
      rows.push({ id: `${episode.id}/${target.rank}`, providerId: episode.providerId,
        status: 'scored', score: result.hit ? 100 : 0, reason: result.hit ? 'hit' : 'miss',
        ageMinutes, points, earnedPoints: result.hit ? points : 0,
        details: result, recordHash: digest(target) });
      if (traced) Object.assign(rows.at(-1), caseTrace(target.trace ?? {}));
    }
  }
  const assignedTargets = Object.fromEntries([...new Set(input.episodes.map(row => row.providerId))]
    .map(providerId => [providerId, input.episodes.filter(row => row.providerId === providerId).length * 10]));
  return { rows, observations, assignedTargets, reliabilityScoring, policy: {
    scoringVersion: input.version === fcdCaptureVersion ? fcdScoringVersion :
      reliabilityScoring ? freshsearch.knownItemPolicy.FRESH_CONTENT_DISCOVERY_PROVIDER_SCORING_VERSION :
        freshsearch.knownItemPolicy.FRESH_CONTENT_DISCOVERY_AGE_SCORING_VERSION,
    ...(reliabilityScoring ? { ageWeightVersion: input.version === fcdCaptureVersion ? fcdAgeWeightVersion :
      freshsearch.knownItemPolicy.FRESH_CONTENT_DISCOVERY_AGE_SCORING_VERSION,
      population: 'evaluator-eligible-assigned-targets', ageClock: 'episode-reference-time' } : {}),
    ageBands: freshsearch.knownItemPolicy.FRESH_CONTENT_DISCOVERY_AGE_BANDS } };
}

export function scoreCapture(input, panel) {
  ensure(input?.kind === 'synthetic-fixture',
    'Non-synthetic captures require source-bound replay; historical captures require their original scorer');
  return scoreCaptureCore(input, panel);
}

export async function scoreCaptureForReplay(input, panel) {
  ensure(input && input.panel === panel && typeof input.version === 'string' &&
    ['synthetic-fixture', 'retained-capture', 'live-capture'].includes(input.kind),
  'Input must be a capture with the selected panel and an explicit capture kind; task lists require --live');
  if (input?.kind !== 'synthetic-fixture') {
    ensure(['ef', 'fcd'].includes(panel) && input?.version ===
      (panel === 'ef' ? CONFIRMED_CLOCK_EF_CAPTURE_VERSION : fcdCaptureVersion),
    'Historical captures require their original scorer');
    const confirmedClock = panel === 'ef';
    const bundleName = confirmedClock ? 'freshsearch-confirmed-clock.cjs' : 'freshsearch.cjs';
    const sourceHashes = await benchmarkSourceHashes();
    const source = await scorerIdentity(sourceHashes[bundleName], confirmedClock);
    ensure(input.execution?.source?.outputSha256 === source.outputSha256 &&
      input.execution?.sourceHashes && hash(input.execution.sourceHashes) === hash(sourceHashes),
    'Capture source differs from this runner; use its original scorer');
  }
  if (input?.version === CONFIRMED_CLOCK_EF_CAPTURE_VERSION) {
    ensure(panel === 'ef', 'Confirmed-clock capture requires the EF panel');
    return scoreConfirmedClockEFCapture(input);
  }
  return scoreCaptureCore(input, panel);
}

export function summarize(scored, panel) {
  return [...new Set(scored.rows.map(row => row.providerId))].map(providerId => {
    const rows = scored.rows.filter(row => row.providerId === providerId);
    const values = rows.filter(row => row.status === 'scored');
    const weighted = panel === 'fcd' ? freshsearch.computeFreshContentDiscoveryAgeIndex(
      scored.observations.filter(row => row.providerId === providerId)) : null;
    return {
      providerId, assignedRows: rows.length, scoredRows: values.length,
      heldRows: rows.filter(row => row.status === 'held').length,
      unknownRows: rows.filter(row => !['held', 'scored', 'age-excluded'].includes(row.status)).length,
      zeroScoreRows: values.filter(row => row.score === 0).length,
      coverage: panel === 'fcd' ? values.length / scored.assignedTargets[providerId] :
        rows.length ? values.length / rows.length : null,
      score: panel === 'fcd' ? weighted.index :
        values.length ? values.reduce((sum, row) => sum + row.score, 0) / values.length : null,
      ...(weighted ? { earnedPoints: weighted.earnedPoints, possiblePoints: weighted.possiblePoints,
        assignedTargets: scored.assignedTargets[providerId],
        heldFeeds: rows.filter(row => row.status === 'held').length,
        ...(scored.reliabilityScoring ? {
          eligibleTargets: scored.observations.filter(row => row.providerId === providerId).length,
          unavailableTargets: rows.filter(row => !['held', 'scored', 'age-excluded'].includes(row.status)).length,
          excludedAgeTargets: rows.filter(row => row.status === 'age-excluded').length,
        } : {}) } : {}),
    };
  });
}

export async function benchmarkSourceHashes() {
  const hashes = {};
  for (const name of ['run.mjs', 'trace.mjs', 'retention.mjs', 'runtime.mjs', 'ef.mjs', 'ef-clock.mjs',
    'providers/normalization.cjs',
    'evaluate.mjs', 'evaluation-report.mjs', 'report.mjs', 'freshsearch.cjs',
    'freshsearch-confirmed-clock.cjs']) {
    hashes[name] = createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex');
  }
  return hashes;
}

export async function scorerIdentity(actualHash, confirmedClock = false) {
  const manifestName = confirmedClock ? 'confirmed-clock-build-manifest.json' : 'build-manifest.json';
  const bundleName = confirmedClock ? 'freshsearch-confirmed-clock.cjs' : 'freshsearch.cjs';
  const manifest = await json(path.join(root, manifestName));
  actualHash ??= createHash('sha256').update(await fs.readFile(path.join(root, bundleName))).digest('hex');
  ensure(/^[a-f0-9]{64}$/.test(manifest.outputSha256) && manifest.outputSha256 === actualHash,
    'Scorer bundle hash does not match build manifest');
  return { outputSha256: actualHash };
}

function validateEFTasks(tasks, maximum) {
  ensure(tasks.version === 'freshsearch-rt-tasks-v1' && Array.isArray(tasks.tasks) &&
    tasks.tasks.length > 0 && tasks.tasks.length <= maximum, 'Invalid EF tasks or insufficient call budget');
  const ids = new Set();
  const parsed = tasks.tasks.map(candidate => {
    const task = currentEFTask(candidate);
    requireSafeIdentifier(task.queryId, 'EF task ID');
    ensure(task.panel === 'freshness' && !ids.has(task.queryId), 'EF tasks require unique freshness query IDs');
    ids.add(task.queryId);
    return task;
  });
  return { tasks: tasks.tasks, parsed };
}

async function loadEFTasks(values, maximum) {
  return validateEFTasks(await json(values.input ? path.resolve(values.input) :
    path.join(root, 'datasets/current-launch-ef120.json')), maximum);
}

export async function liveCapture(values, save, {
  signal: externalSignal, efTasks, fcdReference, judgeConfig,
} = {}) {
  requireAuthorizedUse(values);
  ensure(values.provider && values['max-calls'], 'Live mode requires --provider module.mjs and --max-calls N');
  const maximum = Number(values['max-calls']);
  ensure(Number.isInteger(maximum) && maximum > 0 && maximum <= 1000, 'max-calls must be an integer from 1 to 1000');
  const searchDelayMs = Number(values['search-delay-ms'] ?? 0);
  ensure(Number.isSafeInteger(searchDelayMs) && searchDelayMs >= 0 && searchDelayMs <= 60000,
    'search-delay-ms must be an integer from 0 to 60000');
  const adapterUrl = pathToFileURL(path.resolve(values.provider));
  const adapter = await import(adapterUrl);
  requireSafeIdentifier(adapter.providerId, 'Provider ID');
  ensure(adapter.physicalRetries === 0, 'Adapter must explicitly declare physicalRetries=0');
  ensure(typeof adapter.search === 'function', 'Adapter must export search');
  const identity = await adapterIdentity(adapterUrl);
  const maximumJudge = values.panel === 'ef' ? Number(values['max-judge-calls']) : 0;
  if (values.panel === 'ef') ensure(judgeConfig || values['judge-config'], 'EF requires --judge-config FILE');
  const config = values.panel === 'ef' ? judgeConfiguration(judgeConfig ??
    await json(path.resolve(values['judge-config']))) : null;
  if (values.panel === 'ef') ensure(Number.isInteger(maximumJudge) && maximumJudge > 0 && maximumJudge <= 2000,
    'EF requires --max-judge-calls (integer from 1 to 2000)');
  const sourceHashes = await benchmarkSourceHashes();
  const confirmedClock = values.panel === 'ef';
  const scorerSource = await scorerIdentity(
    sourceHashes[confirmedClock ? 'freshsearch-confirmed-clock.cjs' : 'freshsearch.cjs'], confirmedClock);
  const input = { version: confirmedClock ? CONFIRMED_CLOCK_EF_CAPTURE_VERSION : fcdCaptureVersion,
    kind: 'live-capture', panel: values.panel,
    records: [], episodes: [], traces: [], providerCalls: 0,
    execution: { version: 'freshsearch-execution-v1', sourceHashes, adapter: identity,
      runtime: runtimeIdentity(),
      source: scorerSource,
      budgets: { search: maximum, judge: maximumJudge, externalReference: values.panel === 'ef' ? 0 : null },
      reserved: { search: 0, judge: 0 }, reservations: [],
      judgeConfigHash: config ? hash(config) : null,
      pacing: { searchDelayMs },
      referencePolicy: values.panel === 'ef' ? 'retained-provider-evidence-task-request-clock-not-independent-truth' :
        'original-publisher-known-items-jit-access-reference-requests-not-capped' } };
  const executionDeadlineAtMs = Date.now() + 300000;
  const signal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(300000)]) :
    AbortSignal.timeout(300000);
  const checkpoint = () => save(input);
  const reserve = async (stage = 'search', attempt = {}) => {
    signal.throwIfAborted();
    ensure(input.execution.reserved[stage] < input.execution.budgets[stage], `${stage} call budget exhausted`);
    input.execution.reserved[stage]++;
    if (stage === 'search') input.providerCalls++;
    attempt.status = 'reserved';
    input.execution.reservations.push({ stage, ordinal: input.execution.reserved[stage],
      traceId: attempt.traceId ?? input.pendingTask?.traceId ?? null,
      reservationId: attempt.reservationId ?? null,
      requestHash: attempt.requestHash ?? null, evidenceIds: attempt.evidenceIds ?? null,
      reservedAt: new Date().toISOString(), status: 'reserved' });
    await save(input);
    signal.throwIfAborted();
  };
  if (values.panel === 'ef') {
    const tasks = efTasks ?? await loadEFTasks(values, maximum);
    ensure(typeof adapter.searchFullResponse === 'function', 'EF provider must export searchFullResponse');
    input.assignments = tasks.parsed.map(parsed => ({ queryId: parsed.queryId, providerId: adapter.providerId,
      contract: parsed, taskHash: hash(parsed) }));
    await checkpoint();
    for (const candidate of tasks.tasks) {
      signal.throwIfAborted();
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
      const record = await evaluateConfirmedClockEF({ contract: candidate, adapter, identity, config,
        reserve, save: checkpoint, input, signal: deadline });
      input.records.push(record); delete input.pendingTask; await save(input);
    }
    return input;
  }
  ensure(typeof adapter.search === 'function' && values['feed-id'],
    'FCD live mode needs --feed-id and an adapter exporting search');
  const catalog = await json(path.join(root, 'datasets', 'current-launch-fcd96.json'));
  const endpoint = catalog.sources.find(item => item.sourceId === values['feed-id']);
  ensure(endpoint, 'Feed ID is not in the FCD feed catalog');
  ensure(maximum >= 10, 'One eligible feed requires a budget of at least ten searches');
  const contract = { ...endpoint.contract,
    accessPolicyVersion: 'freshsearch-fcd-access-policy-v1',
    sourceAccessMode: 'just-in-time-source-access-v1' };
  if (!fcdReference) {
    const referenceStart = performance.now();
    const reference = freshsearch.retainJustInTimeReference(
      await freshsearch.captureKnownItemReference({ contract, signal, logger }));
    const referenceMs = performance.now() - referenceStart;
    const proof = reference.eligible ? freshsearch.createJustInTimeAccessProof(contract, reference, {
      batchId: randomUUID(), itemId: contract.queryId, generation: 0, manifestHash: digest(contract),
    }) : null;
    if (reference.eligible) ensure(proof, 'Original FreshSearch verifier did not establish run-bound access proof');
    fcdReference = { referenceId: randomUUID(), feedId: values['feed-id'],
      contract, contractHash: hash(contract), reference, referenceMs, proof };
  }
  ensure(typeof fcdReference.referenceId === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(fcdReference.referenceId) &&
    fcdReference.feedId === values['feed-id'] && fcdReference.contractHash === hash(contract) &&
    hash(fcdReference.contract) === fcdReference.contractHash &&
    fcdReference.reference && typeof fcdReference.reference.eligible === 'boolean' &&
    Number.isFinite(fcdReference.referenceMs) && fcdReference.referenceMs >= 0,
  'Shared FCD reference differs from the selected feed');
  const { reference, referenceMs, proof } = fcdReference;
  if (reference.eligible) {
    ensure(proof && timestamp(reference.observedAt), 'Eligible FCD reference lacks a timed access proof');
    const binding = { batchId: proof.batchId, itemId: proof.itemId,
      generation: proof.generation, manifestHash: proof.manifestHash };
    ensure(proof.itemId === contract.queryId &&
      hash(freshsearch.createJustInTimeAccessProof(contract, reference, binding)) === hash(proof),
    'Shared FCD access proof differs from its reference');
  } else ensure(proof === null, 'Ineligible FCD reference cannot have an access proof');
  input.execution.fcdReference = fcdReference;
  input.execution.fcdReferenceHash = hash(fcdReference);
  input.execution.fcdReferenceId = fcdReference.referenceId;
  const episode = { id: contract.queryId, providerId: adapter.providerId, eligible: reference.eligible,
    reason: reference.reason, targets: reference.targets.map(target => ({
      ...target, status: 'capture-unknown', reason: 'not-dispatched', results: [],
    })), reference, referenceMs, referenceAsOf: reference.observedAt,
    admittedAt: new Date().toISOString(), executionDeadlineAtMs };
  input.episodes.push(episode); await save(input);
  if (!reference.eligible) return input;
  episode.accessProof = proof;
  const admissionAge = Date.parse(episode.admittedAt) - Date.parse(reference.observedAt);
  if (admissionAge < 0 || admissionAge > freshsearch.knownItemPolicy.KNOWN_ITEM_REFERENCE_AGE_MS) {
    for (const row of episode.targets) {
      row.status = 'access-held'; row.reason = 'reference-window-expired';
    }
    await save(input);
    return input;
  }
  for (const row of episode.targets) {
    signal.throwIfAborted();
    if (Date.parse(row.publishedAt) > Date.parse(episode.referenceAsOf)) continue;
    const deadline = knownItemCaptureDeadline(episode.referenceAsOf, row.publishedAt, executionDeadlineAtMs);
    if (Date.now() >= deadline.expiresAtMs) {
      row.status = 'access-held'; row.reason = deadline.reason; continue;
    }
    row.trace = { id: randomUUID(), adapter: identity, referenceMs,
      reference: { kind: 'original-publisher-known-items-jit-access-reference',
        sharedEpisode: true, referenceHash: hash(reference), accessProofHash: hash(proof), observedAt: reference.observedAt } };
    const query = freshsearch.knownItemQuery(row);
    row.trace.query = query;
    row.reason = 'reserved-or-interrupted-dispatch';
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(
      Math.max(1, Math.min(120000, deadline.expiresAtMs - Date.now())))]);
    try {
      await waitForSearchPacing(input.execution.reserved.search, searchDelayMs, { signal: attemptSignal });
    } catch (error) {
      if (signal.aborted || !attemptSignal.aborted) throw error;
      row.status = 'access-held'; row.reason = Date.now() >= deadline.expiresAtMs ?
        deadline.reason : 'provider-timeout';
      continue;
    }
    if (Date.now() >= deadline.expiresAtMs) {
      row.status = 'access-held'; row.reason = deadline.reason; continue;
    }
    const attempt = { traceId: row.trace.id, reservationId: randomUUID() };
    row.trace.reservationId = attempt.reservationId;
    await reserve('search', attempt);
    const reservation = input.execution.reservations.at(-1);
    try {
      const results = await captureSearch(adapter, { query, signal: attemptSignal, maxResults: 10, maxLength: 7000 },
        row.trace, checkpoint);
      row.requestTime = row.trace.requestTime;
      reservation.status = 'settled';
      if (Date.now() >= deadline.expiresAtMs) {
        row.status = 'access-held'; row.reason = deadline.reason;
      } else {
        freshsearch.scoreKnownItem(row, results);
        row.results = results; row.status = 'captured'; delete row.reason;
      }
    } catch (error) {
      reservation.status = 'unknown';
      if (signal.aborted) throw error;
      if (attemptSignal.aborted) {
        row.status = Date.now() >= deadline.expiresAtMs ? 'access-held' : 'provider-error';
        row.reason = row.status === 'access-held' ? deadline.reason : 'provider-timeout';
      } else if (error instanceof ProviderRequestError) {
        row.status = 'provider-error';
        row.reason = /^(?:http-\d{3}|provider-transport-failed)$/u.test(error.reason)
          ? error.reason : 'provider-error';
      } else throw error;
      logger.warn(`FCD capture unavailable for ${adapter.providerId}: ${row.reason}`);
    } finally {
      await save(input);
    }
  }
  return input;
}

export async function main(args = process.argv.slice(2), {
  signal, fcdReference, efTasks: suppliedTasks, judgeConfig, receiptKey = newReceiptKey(),
} = {}) {
  const { values } = parseArgs({ args, options: {
    panel: { type: 'string' }, input: { type: 'string' }, out: { type: 'string' },
    live: { type: 'boolean', default: false }, provider: { type: 'string' },
    'feed-id': { type: 'string' }, 'max-calls': { type: 'string' },
    'search-delay-ms': { type: 'string' },
    'judge-config': { type: 'string' }, 'max-judge-calls': { type: 'string' },
    'confirm-authorized-use': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log(usage);
    return;
  }
  ensure(['ef', 'fcd'].includes(values.panel) && values.out,
    'Require --panel ef|fcd and --out NEW_DIRECTORY. Run with --help for usage.');
  ensure(values.live || values.input, 'Replay mode requires --input capture.json');
  if (values.live) requireAuthorizedUse(values);
  const replay = values.live ? null : await json(path.resolve(values.input));
  const replayScore = values.live ? null : await scoreCaptureForReplay(replay, values.panel);
  const efTasks = suppliedTasks ? validateEFTasks(suppliedTasks, Number(values['max-calls'])) :
    values.live && values.panel === 'ef' && values.input ?
      await loadEFTasks(values, Number(values['max-calls'])) : undefined;
  const out = path.resolve(values.out);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(out, { mode: 0o700 });
  const receiptId = randomUUID();
  let checkpointStatus = 'running';
  const save = async input => {
    const synthetic = input.kind === 'synthetic-fixture';
    const filename = synthetic ? 'capture.json' : 'checkpoint.json';
    const temporary = path.join(out, `${filename}.pending`);
    const persisted = synthetic ? input : metadataCheckpoint(input, receiptId, receiptKey, checkpointStatus);
    await fs.writeFile(temporary, JSON.stringify(persisted, null, 2) + '\n', { mode: 0o600 });
    await replaceCaptureFileAtomically(temporary, path.join(out, filename));
  };
  try {
    const input = values.live ? await liveCapture(values, save, {
      signal, efTasks, fcdReference, judgeConfig,
    }) : replay;
    await save(input);
    const scored = replayScore ?? await scoreCaptureForReplay(input, values.panel);
    checkpointStatus = 'complete';
    await save(input);
    const confirmedClock = input.version === CONFIRMED_CLOCK_EF_CAPTURE_VERSION;
    const traced = confirmedClock || ['freshsearch-traced-input-v1', 'freshsearch-reliability-input-v1',
      fcdCaptureVersion].includes(input.version);
    const reportVersion = confirmedClock || input.version === fcdCaptureVersion ? 'freshsearch-launch-report-v1' :
      input.version === 'freshsearch-reliability-input-v1' ? 'freshsearch-reliability-report-v1' :
      traced ? 'freshsearch-traced-report-v1' : 'freshsearch-portable-report-v1';
    const fullReport = { version: reportVersion, panel: values.panel, kind: input.kind,
      interpretation: 'Exploratory standalone run; not an official complete launch score or proof of prior indexing.',
      inputHash: digest(input), source: await scorerIdentity(undefined, confirmedClock),
      policy: scored.policy, summary: summarize(scored, values.panel), cases: scored.rows,
      ...(traced ? { execution: input.execution, timingPolicy: {
        clock: 'monotonic-performance-now',
        searchMs: 'adapter invocation through bounded normalization, including diagnostics checkpoint I/O; not network-only latency',
        judgeMs: 'sequential evidence judgments including reservations, transport, validation and checkpoint I/O',
        totalMs: 'EF task admission through validated result, excluding final checkpoint write',
        referenceMs: values.panel === 'ef' ? 'null: no external reference dispatch in original normal freshness semantics' :
          'shared FCD episode publisher/reference collection duration, not a per-query dispatch or capped request count',
      } } : {}) };
    const report = input.kind === 'synthetic-fixture' ? fullReport :
      metadataReport(fullReport, receiptId, receiptKey);
    if (input.execution?.fcdReference) {
      Object.defineProperty(report, sharedFCDReference, { value: input.execution.fcdReference });
    }
    await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    const columns = ['id', 'providerId', 'category', 'status', 'score', 'reason', 'ageMinutes', 'points', 'earnedPoints', 'recordHash'];
    if (traced && input.kind === 'synthetic-fixture') columns.push('traceId', 'query', 'queryProvenance', 'requestTime', 'responseTime',
      'searchMs', 'judgeMs', 'referenceMs', 'totalMs', 'effectiveConfigHash', 'effectiveConfig',
      'adapter', 'results', 'reference', 'judge');
    else if (traced) columns.push('searchMs', 'judgeMs', 'referenceMs', 'totalMs', 'effectiveConfigHash');
    const csv = rows => [columns.join(','), ...rows.map(row => columns.map(key =>
      csvCell(row[key] && typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key])).join(','))].join('\n') + '\n';
    await fs.writeFile(path.join(out, 'cases.csv'), csv(report.cases), { mode: 0o600 });
    await fs.writeFile(path.join(out, 'issues.csv'), csv(report.cases.filter(row => row.status !== 'scored' || row.score === 0)), { mode: 0o600 });
    console.log(JSON.stringify({ panel: report.panel, kind: report.kind, summary: report.summary, output: out }));
    return report;
  } catch (error) {
    const failure = values.live ? safeLiveFailure(error, signal?.aborted) : null;
    await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({
      status: 'failed', reason: failure?.reason ?? 'run-failed',
      message: values.live ? failure.error.message :
        'Offline replay stopped; inspect the input and error.',
      ...(failure ? { hint: failureHint(failure.reason) } : {}),
    }, null, 2) + '\n', { mode: 0o600 });
    throw failure?.error ?? error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(main);
}
