// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fcdReliabilityFixture } from './fixtures/fcd-reliability.mjs';
import { scoreCapture, summarize } from './run.mjs';
import { parseReport } from './report.mjs';

function reportFor(input) {
  const scored = scoreCapture(input, 'fcd');
  return {
    version: 'freshsearch-launch-report-v1', panel: 'fcd', kind: input.kind,
    policy: scored.policy, cases: scored.rows, summary: summarize(scored, 'fcd'),
  };
}

test('FCD uses the shared reference age and includes unavailable targets in its denominator', () => {
  const report = reportFor(fcdReliabilityFixture());
  const summary = report.summary[0];
  assert.equal(summary.eligibleTargets, 10);
  assert.equal(summary.scoredRows, 7);
  assert.equal(summary.unavailableTargets, 3);
  assert.equal(summary.earnedPoints, 15);
  assert.equal(summary.possiblePoints, 70);
  assert.equal(summary.score, 100 * 15 / 70);
  assert.equal(report.cases[0].ageMinutes, 29);
  assert.equal(report.cases[1].score, null);
  assert.equal(report.cases[1].points, 15);
  assert.equal(parseReport(report).summary[0].score, summary.score);
});

test('FCD retains a zero reliability score when all eligible outcomes are unavailable', () => {
  const report = reportFor(fcdReliabilityFixture({ allUnavailable: true }));
  const summary = report.summary[0];
  assert.equal(summary.scoredRows, 0);
  assert.equal(summary.unavailableTargets, 10);
  assert.equal(summary.earnedPoints, 0);
  assert.equal(summary.possiblePoints, 70);
  assert.equal(summary.score, 0);
  assert.equal(parseReport(report).summary[0].score, 0);
});

test('FCD excludes a future target and rejects fabricated reference-age weights', () => {
  const input = fcdReliabilityFixture();
  input.episodes[0].targets[9].publishedAt = '2026-01-01T12:01:00.000Z';
  const report = reportFor(input);
  assert.equal(report.cases[9].status, 'age-excluded');
  assert.equal(report.summary[0].excludedAgeTargets, 1);
  assert.equal(report.summary[0].possiblePoints, 65);
  assert.equal(parseReport(report).summary[0].excludedAgeTargets, 1);
  report.cases[1].points = 1;
  assert.throws(() => parseReport(report), /reference age/);
});
