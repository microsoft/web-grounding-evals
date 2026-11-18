// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import freshsearch from './freshsearch.cjs';
import { renderViewer } from './report-ui.mjs';
import { runCli } from './cli.mjs';

const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_CASES = 50000;
const kinds = ['synthetic-fixture', 'retained-capture', 'live-capture'];
const statuses = ['scored', 'held', 'provider-error', 'capture-unknown', 'access-held', 'age-excluded'];
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, name) => {
  ensure(typeof value === 'string' && value.length > 0 && value.length <= 2048, `Invalid ${name} (1-2048 characters required)`);
  return value;
};
const optionalText = value => value === undefined ? null : text(value, 'text field');
const stable = value => JSON.stringify(value, (_, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const near = (left, right) => left === right ||
  (number(left) && number(right) && Math.abs(left - right) <= 1e-8 * Math.max(1, right));

export function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function evidenceDetails(details) {
  if (details === undefined) return null;
  ensure(object(details), 'Case details must be an object');
  const result = {};
  for (const key of ['hit', 'withText']) {
    if (details[key] !== undefined) {
      ensure(typeof details[key] === 'boolean', `Invalid details.${key}`);
      result[key] = details[key];
    }
  }
  for (const key of ['firstRank', 'resultCount']) {
    if (details[key] !== undefined) {
      ensure(details[key] === null || count(details[key]), `Invalid details.${key}`);
      result[key] = details[key];
    }
  }
  for (const key of ['queryId', 'runId', 'category', 'tier']) {
    if (details[key] !== undefined) result[key] = optionalText(details[key]);
  }
  if (details.evidenceScores !== undefined) {
    ensure(Array.isArray(details.evidenceScores) && details.evidenceScores.length <= 100, 'Too many evidence scores');
    result.evidenceScores = details.evidenceScores.map(item => {
      ensure(object(item), 'Invalid evidence score');
      const row = {};
      for (const key of ['evidenceId', 'reason']) if (item[key] !== undefined) row[key] = optionalText(item[key]);
      for (const key of ['rank', 'ageMinutes', 'score']) {
        if (item[key] !== undefined) {
          ensure(item[key] === null || (key === 'ageMinutes' ? typeof item[key] === 'number' &&
            Number.isFinite(item[key]) : number(item[key])), `Invalid evidence ${key}`);
          row[key] = item[key];
        }
      }
      if (item.url !== undefined) row.url = safeUrl(item.url);
      return row;
    });
  }
  return result;
}

export function summarizeRetrieval(cases, previous) {
  const result = previous ? structuredClone(previous) : {
    hits: 0, misses: 0, missedTargets: [],
    ageBands: ['Under 30m', '30m–1h', '1–6h', '6–24h', '24h+', 'Age unavailable']
      .map(label => ({ label, scored: 0, hits: 0, earnedPoints: 0, possiblePoints: 0 })),
  };
  for (const row of cases) {
    const age = row.ageMinutes;
    const index = age === undefined ? 5 : age < 30 ? 0 : age < 60 ? 1 :
      age < 360 ? 2 : age < 1440 ? 3 : 4;
    const band = result.ageBands[index];
    if (row.status !== 'scored') {
      if (number(row.points)) band.possiblePoints += row.points;
      continue;
    }
    const hit = row.score === 100;
    band.scored++;
    band.hits += Number(hit);
    band.earnedPoints += row.earnedPoints;
    band.possiblePoints += row.points;
    if (hit) result.hits++;
    else {
      result.misses++;
      if (result.missedTargets.length < 20) {
        result.missedTargets.push({ id: row.id, ageMinutes: age ?? null, points: row.points });
      }
    }
  }
  return result;
}

export function parseReport(report) {
  ensure(object(report) && ['freshsearch-portable-report-v1', 'freshsearch-traced-report-v1',
    'freshsearch-reliability-report-v1', 'freshsearch-launch-report-v1'].includes(report.version), 'Unsupported report version');
  ensure(['fcd', 'ef'].includes(report.panel) && kinds.includes(report.kind), 'Invalid report panel or capture kind');
  ensure(object(report.policy), 'Missing scoring policy');
  const launch = report.version === 'freshsearch-launch-report-v1';
  const reliabilityScoring = report.panel === 'fcd' &&
    (report.version === 'freshsearch-reliability-report-v1' || launch);
  if (reliabilityScoring) ensure(report.policy.scoringVersion ===
    (launch ? 'freshsearch-fcd-provider-performance-v1' : 'freshsearch-fcd-fixture-scoring-v1') &&
    report.policy.population === 'evaluator-eligible-assigned-targets' &&
    report.policy.ageClock === 'episode-reference-time' &&
    report.policy.ageWeightVersion === (launch ? 'freshsearch-fcd-age-weight-v1' :
      freshsearch.knownItemPolicy.FRESH_CONTENT_DISCOVERY_AGE_SCORING_VERSION) &&
    stable(report.policy.ageBands) === stable(freshsearch.knownItemPolicy.FRESH_CONTENT_DISCOVERY_AGE_BANDS),
  'Invalid FCD reliability scoring policy');
  ensure(stable(report.policy).length <= 32768, 'Scoring policy exceeds 32 KiB');
  ensure(Array.isArray(report.cases) && report.cases.length <= MAX_CASES, 'Invalid or oversized case collection');
  ensure(Array.isArray(report.summary) && report.summary.length > 0 && report.summary.length <= 1000, 'Invalid provider summary');
  const seen = new Set();
  const cases = report.cases.map(item => {
    ensure(object(item), 'Invalid case');
    const id = text(item.id, 'case ID');
    const providerId = text(item.providerId, 'provider ID');
    const key = stable([providerId, id, report.panel === 'ef' ? item.details?.runId ?? null : null]);
    ensure(!seen.has(key), `Duplicate case ${id}`); seen.add(key);
    ensure(statuses.includes(item.status), `Invalid status for ${id}`);
    ensure(item.status !== 'age-excluded' || reliabilityScoring, `Invalid status for ${id}`);
    ensure(item.status === 'scored' ? number(item.score) && item.score <= 100 : item.score === null,
      `Invalid score/null for ${id}`);
    const row = { id, providerId, status: item.status, score: item.score,
      reason: text(item.reason, 'case reason'), category: optionalText(item.category),
      recordHash: optionalText(item.recordHash), details: evidenceDetails(item.details) };
    for (const field of ['ageMinutes', 'points', 'earnedPoints']) {
      if (item[field] !== undefined) {
        ensure(number(item[field]), `Invalid ${field} for ${id}`);
        row[field] = item[field];
      }
    }
    for (const field of ['searchMs', 'judgeMs', 'referenceMs', 'totalMs']) {
      if (item[field] !== undefined) {
        ensure(item[field] === null || number(item[field]), `Invalid ${field} for ${id}`);
        row[field] = item[field];
      }
    }
    if (report.panel === 'fcd' && row.status === 'scored') {
      ensure(number(row.points) && row.points > 0 && number(row.earnedPoints) &&
        row.earnedPoints <= row.points && [0, 100].includes(row.score) &&
        near(row.earnedPoints, row.score === 100 ? row.points : 0), `Invalid FCD points for ${id}`);
    }
    if (reliabilityScoring && !['held', 'age-excluded', 'scored'].includes(row.status)) {
      ensure(number(row.ageMinutes) && number(row.points) && row.points > 0 && row.earnedPoints === 0,
        `Unavailable FCD target requires its original age weight for ${id}`);
    }
    if (reliabilityScoring && !['held', 'age-excluded'].includes(row.status)) {
      ensure(number(row.ageMinutes) && row.points === freshsearch.freshContentDiscoveryAgePoints(row.ageMinutes),
        `FCD points do not match the reference age for ${id}`);
    }
    if (reliabilityScoring && ['held', 'age-excluded'].includes(row.status)) {
      ensure(row.ageMinutes === undefined && row.points === undefined && row.earnedPoints === undefined,
        `Excluded FCD target cannot contribute points for ${id}`);
    }
    return row;
  });
  const providers = new Set();
  const summary = report.summary.map(item => {
    ensure(object(item), 'Invalid summary entry');
    const providerId = text(item.providerId, 'summary provider ID');
    ensure(!providers.has(providerId), `Duplicate provider summary ${providerId}`); providers.add(providerId);
    const rows = cases.filter(row => row.providerId === providerId);
    const scored = rows.filter(row => row.status === 'scored');
    const held = rows.filter(row => row.status === 'held').length;
    const excludedAge = rows.filter(row => row.status === 'age-excluded').length;
    const unknown = rows.length - scored.length - held - excludedAge;
    for (const [field, expected] of Object.entries({ assignedRows: rows.length, scoredRows: scored.length,
      heldRows: held, unknownRows: unknown, zeroScoreRows: scored.filter(row => row.score === 0).length })) {
      ensure(item[field] === expected, `Summary ${field} does not match cases for ${providerId}`);
    }
    const assigned = report.panel === 'fcd' ? item.assignedTargets : rows.length;
    ensure(count(assigned) && assigned > 0, `Missing/invalid assigned opportunities for ${providerId}`);
    if (report.panel === 'fcd') {
      ensure(assigned % 10 === 0 && assigned === scored.length + unknown + excludedAge + held * 10 &&
        item.heldFeeds === held, `FCD assignedTargets/heldFeeds do not match cases for ${providerId}`);
    }
    const eligible = reliabilityScoring ? rows.filter(row => number(row.points)) : scored;
    if (reliabilityScoring) ensure(item.eligibleTargets === eligible.length &&
      item.unavailableTargets === unknown && item.excludedAgeTargets === excludedAge,
    `FCD eligible/unavailable support mismatch for ${providerId}`);
    const earned = report.panel === 'fcd' && eligible.length ? eligible.reduce((sum, row) => sum + row.earnedPoints, 0) : null;
    const possible = report.panel === 'fcd' ? eligible.reduce((sum, row) => sum + row.points, 0) : null;
    const score = report.panel === 'fcd' ? possible ? 100 * earned / possible : null :
      scored.length ? scored.reduce((sum, row) => sum + row.score, 0) / scored.length : null;
    const coverage = scored.length / assigned;
    ensure(near(item.score, score) && near(item.coverage, coverage), `Summary score/coverage mismatch for ${providerId}`);
    if (report.panel === 'fcd') ensure(near(item.earnedPoints, earned) && near(item.possiblePoints, possible),
      `Summary FCD point totals mismatch for ${providerId}`);
    const timed = scored.length > 0 && scored.every(row => number(row.searchMs));
    return { providerId, score, coverage, assigned, scored: scored.length, held, unknown,
      earnedPoints: earned, possiblePoints: possible,
      ...(reliabilityScoring ? { eligibleTargets: eligible.length, unavailableTargets: unknown,
        excludedAgeTargets: excludedAge } : {}),
      ...(report.panel === 'fcd' ? { retrieval: summarizeRetrieval(reliabilityScoring ? rows : scored) } : {}),
      ...(['freshsearch-traced-report-v1', 'freshsearch-reliability-report-v1',
        'freshsearch-launch-report-v1'].includes(report.version) ? {
        searchSeconds: timed ? scored.reduce((sum, row) => sum + row.searchMs, 0) / scored.length / 1000 : null,
      } : {}) };
  });
  ensure(cases.every(row => providers.has(row.providerId)), 'Case provider absent from summary');
  const source = object(report.source) ? report.source : null;
  const outputSha256 = source && !('sourceCommit' in source) && !('sourceRepository' in source) &&
    !('sourceCommit' in report) && /^[a-f0-9]{64}$/.test(source.outputSha256 ?? '') ?
    source.outputSha256 : null;
  const provenance = { outputSha256 };
  if (report.inputHash !== undefined) ensure(typeof report.inputHash === 'string' &&
    /^[a-f0-9]{64}$/.test(report.inputHash), 'Invalid inputHash');
  if (report.receiptId !== undefined) ensure(typeof report.receiptId === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(report.receiptId),
  'Invalid receiptId');
  if (report.retention !== undefined) ensure(report.retention === 'metadata-only-not-replayable' &&
    report.receiptId && report.inputHash === undefined, 'Invalid metadata-only receipt');
  const policy = { fingerprint: hash(report.policy) };
  for (const field of ['scoringVersion', 'policyId', 'policyVersion']) {
    if (report.policy[field] !== undefined) policy[field] = optionalText(report.policy[field]);
  }
  return { panel: report.panel, kind: report.kind, policy, provenance,
    inputHash: report.inputHash ?? null, receiptId: report.receiptId ?? null,
    retention: report.retention ?? null, summary, cases };
}

async function readOptional(directory, filename, budget) {
  const full = path.join(directory, filename);
  let handle;
  try {
    const stat = await fs.lstat(full);
    ensure(stat.isFile() && !stat.isSymbolicLink(), `${filename} must be a regular, non-symlink file`);
    ensure(stat.size <= MAX_FILE, `${filename} exceeds the 8 MiB limit`);
    // O_NOFOLLOW also protects a file replaced by a symlink between inspection and open.
    handle = await fs.open(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(MAX_FILE + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    ensure(length <= MAX_FILE, `${filename} exceeds the 8 MiB limit`);
    budget.bytes += length;
    ensure(budget.bytes <= MAX_TOTAL, 'Selected inputs exceed the 32 MiB collection limit');
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error(`${filename}: malformed JSON`);
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

export async function collectRuns(directories) {
  ensure(Array.isArray(directories) && directories.length > 0 && directories.length <= 100,
    'Select between 1 and 100 run folders with --run');
  const budget = { bytes: 0 };
  const runs = [];
  const groups = [];
  const identities = new Map();
  let totalCases = 0;
  for (const [index, directory] of directories.entries()) {
    const run = { id: `run-${index + 1}`, label: text(path.basename(path.resolve(directory)), 'run folder name'),
      diagnostics: [], status: 'unavailable', report: null, duplicateOf: null, groupId: null };
    runs.push(run);
    const stat = await fs.lstat(directory);
    ensure(stat.isDirectory() && !stat.isSymbolicLink(), `Run ${index + 1} must be a non-symlink directory`);
    let failure;
    let capture;
    let checkpoint;
    let raw;
    let invalid = false;
    for (const filename of ['failure.json', 'capture.json', 'checkpoint.json', 'results.json']) {
      try {
        const value = await readOptional(directory, filename, budget);
        if (filename === 'failure.json') failure = value;
        if (filename === 'capture.json') capture = value;
        if (filename === 'checkpoint.json') checkpoint = value;
        if (filename === 'results.json') raw = value;
      } catch (error) {
        if (/exceeds|exceed/.test(error.message)) throw error;
        invalid = true;
        run.diagnostics.push(`${filename}: ${error.code ?? error.message}`);
      }
    }
    if (failure !== undefined) {
      run.status = 'failed';
      run.diagnostics.push('Failure receipt present. Paid calls may have occurred; inspect locally and reconcile usage. No redispatch is performed.');
      if (!object(failure) || failure.status !== 'failed') {
        invalid = true; run.diagnostics.push('Malformed failure receipt (expected status: failed).');
      }
    }
    if (capture !== undefined && (!object(capture) || !['freshsearch-portable-input-v1', 'freshsearch-traced-input-v1',
      'freshsearch-reliability-input-v1', 'freshsearch-confirmed-clock-capture-v1',
      'freshsearch-fcd-capture-v1'].includes(capture.version) ||
      !['fcd', 'ef'].includes(capture.panel) || !kinds.includes(capture.kind) ||
      !Array.isArray(capture.panel === 'fcd' ? capture.episodes : capture.records))) {
      invalid = true; run.diagnostics.push('Malformed capture header/collection: inspect the original checkpoint locally.');
    }
    if (checkpoint !== undefined && (!object(checkpoint) ||
      checkpoint.version !== 'freshsearch-metadata-checkpoint-v1' ||
      !['fcd', 'ef'].includes(checkpoint.panel) ||
      !['live-capture', 'retained-capture'].includes(checkpoint.kind) ||
      checkpoint.replayable !== false ||
      !['running', 'complete'].includes(checkpoint.status) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(checkpoint.receiptId ?? ''))) {
      invalid = true; run.diagnostics.push('Malformed metadata-only checkpoint.');
    }
    if (raw === undefined) {
      if (failure === undefined) run.status = invalid ? 'invalid' :
        capture !== undefined || checkpoint !== undefined ? 'capture-only' : 'empty';
      run.diagnostics.push(checkpoint !== undefined ? 'Metadata-only checkpoint: evidence is not retained or replayable.' :
        capture !== undefined ? 'Retained capture only: not scored or replayed by this viewer.' : 'No readable results.json.');
      continue;
    }
    try {
      ensure(!invalid, 'Malformed companion file: report excluded from comparison');
      const report = parseReport(raw);
      if (capture !== undefined) {
        ensure(object(capture) && ['freshsearch-portable-input-v1', 'freshsearch-traced-input-v1',
          'freshsearch-reliability-input-v1', 'freshsearch-confirmed-clock-capture-v1',
          'freshsearch-fcd-capture-v1'].includes(capture.version) &&
          capture.panel === report.panel && capture.kind === report.kind, 'Capture/report identity mismatch');
        if (report.inputHash) ensure(createHash('sha256').update(JSON.stringify(capture)).digest('hex') === report.inputHash,
          'Capture does not match report inputHash');
      } else if (report.retention === 'metadata-only-not-replayable') {
        if (checkpoint !== undefined) ensure(checkpoint.status === 'complete' &&
          checkpoint.panel === report.panel && checkpoint.kind === report.kind &&
          checkpoint.receiptId === report.receiptId, 'Checkpoint/report identity mismatch');
        run.diagnostics.push('Metadata-only receipt: original evidence is not retained or replayable.');
      } else run.diagnostics.push('Capture unavailable: inputHash cannot be independently checked.');
      totalCases += report.cases.length;
      ensure(totalCases <= MAX_CASES, 'Selected inputs exceed the 50000-case collection limit');
      run.report = report;
      if (failure !== undefined) {
        run.diagnostics.push('Report retained for inspection only; failure excludes this run from charts and comparisons.');
        continue;
      }
      run.status = 'complete';
      if (!report.inputHash && !report.receiptId) run.diagnostics.push('Legacy report lacks inputHash: only exact report copies can be deduplicated.');
      if (!report.provenance.outputSha256) run.diagnostics.push('Missing scorer provenance: isolated from other runs.');
      const signature = hash({ panel: report.panel, kind: report.kind, policy: report.policy,
        source: report.provenance.outputSha256,
        ...(raw.version === 'freshsearch-traced-report-v1' ? { execution: {
          sourceHashes: raw.execution?.sourceHashes ?? null,
          adapter: raw.execution?.adapter ?? null,
          configHashes: [...new Set(raw.cases.map(item => item.effectiveConfigHash ?? null))].sort(),
          judgeConfigHashes: [...new Set(raw.cases.map(item => item.judge?.configHash ?? null))].sort(),
          promptVersions: [...new Set(raw.cases.map(item => item.judge?.promptVersion ?? null))].sort(),
        } } : {}),
        missingSource: report.provenance.outputSha256 ? null : hash(raw) });
      const identity = hash([signature, report.inputHash ?? report.receiptId ?? hash(raw)]);
      const reportHash = hash(report);
      const previous = identities.get(identity);
      if (previous) {
        previous.members.push(run);
        if (previous.reportHash !== reportHash) previous.conflict = true;
        ensure(previous.reportHash === reportHash, 'Conflicting reports for the same inputHash and scoring provenance');
        run.duplicateOf = previous.run.id;
        run.status = 'duplicate';
        run.diagnostics.push(`Replay duplicate of ${previous.run.label}; excluded from charts and totals.`);
      } else identities.set(identity, { run, reportHash, members: [run], conflict: false });
      let group = groups.find(item => item.signature === signature);
      if (!group) {
        group = { id: `group-${groups.length + 1}`, signature, panel: report.panel,
          kind: report.kind, provenance: report.provenance, runs: [] };
        groups.push(group);
      }
      run.groupId = group.id;
      group.runs.push(run.id);
    } catch (error) {
      if (/collection limit/.test(error.message)) throw error;
      run.status = failure !== undefined ? 'failed' : 'invalid';
      run.report = null;
      run.diagnostics.push(error.message);
    }
  }
  // Exclude every copy of a conflicting identity so selection order cannot choose the displayed score.
  for (const entry of identities.values()) {
    if (!entry.conflict) continue;
    for (const member of entry.members.filter(item => item.status !== 'invalid')) {
      member.status = 'invalid';
      member.report = null;
      member.duplicateOf = null;
      member.diagnostics.push('Conflicting reports for the same inputHash and scoring provenance');
      const group = groups.find(item => item.id === member.groupId);
      if (group) group.runs = group.runs.filter(id => id !== member.id);
      member.groupId = null;
    }
  }
  const retained = groups.filter(group => group.runs.length);
  for (const [index, group] of retained.entries()) {
    const id = `group-${index + 1}`;
    for (const run of runs) if (run.groupId === group.id) run.groupId = id;
    group.id = id;
  }
  groups.splice(0, groups.length, ...retained);
  return { version: 'freshsearch-viewer-v1', runs, groups,
    limitations: [
      'Exploratory observations only. Each run stays separate; unrelated reruns are never pooled.',
      'Compatibility groups separate panel, capture kind, exact scoring policy and source provenance; they do not prove matched targets.',
      'Coverage counts assignments retained in each report, not undispatched work outside it. Cohort completeness and provider configuration are unknown.',
      'Older captures may lack timing. Newer captures retain measured stage timings locally; panel scores are not combined or ranked.',
      'Capture kind is self-declared; replay does not establish original collection quality. No provider, publisher or judge calls are made.',
      'HTML includes provider identifiers, independent panel values, minimal provenance, FCD retrieval/age aggregates and up to 20 missed target IDs/ages/points per observation. Captures, configs, article URLs/text, reasons and evidence stay out. Review identifiers before sharing.',
    ] };
}

export async function main(args = process.argv.slice(2), { diagnostic = message => message } = {}) {
  const { values } = parseArgs({ args, options: {
    run: { type: 'string', multiple: true }, out: { type: 'string' },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage: node report.mjs --run RUN_FOLDER [--run RUN_FOLDER ...] --out NEW_REPORT.html\nOffline only. Review provider identifiers before sharing.');
    return;
  }
  ensure(values.out, 'Require --out NEW_REPORT.html');
  const collection = await collectRuns(values.run);
  const html = renderViewer(collection);
  await fs.writeFile(path.resolve(values.out), html, { flag: 'wx', mode: 0o600 });
  for (const run of collection.runs) {
    for (const message of run.diagnostics) console.error(`${run.id} (${run.label}): ${diagnostic(message)}`);
  }
  console.log(JSON.stringify({ output: path.resolve(values.out), runs: collection.runs.length,
    groups: collection.groups.length, diagnostics: collection.runs.filter(run => run.diagnostics.length).length,
    warning: 'Review provider and missed target identifiers before sharing. FCD counts/ages/points are included; captures, configuration, article URLs/text and evidence are not.' }));
  return collection;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(main);
}
