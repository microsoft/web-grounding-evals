// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collectRuns, main, parseReport, safeUrl, summarizeRetrieval } from './report.mjs';
import { renderViewer } from './report-ui.mjs';
import { scoreCapture, summarize } from './run.mjs';
import { main as demo } from './report-demo.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = async filename => JSON.parse(await fs.readFile(path.join(root, filename), 'utf8'));
const fixture = panel => read(`examples/${panel}-results.json`);
async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freshsearch-viewer-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function runFolder(directory, name, files) {
  const folder = path.join(directory, name);
  await fs.mkdir(folder);
  for (const [filename, value] of Object.entries(files)) {
    await fs.writeFile(path.join(folder, filename), JSON.stringify(value));
  }
  return folder;
}
function recalculate(report) {
  for (const summary of report.summary) {
    const rows = report.cases.filter(row => row.providerId === summary.providerId);
    const scored = rows.filter(row => row.status === 'scored');
    summary.scoredRows = scored.length;
    summary.heldRows = rows.filter(row => row.status === 'held').length;
    summary.unknownRows = rows.length - summary.scoredRows - summary.heldRows;
    summary.zeroScoreRows = scored.filter(row => row.score === 0).length;
    if (report.panel === 'fcd') {
      summary.earnedPoints = scored.length ? scored.reduce((sum, row) => sum + row.earnedPoints, 0) : null;
      summary.possiblePoints = scored.reduce((sum, row) => sum + row.points, 0);
      summary.score = summary.possiblePoints ? 100 * summary.earnedPoints / summary.possiblePoints : null;
      summary.coverage = scored.length / summary.assignedTargets;
    } else {
      summary.score = scored.length ? scored.reduce((sum, row) => sum + row.score, 0) / scored.length : null;
      summary.coverage = scored.length / rows.length;
    }
  }
  return report;
}

test('existing FCD and EF fixture parity with original standalone scorer', async () => {
  for (const panel of ['fcd', 'ef']) {
    const source = await read(`examples/${panel}.json`);
    const expected = summarize(scoreCapture(source, panel), panel)[0];
    const parsed = parseReport(await fixture(panel));
    assert.equal(parsed.summary[0].score, expected.score);
    assert.equal(parsed.summary[0].coverage, expected.coverage);
    assert.equal(parsed.summary[0].assigned, panel === 'fcd' ? expected.assignedTargets : expected.assignedRows);
    assert.equal(parsed.summary[0].held, 1);
  }
});

test('FCD sums earned/possible age points across feeds rather than averaging feed percentages', async () => {
  const report = await fixture('fcd');
  const second = structuredClone(report.cases);
  for (const row of second) {
    row.id = `second-${row.id}`;
    if (row.status === 'scored') {
      row.points = 1; row.earnedPoints = 1; row.score = 100;
    }
  }
  report.cases.push(...second);
  report.summary[0].assignedRows *= 2;
  report.summary[0].assignedTargets *= 2;
  report.summary[0].heldFeeds *= 2;
  recalculate(report);
  const summary = parseReport(report).summary[0];
  assert.equal(summary.score, 100 * 60 / 102);
  assert.notEqual(summary.score, (100 * 51 / 93 + 100) / 2);
  assert.equal(summary.coverage, 18 / 40);
});

test('nine of ten hits show 90% hit rate separately from 83.87 weighted score and full coverage', async () => {
  const report = await fixture('fcd');
  const ages = [10, 360, 600, 1439, 1440, 1500, 2000, 3000, 4000, 60];
  const points = [15, 2, 2, 2, 1, 1, 1, 1, 1, 5];
  report.cases = ages.map((ageMinutes, index) => ({
    id: `synthetic-feed/${index + 1}`, providerId: 'fixture', status: 'scored',
    score: index === 9 ? 0 : 100, reason: index === 9 ? 'miss' : 'hit',
    ageMinutes, points: points[index], earnedPoints: index === 9 ? 0 : points[index],
  }));
  Object.assign(report.summary[0], { assignedRows: 10, assignedTargets: 10, heldFeeds: 0 });
  recalculate(report);
  const parsed = parseReport(report);
  const summary = parsed.summary[0];
  assert.equal(summary.score, 100 * 26 / 31);
  assert.equal(summary.coverage, 1);
  assert.equal(summary.retrieval.hits, 9);
  assert.equal(summary.retrieval.misses, 1);
  assert.deepEqual(summary.retrieval.missedTargets, [{ id: 'synthetic-feed/10', ageMinutes: 60, points: 5 }]);
  const html = renderViewer({ version: 'freshsearch-viewer-v1',
    runs: [{ id: 'run-1', groupId: 'group-1', status: 'complete', report: parsed }] });
  assert.match(html, /83\.87<span/);
  assert.match(html, /26\/31 age-weighted points/);
  assert.match(html, /9\/10 scored targets found/);
  assert.match(html, /90\.0% hit rate/);
  assert.match(html, /Coverage: 10\/10 assigned \(100\.0%\)/);
  assert.match(html, /1–6h: 0\/1 found, 0\/5 pt/);
  assert.match(html, /synthetic-feed\/10 \(60\.0 min; 5 pt\)/);
  assert.match(html, /Single-feed pilots are setup checks, not provider comparisons/);
});

test('FCD unknown and held targets are not misses, and unavailable ages are not inferred', async () => {
  const raw = await fixture('fcd');
  delete raw.cases[0].ageMinutes;
  const report = parseReport(raw);
  const summary = report.summary[0];
  assert.equal(summary.retrieval.hits, 5);
  assert.equal(summary.retrieval.misses, 4);
  assert.equal(summary.retrieval.ageBands[5].scored, 1);
  assert.equal(summary.retrieval.ageBands[5].possiblePoints, 15);
  const html = renderViewer({ version: 'freshsearch-viewer-v1',
    runs: [{ id: 'run-1', groupId: 'group-1', status: 'complete', report }] });
  assert.match(html, /Coverage: 9\/20 assigned \(45\.0%\)/);
  assert.match(html, /Misses: 4 · Held targets: 10 · Unavailable\/pending: 1/);
  assert.match(html, /Age unavailable: 1\/1 found, 15\/15 pt/);
});

test('retrieval accumulation preserves totals while explicitly bounding missed IDs in HTML', async () => {
  const cases = Array.from({ length: 50 }, (_, index) => ({
    id: `target-${index}`, status: 'scored', score: 0, ageMinutes: 60, points: 5, earnedPoints: 0,
  }));
  const first = summarizeRetrieval(cases.slice(0, 15));
  const combined = summarizeRetrieval(cases.slice(15), first);
  assert.equal(first.misses, 15);
  assert.equal(first.missedTargets.length, 15);
  assert.equal(combined.misses, 50);
  assert.equal(combined.missedTargets.length, 20);
  assert.deepEqual(combined.ageBands[2], {
    label: '1–6h', scored: 50, hits: 0, earnedPoints: 0, possiblePoints: 250,
  });
  const raw = await fixture('fcd');
  raw.cases = cases.map(row => ({ ...row, providerId: 'fixture', reason: 'miss' }));
  Object.assign(raw.summary[0], { assignedRows: 50, assignedTargets: 50, heldFeeds: 0 });
  recalculate(raw);
  const html = renderViewer({ version: 'freshsearch-viewer-v1',
    runs: [{ id: 'run-1', groupId: 'group-1', status: 'complete', report: parseReport(raw) }] });
  assert.match(html, /showing 20 of 50 misses; see cases.csv for all/);
  assert.ok(html.includes('target-19 ('));
  assert.ok(!html.includes('target-20 ('));
});

test('all held FCD and EF inputs retain null scores, not invented zeros', async () => {
  for (const panel of ['fcd', 'ef']) {
    const report = await fixture(panel);
    report.cases = report.cases.filter(row => row.status === 'held');
    report.summary[0].assignedRows = 1;
    if (panel === 'fcd') report.summary[0].assignedTargets = 10;
    recalculate(report);
    const summary = parseReport(report).summary[0];
    assert.equal(summary.score, null);
    assert.equal(summary.coverage, 0);
    assert.equal(summary.held, 1);
  }
});

test('all-held original FCD scorer null point totals are accepted without normalization to zero', async () => {
  const input = await read('examples/fcd.json');
  input.episodes = input.episodes.filter(episode => !episode.eligible);
  const scored = scoreCapture(input, 'fcd');
  const report = { ...(await fixture('fcd')), cases: scored.rows, summary: summarize(scored, 'fcd') };
  assert.equal(report.summary[0].earnedPoints, null);
  assert.equal(parseReport(report).summary[0].earnedPoints, null);
});

test('status, score, summary and denominator inconsistencies fail explicitly', async () => {
  const original = await fixture('fcd');
  const mutations = [
    report => { report.version = 'unknown'; },
    report => { report.kind = 'replay-as-live'; },
    report => { report.cases[0].score = null; },
    report => { report.cases[0].points = -1; },
    report => { report.cases[0].earnedPoints = 16; },
    report => { report.cases[0].score = 50; },
    report => { report.cases[9].score = 0; },
    report => { report.cases[0].status = 'ignored'; },
    report => { report.summary[0].score = 100; },
    report => { report.summary[0].coverage = 1; },
    report => { report.summary[0].assignedTargets = 10; },
    report => { report.summary[0].assignedTargets = 30; },
    report => { report.summary[0].heldFeeds = 0; },
    report => { report.summary[0].possiblePoints = 0; },
    report => { report.summary[0].unknownRows = 0; },
    report => { report.summary.push(report.summary[0]); },
    report => { report.cases.push(report.cases[0]); },
    report => { report.cases[0].providerId = 'absent'; },
    report => { report.policy = null; },
    report => { report.inputHash = 'not-a-hash'; },
  ];
  for (const mutate of mutations) {
    const report = structuredClone(original); mutate(report);
    assert.throws(() => parseReport(report), Error);
  }
});

test('EF pending capture-unknown remains unscored and in retained coverage denominator', async () => {
  const report = await fixture('ef');
  report.cases.push({ id: 'pending', providerId: 'fixture', score: null,
    status: 'capture-unknown', reason: 'reserved-or-interrupted-dispatch' });
  report.summary[0].assignedRows++;
  recalculate(report);
  const parsed = parseReport(report);
  assert.equal(parsed.summary[0].score, 62.5);
  assert.equal(parsed.summary[0].coverage, 4 / 6);
  assert.equal(parsed.summary[0].unknown, 1);
});

test('EF scorer future evidence and repeated task IDs preserve score parity', async () => {
  const input = await read('examples/ef.json');
  input.records[0].evidence[0].timestamp.earliestUtc = '2026-11-05T18:01:00.000Z';
  input.records.push({ ...structuredClone(input.records[0]), runId: 'distinct-repeat' });
  const scored = scoreCapture(input, 'ef');
  const report = { ...(await fixture('ef')), cases: scored.rows, summary: summarize(scored, 'ef') };
  const parsed = parseReport(report);
  assert.equal(parsed.cases[0].score, 0);
  assert.equal(parsed.cases[0].details.evidenceScores[0].reason, 'future_timestamp');
  assert.equal(parsed.cases.length, 6);
  assert.equal(parsed.summary[0].score, report.summary[0].score);
});

test('exact replay inputHash deduplication and deterministic output', async t => {
  const directory = await workspace(t);
  const report = await fixture('fcd'); report.inputHash = 'a'.repeat(64);
  const first = await runFolder(directory, 'original', { 'results.json': report });
  const second = await runFolder(directory, 'replay', { 'results.json': report });
  const data = await collectRuns([first, second]);
  assert.equal(data.runs[1].status, 'duplicate');
  assert.equal(data.runs[1].duplicateOf, 'run-1');
  assert.equal(data.runs.filter(run => run.status === 'complete').length, 1);
  assert.deepEqual(await collectRuns([first, second]), data);
  assert.equal(renderViewer(data), renderViewer(data));
});

test('legacy exact report copies deduplicate with visible limitations', async t => {
  const directory = await workspace(t);
  const report = await fixture('fcd');
  const first = await runFolder(directory, 'first', { 'results.json': report });
  const second = await runFolder(directory, 'second', { 'results.json': report });
  const data = await collectRuns([first, second]);
  assert.equal(data.runs[1].status, 'duplicate');
  assert.match(data.runs[0].diagnostics.join(' '), /lacks inputHash/);
});

test('unrelated reruns stay separate even with identical case IDs', async t => {
  const directory = await workspace(t);
  const report = await fixture('fcd'); report.inputHash = 'a'.repeat(64);
  const first = await runFolder(directory, 'first', { 'results.json': report });
  report.inputHash = 'b'.repeat(64);
  const second = await runFolder(directory, 'later', { 'results.json': report });
  const data = await collectRuns([first, second]);
  assert.equal(data.groups.length, 1);
  assert.deepEqual(data.runs.map(run => run.status), ['complete', 'complete']);
  assert.equal(data.runs[0].report.summary[0].assigned, 20);
  assert.equal(data.runs[1].report.summary[0].assigned, 20);
});

test('policy, source manifest, panel, and capture kind never share compatibility groups', async t => {
  const directory = await workspace(t);
  const original = await fixture('fcd'); original.inputHash = 'a'.repeat(64);
  const reports = [original, structuredClone(original), structuredClone(original), structuredClone(original), await fixture('ef')];
  reports[1].policy.scoringVersion = 'different-policy';
  reports[2].source = { outputSha256: 'b'.repeat(64) };
  reports[3].kind = 'live-capture';
  const folders = [];
  for (const [index, report] of reports.entries()) {
    folders.push(await runFolder(directory, `run-${index}`, { 'results.json': report }));
  }
  const data = await collectRuns(folders);
  assert.equal(data.groups.length, 5);
  assert.ok(data.runs.every(run => run.status === 'complete'));
});

test('missing scorer provenance is diagnosed and isolated', async t => {
  const directory = await workspace(t);
  const report = await fixture('fcd'); delete report.source;
  report.inputHash = 'a'.repeat(64);
  const first = await runFolder(directory, 'first', { 'results.json': report });
  report.inputHash = 'b'.repeat(64);
  const second = await runFolder(directory, 'second', { 'results.json': report });
  const duplicate = await runFolder(directory, 'exact-copy', { 'results.json': report });
  const data = await collectRuns([first, second, duplicate]);
  assert.equal(data.groups.length, 2);
  assert.match(data.runs[0].diagnostics.join(' '), /Missing scorer provenance/);
  assert.equal(data.runs[2].status, 'duplicate');
});

test('legacy commit provenance is isolated from bundle-hash reports', async t => {
  const directory = await workspace(t);
  const current = await fixture('fcd');
  current.inputHash = 'a'.repeat(64);
  const legacy = structuredClone(current);
  legacy.source.sourceCommit = 'old-commit';
  const first = await runFolder(directory, 'current', { 'results.json': current });
  const second = await runFolder(directory, 'legacy', { 'results.json': legacy });
  const data = await collectRuns([first, second]);
  assert.equal(data.groups.length, 2);
  assert.ok(data.runs.every(run => run.status === 'complete'));
  assert.match(data.runs[1].diagnostics.join(' '), /Missing scorer provenance/);
});

test('bundle hash, not unrelated source metadata, determines scorer grouping', async t => {
  const directory = await workspace(t);
  const firstReport = await fixture('fcd');
  firstReport.inputHash = 'a'.repeat(64);
  const secondReport = structuredClone(firstReport);
  secondReport.inputHash = 'b'.repeat(64);
  secondReport.source.bundledPackages = [];
  const first = await runFolder(directory, 'first', { 'results.json': firstReport });
  const second = await runFolder(directory, 'second', { 'results.json': secondReport });
  const data = await collectRuns([first, second]);
  assert.equal(data.groups.length, 1);
});

test('conflicting reports bound to the same input are excluded, not silently counted', async t => {
  const directory = await workspace(t);
  const report = await fixture('fcd'); report.inputHash = 'a'.repeat(64);
  const first = await runFolder(directory, 'first', { 'results.json': report });
  const copy = await runFolder(directory, 'first-copy', { 'results.json': report });
  report.cases[0].reason = 'changed';
  const second = await runFolder(directory, 'conflict', { 'results.json': report });
  for (const order of [[first, copy, second], [second, first, copy]]) {
    const data = await collectRuns(order);
    assert.ok(data.runs.every(run => run.status === 'invalid' && run.report === null && run.groupId === null));
    assert.ok(data.runs.every(run => /Conflicting reports/.test(run.diagnostics.join(' '))));
    assert.equal(data.groups.length, 0);
  }
});

test('partial, failure, empty, malformed and unreadable inputs are visible, never misses', async t => {
  const directory = await workspace(t);
  const report = await fixture('fcd');
  const capture = await read('examples/fcd.json');
  const folders = [
    await runFolder(directory, 'failed', { 'failure.json': { status: 'failed' }, 'capture.json': capture }),
    await runFolder(directory, 'partial', { 'capture.json': capture }),
    await runFolder(directory, 'empty', {}),
    await runFolder(directory, 'malformed', {}),
    await runFolder(directory, 'not-file', {}),
    await runFolder(directory, 'failure-with-report', { 'failure.json': { status: 'failed' }, 'results.json': report }),
  ];
  await fs.writeFile(path.join(folders[3], 'results.json'), '{"bad"');
  await fs.mkdir(path.join(folders[4], 'results.json'));
  const data = await collectRuns(folders);
  assert.deepEqual(data.runs.map(run => run.status), ['failed', 'capture-only', 'empty', 'invalid', 'invalid', 'failed']);
  assert.equal(data.groups.length, 0);
  assert.ok(data.runs.every(run => run.diagnostics.length > 0));
  assert.ok(data.runs[5].report);
  assert.match(JSON.stringify(data), /Paid calls may have occurred/);
});

test('capture hashing is validated without embedding arbitrary retained content', async t => {
  const directory = await workspace(t);
  const report = await fixture('fcd');
  const capture = await read('examples/fcd.json');
  capture.secretConfig = 'never-embed-this-secret';
  report.inputHash = createHash('sha256').update(JSON.stringify(capture)).digest('hex');
  const first = await runFolder(directory, 'valid', { 'capture.json': capture, 'results.json': report });
  const valid = await collectRuns([first]);
  assert.equal(valid.runs[0].status, 'complete');
  assert.ok(!renderViewer(valid).includes('never-embed-this-secret'));
  capture.secretConfig = 'tampered';
  const second = await runFolder(directory, 'mismatch', { 'capture.json': capture, 'results.json': report });
  const invalid = await collectRuns([second]);
  assert.equal(invalid.runs[0].status, 'invalid');
  assert.match(invalid.runs[0].diagnostics.join(' '), /does not match/);
});

test('malformed companion files and mismatched capture identity exclude reports', async t => {
  const directory = await workspace(t);
  const report = await fixture('fcd');
  const folder = await runFolder(directory, 'run', { 'results.json': report, 'capture.json': { panel: 'ef' } });
  assert.equal((await collectRuns([folder])).runs[0].status, 'invalid');
  await fs.writeFile(path.join(folder, 'capture.json'), 'malformed');
  assert.equal((await collectRuns([folder])).runs[0].status, 'invalid');
});

test('JSON null inputs and malformed capture-only headers are not successful or empty runs', async t => {
  const directory = await workspace(t);
  const folders = [
    await runFolder(directory, 'null-report', { 'results.json': null }),
    await runFolder(directory, 'null-capture', { 'capture.json': null }),
    await runFolder(directory, 'bad-capture', { 'capture.json': { kind: 'live-capture' } }),
    await runFolder(directory, 'null-failure', { 'failure.json': null }),
  ];
  assert.deepEqual((await collectRuns(folders)).runs.map(run => run.status), ['invalid', 'invalid', 'invalid', 'failed']);
});

test('fixed filenames only: report-provided paths and raw config/content are not included', async t => {
  const directory = await workspace(t);
  const report = await fixture('fcd');
  report.capturePath = '../../secret.json';
  report.source = { ...report.source, credentials: 'source-secret' };
  report.policy.credentials = 'policy-secret';
  report.cases[0].details.rawContent = 'publisher-content-secret';
  report.cases[0].details.evidenceScores = [{ evidenceId: 'e1', reason: 'scored', url: 'file:///etc/passwd' }];
  const folder = await runFolder(directory, 'run', { 'results.json': report });
  const html = renderViewer(await collectRuns([folder]));
  for (const secret of ['source-secret', 'policy-secret', 'publisher-content-secret', '../../secret.json', 'file:///etc/passwd']) {
    assert.ok(!html.includes(secret), secret);
  }
});

test('symlink report paths and run folders are rejected', async t => {
  const directory = await workspace(t);
  const report = await fixture('fcd');
  const target = await runFolder(directory, 'target', { 'results.json': report });
  const folder = await runFolder(directory, 'run', {});
  // Windows junctions exercise link rejection without requiring symlink privileges.
  await fs.symlink(process.platform === 'win32' ? target : path.join(target, 'results.json'),
    path.join(folder, 'results.json'), process.platform === 'win32' ? 'junction' : 'file');
  const data = await collectRuns([folder]);
  assert.equal(data.runs[0].status, 'invalid');
  await fs.symlink(target, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(collectRuns([path.join(directory, 'linked')]), /non-symlink directory/);
});

test('large inputs and excessive selections fail with actionable limits', async t => {
  const directory = await workspace(t);
  const folder = await runFolder(directory, 'large', {});
  await fs.writeFile(path.join(folder, 'results.json'), ' '.repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(collectRuns([folder]), /8 MiB limit/);
  await assert.rejects(collectRuns([]), /1 and 100/);
  await assert.rejects(collectRuns(Array(101).fill(folder)), /1 and 100/);
  const report = await fixture('fcd');
  report.cases = Array(50001).fill(report.cases[0]);
  assert.throws(() => parseReport(report), /oversized case/);
});

test('collection byte limit is enforced at exactly 32 MiB, without silently dropping inputs', async t => {
  const directory = await workspace(t);
  const folder = await runFolder(directory, 'large', {});
  const json = '{"padding":"' + 'a'.repeat(8 * 1024 * 1024 - 14) + '"}';
  assert.equal(Buffer.byteLength(json), 8 * 1024 * 1024);
  await fs.writeFile(path.join(folder, 'results.json'), json);
  assert.equal((await collectRuns(Array(4).fill(folder))).runs.length, 4);
  await assert.rejects(collectRuns(Array(5).fill(folder)), /32 MiB collection limit/);
});

test('collection case limit accepts 50000 cases and rejects 50001 before generating HTML', async t => {
  const directory = await workspace(t);
  const report = await fixture('ef');
  report.cases = Array.from({ length: 25000 }, (_, index) => ({
    id: `held-${index}`, providerId: 'fixture', score: null, status: 'held', reason: 'reference_unavailable',
  }));
  report.summary = [{ providerId: 'fixture', assignedRows: 25000, scoredRows: 0,
    heldRows: 25000, unknownRows: 0, zeroScoreRows: 0, coverage: 0, score: null }];
  report.inputHash = 'a'.repeat(64);
  const first = await runFolder(directory, 'first', { 'results.json': report });
  report.inputHash = 'b'.repeat(64);
  const second = await runFolder(directory, 'second', { 'results.json': report });
  assert.equal((await collectRuns([first, second])).runs.length, 2);
  report.cases.push({ id: 'one-more', providerId: 'fixture', score: null, status: 'held', reason: 'reference_unavailable' });
  report.summary[0].assignedRows++; report.summary[0].heldRows++;
  await fs.writeFile(path.join(second, 'results.json'), JSON.stringify(report));
  await assert.rejects(collectRuns([first, second]), /50000-case collection limit/);
});

test('parser sanitizes unsafe and local evidence URLs without exposing evidence in HTML', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', '../secret',
    '/etc/passwd', '//example.org', 'https://user:password@example.org', 'https:\\\\example.org',
    'https://example.org/\nmalicious', ' javascript:alert(1)']) assert.equal(safeUrl(value), null, value);
  assert.equal(safeUrl('https://example.org/evidence?q=x'), 'https://example.org/evidence?q=x');
});

test('untrusted provider and missed target IDs are escaped while reasons and evidence stay private', async () => {
  const report = await fixture('fcd');
  const payload = '</script><img src=x onerror=alert(1)><!--&\u2028\u2029';
  report.summary[0].providerId = payload;
  for (const row of report.cases) row.providerId = payload;
  report.cases[1].id = payload;
  report.cases[0].reason = 'retained-case-detail-must-not-be-embedded';
  const data = { version: 'freshsearch-viewer-v1',
    runs: [{ id: 'run-1', groupId: 'group-1', status: 'complete', report: parseReport(report) }], groups: [] };
  const html = renderViewer(data);
  assert.ok(html.includes('&lt;/script&gt;&lt;img'));
  assert.ok(!html.includes(payload));
  assert.ok(!/<(?:script|img)\b/i.test(html));
  assert.ok(!html.includes('retained-case-detail-must-not-be-embedded'));
  assert.ok(!html.includes(report.cases[0].recordHash));
});

test('self-contained HTML has no remote dependencies, fetches or arbitrary file inclusion', async () => {
  const html = renderViewer({ version: 'freshsearch-viewer-v1', runs: [], groups: [], limitations: [] });
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /img-src 'none'/);
  assert.match(html, /base-uri 'none'/);
  assert.ok(!/<(?:script|link|img|iframe)[^>]+(?:src|href)=/i.test(html));
  assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/.test(html));
  assert.match(html, /script-src 'none'/);
  assert.ok(!/<script\b/i.test(html));
});

test('static surface keeps two latency plots and one provider table without interactive controls', () => {
  const html = renderViewer({ version: 'freshsearch-viewer-v1', runs: [], groups: [] });
  assert.equal((html.match(/<svg\b/g) ?? []).length, 2);
  assert.equal((html.match(/<table\b/g) ?? []).length, 1);
  assert.ok(!/<(?:button|input|select|details|nav|a|progress)\b/i.test(html));
  assert.ok(!/drill.down|pagination|filter|Pareto/i.test(html));
  assert.match(html, /FCD retrieval outcomes/);
  assert.match(html, /id="fcd-heading">Fresh Content Discovery \(FCD\)</);
  assert.match(html, /id="ef-heading">Evidence Freshness \(EF\)</);
  assert.match(html, /aria-label="Fresh Content Discovery score versus latency/);
  assert.match(html, /aria-label="Evidence Freshness score versus latency/);
  assert.doesNotMatch(html, /Score vs\. latency — combined|<th scope="col">Combined|<th scope="col">#/);
  assert.match(html, /How to read/);
  assert.match(html, /retrieval latency, log s/);
  assert.match(html, /call latency, s/);
  assert.equal((html.match(/>Latency not measured</g) ?? []).length, 2);
  assert.ok(!/<circle\b/i.test(html));
  assert.ok(!/80%|20%|0\.8\s*[×*]/.test(html));
});

test('table retains independent FCD/EF values without combined scores, fake ranks or weighted bars', async t => {
  const directory = await workspace(t);
  const first = await runFolder(directory, 'fcd', { 'results.json': await fixture('fcd') });
  const second = await runFolder(directory, 'ef', { 'results.json': await fixture('ef') });
  const html = renderViewer(await collectRuns([first, second]));
  assert.doesNotMatch(html, /Combined score unavailable|aria-label="Not ranked"/);
  assert.ok(!html.includes('bar-unavailable'));
  assert.match(html, /class="panel-value">54\.84<span/);
  assert.match(html, /class="panel-value">62\.5</);
  assert.equal((html.match(/class="missing">Not evaluated/g) ?? []).length, 3);
  assert.match(html, /Independent runs, not paired or ranked/);
});

test('generator uses explicit folders, creates private offline HTML and refuses overwrite', async t => {
  const directory = await workspace(t);
  const folder = await runFolder(directory, 'fixture-fcd', { 'results.json': await fixture('fcd') });
  const output = path.join(directory, 'result.html');
  const args = ['--run', folder, '--out', output];
  const data = await main(args);
  assert.equal(data.runs[0].status, 'complete');
  const html = await fs.readFile(output, 'utf8');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /SYNTHETIC FIXTURE/);
  await assert.rejects(main(args), /EEXIST/);
  assert.equal(await fs.readFile(output, 'utf8'), html);
  if (process.platform !== 'win32') assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  await assert.rejects(main(['--out', output]), /1 and 100/);
  await assert.rejects(main(['--run', folder]), /Require --out/);
});

test('portable multi-provider demo is clearly synthetic, scorer-derived and overwrite-safe', async t => {
  const directory = await workspace(t);
  const output = path.join(directory, 'demo');
  const data = await demo(['--out', output]);
  assert.equal(data.groups.length, 2);
  assert.equal(data.runs.filter(run => run.status === 'complete').length, 4);
  assert.equal(data.runs.filter(run => run.status === 'duplicate').length, 1);
  assert.equal(data.runs.filter(run => run.status === 'failed').length, 1);
  assert.ok(data.runs.filter(run => run.report).every(run => run.report.kind === 'synthetic-fixture'));
  assert.equal(data.runs[0].report.summary[0].score, 100 * 51 / 93);
  assert.ok(data.runs[2].report.summary[0].score < data.runs[0].report.summary[0].score);
  await assert.rejects(demo(['--out', output]), /EEXIST/);
});
