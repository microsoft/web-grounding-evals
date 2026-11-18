// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { parseReport, summarizeRetrieval } from './report.mjs';
import { ensure, hash } from './trace.mjs';
import { renderViewer } from './report-ui.mjs';

export function createTotals(assignments) {
  const totals = [];
  for (const assignment of assignments) {
    let total = totals.find(row => row.providerId === assignment.providerId && row.panel === assignment.panel);
    if (!total) {
      total = { providerId: assignment.providerId, panel: assignment.panel, assigned: 0,
        scored: 0, held: 0, excludedAgeTargets: 0, eligibleTargets: 0,
        earnedPoints: 0, possiblePoints: 0, scoreSum: 0, searchMs: 0, timed: 0,
        configHash: null, policyFingerprint: null,
        ...(assignment.panel === 'ef' ? { cells: [] } : {}),
        ...(assignment.panel === 'fcd' ? { retrieval: summarizeRetrieval([]) } : {}) };
      totals.push(total);
    }
    total.assigned += assignment.panel === 'fcd' ? 10 : 1;
    if (assignment.panel === 'ef') {
      ensure(['weather', 'finance'].includes(assignment.category) &&
        ['head', 'torso', 'tail'].includes(assignment.tier), 'EF assignment needs a category and tier');
      let cell = total.cells.find(row => row.category === assignment.category && row.tier === assignment.tier);
      if (!cell) {
        cell = { category: assignment.category, tier: assignment.tier, assigned: 0, scored: 0, scoreSum: 0 };
        total.cells.push(cell);
      }
      cell.assigned++;
    }
  }
  return totals;
}

export function addReport(totals, assignment, raw, expected, fingerprints) {
  const report = parseReport(raw);
  ensure(raw.version === 'freshsearch-launch-report-v1' && report.kind === 'live-capture',
    'Evaluation requires the current live scoring report');
  ensure(report.panel === assignment.panel && report.summary.length === 1 &&
    report.summary[0].providerId === assignment.providerId, 'Evaluation report assignment mismatch');
  ensure(raw.execution?.sourceHashes && raw.execution.adapter &&
    raw.source?.outputSha256 === expected.scorerHash &&
    raw.execution.sourceHashes[assignment.panel === 'ef' ? 'freshsearch-confirmed-clock.cjs' :
      'freshsearch.cjs'] === expected.scorerHash &&
    hash(raw.execution.sourceHashes) === expected.sourceHash &&
    hash(raw.execution?.adapter) === expected.adapterHash, 'Evaluation scorer or adapter changed');
  ensure(report.receiptId && !fingerprints.has(report.receiptId), 'Duplicate or missing evaluation receipt');
  const summary = report.summary[0];
  ensure(summary.assigned === (assignment.panel === 'fcd' ? 10 : 1),
    'Evaluation report has an unexpected assignment size');
  for (const row of report.cases) {
    const suffix = row.id.slice(assignment.unitId.length);
    ensure(row.providerId === assignment.providerId && (assignment.panel === 'ef'
      ? row.id === assignment.unitId && row.category === assignment.category
      : row.id === assignment.unitId || row.id.startsWith(`${assignment.unitId}/`) && /^\/(?:[1-9]|10)$/.test(suffix)),
    'Evaluation report case belongs to another assignment');
  }
  const provenance = hash({ policy: report.policy, provenance: report.provenance });
  const previous = fingerprints.get(assignment.panel);
  ensure(!previous || previous === provenance, 'Evaluation scoring policy or provenance changed');
  const total = totals.find(row => row.providerId === assignment.providerId && row.panel === assignment.panel);
  const configurations = [...new Set(raw.cases.map(row => row.effectiveConfigHash).filter(Boolean))];
  ensure(configurations.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) &&
    configurations.length <= 1 && (!configurations.length || !total.configHash ||
    total.configHash === configurations[0]), 'Evaluation provider configuration changed');
  ensure(assignment.panel !== 'ef' || raw.execution.judgeConfigFingerprint === expected.judgeHash,
    'Evaluation judge configuration changed');
  const scored = report.cases.filter(row => row.status === 'scored');
  fingerprints.set(assignment.panel, provenance);
  fingerprints.set(report.receiptId, true);
  total.configHash ??= configurations[0] ?? null;
  total.scored += summary.scored;
  total.held += summary.held * (assignment.panel === 'fcd' ? 10 : 1);
  total.excludedAgeTargets += summary.excludedAgeTargets ?? 0;
  total.eligibleTargets += summary.eligibleTargets ?? 0;
  total.policyFingerprint ??= report.policy.fingerprint;
  total.earnedPoints += summary.earnedPoints ?? 0;
  total.possiblePoints += summary.possiblePoints ?? 0;
  total.scoreSum += scored.reduce((sum, row) => sum + row.score, 0);
  if (assignment.panel === 'ef') {
    const cell = total.cells.find(row => row.category === assignment.category && row.tier === assignment.tier);
    ensure(cell, 'Evaluation EF cell is missing');
    cell.scored += scored.length;
    cell.scoreSum += scored.reduce((sum, row) => sum + row.score, 0);
  }
  if (assignment.panel === 'fcd') total.retrieval = summarizeRetrieval(report.cases, total.retrieval);
  for (const row of scored) {
    if (typeof row.searchMs === 'number' && Number.isFinite(row.searchMs) && row.searchMs >= 0) {
      total.searchMs += row.searchMs;
      total.timed++;
    }
  }
}

export function evaluationSummary(manifest, totals) {
  const panels = totals.map(total => {
    const cells = total.panel === 'ef' ? total.cells.map(cell => ({
      category: cell.category, tier: cell.tier, assigned: cell.assigned, scored: cell.scored,
      score: cell.scored ? cell.scoreSum / cell.scored : null,
    })) : null;
    const cellScores = cells?.flatMap(cell => cell.score === null ? [] : [cell.score]) ?? [];
    return {
      providerId: total.providerId, panel: total.panel, assigned: total.assigned,
      scored: total.scored, held: total.held, excludedAgeTargets: total.excludedAgeTargets,
      eligibleTargets: total.eligibleTargets,
      unknown: total.assigned - total.scored - total.held - total.excludedAgeTargets,
      coverage: total.scored / total.assigned,
      score: total.panel === 'fcd'
        ? total.possiblePoints ? 100 * total.earnedPoints / total.possiblePoints : null
        : cellScores.length ? cellScores.reduce((sum, value) => sum + value, 0) / cellScores.length : null,
      earnedPoints: total.panel === 'fcd' && total.possiblePoints ? total.earnedPoints : null,
      possiblePoints: total.panel === 'fcd' ? total.possiblePoints : null,
      policyFingerprint: total.policyFingerprint,
      ...(cells ? { cells } : {}),
      ...(total.panel === 'fcd' ? { retrieval: structuredClone(total.retrieval) } : {}),
      searchSeconds: total.scored && total.timed === total.scored ? total.searchMs / total.scored / 1000 : null,
    };
  });
  const combined = manifest.providers.map(({ providerId }) => {
    const ef = panels.find(row => row.providerId === providerId && row.panel === 'ef');
    const fcd = panels.find(row => row.providerId === providerId && row.panel === 'fcd');
    const assignments = manifest.assignments.filter(row => row.providerId === providerId);
    const fcdAssignments = assignments.filter(row => row.panel === 'fcd');
    const efAssignments = assignments.filter(row => row.panel === 'ef');
    const completeCells = ['weather', 'finance'].every(category =>
      ['head', 'torso', 'tail'].every(tier =>
        ef?.cells.some(cell => cell.category === category && cell.tier === tier &&
          cell.assigned > 0 && cell.scored === cell.assigned)));
    const referenceBound = fcdAssignments.every(assignment =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(assignment.referenceId ?? '') &&
      manifest.assignments.filter(row => row.panel === 'fcd' && row.feedId === assignment.feedId)
        .every(row => row.referenceId === assignment.referenceId));
    const complete = manifest.status === 'complete' && ef && fcd &&
      assignments.every(row => row.status === 'complete') &&
      efAssignments.length === ef.assigned && fcdAssignments.length * 10 === fcd.assigned &&
      referenceBound && completeCells && ef.scored === ef.assigned && ef.held === 0 && ef.unknown === 0 &&
      ef.score !== null && fcd.score !== null && fcd.eligibleTargets > 0 &&
      ef.policyFingerprint && fcd.policyFingerprint &&
      /^[a-f0-9]{64}$/u.test(manifest.cohortHash ?? '') &&
      manifest.combinedPolicy?.version === 'freshsearch-combined-v1' &&
      manifest.combinedPolicy.weights?.evidenceFreshness === 0.2 &&
      manifest.combinedPolicy.weights?.freshContentDiscovery === 0.8;
    return {
      providerId, evaluationId: manifest.id, cohortHash: manifest.cohortHash,
      policy: manifest.combinedPolicy, status: complete ? 'scored' : 'incomplete',
      score: complete ? 0.2 * ef.score + 0.8 * fcd.score : null,
      evidenceFreshness: ef?.score ?? null, freshContentDiscovery: fcd?.score ?? null,
      panelPolicyFingerprints: { evidenceFreshness: ef?.policyFingerprint ?? null,
        freshContentDiscovery: fcd?.policyFingerprint ?? null },
    };
  });
  const count = (rows, status) => rows.filter(row => status.includes(row.status)).length;
  const coverageOf = rows => ({ completed: count(rows, ['complete']), assigned: rows.length });
  const panelNames = [...new Set(manifest.assignments.map(row => row.panel))];
  const coverage = {
    byPanel: panelNames.map(panel => ({ panel, ...coverageOf(manifest.assignments.filter(row => row.panel === panel)) })),
    byProvider: manifest.providers.flatMap(({ providerId }) => panelNames.map(panel => ({ providerId, panel,
      ...coverageOf(manifest.assignments.filter(row => row.panel === panel && row.providerId === providerId)) }))),
  };
  const failures = manifest.assignments.flatMap(row => row.failure ? [{ status: row.status, ...row.failure }] : []);
  return {
    version: 'freshsearch-evaluation-summary-v1', evaluationId: manifest.id, status: manifest.status,
    assigned: manifest.assignments.length,
    completed: count(manifest.assignments, ['complete']),
    failed: count(manifest.assignments, ['failed', 'interrupted']),
    skipped: count(manifest.assignments, ['skipped']),
    pending: count(manifest.assignments, ['pending', 'running']),
    coverage, failures,
    panels, combined,
  };
}

export function renderEvaluation(manifest, totals) {
  const summary = evaluationSummary(manifest, totals);
  const providers = manifest.providers.map(provider => ({
    providerId: provider.providerId,
    fcd: summary.panels.find(row => row.providerId === provider.providerId && row.panel === 'fcd'),
    ef: summary.panels.find(row => row.providerId === provider.providerId && row.panel === 'ef'),
    combined: summary.combined.find(row => row.providerId === provider.providerId),
  }));
  return renderViewer({
    version: 'freshsearch-evaluation-viewer-v1',
    evaluation: { ...summary, providers },
    runs: summary.panels.map((panel, index) => ({
      id: `panel-${index + 1}`, status: 'complete', groupId: 'evaluation',
      report: { panel: panel.panel, kind: 'live-capture',
        provenance: { outputSha256: manifest.scorerHash }, summary: [panel] },
    })),
  });
}
