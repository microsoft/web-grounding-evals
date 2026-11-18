// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createHmac, randomBytes } from 'node:crypto';
import { ensure } from './trace.mjs';
import { isNetworkError, ProviderRequestError } from './providers/shared.mjs';

export const sharedFCDReference = Symbol('in-memory FCD reference');
const safeError = Symbol('sanitized live failure');
export const newReceiptKey = () => randomBytes(32);
export const receiptFingerprint = (key, value) =>
  createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');

export function requireAuthorizedUse(values) {
  ensure(values['confirm-authorized-use'] === true,
    'Live collection requires --confirm-authorized-use after reviewing provider, publisher and judge terms');
}

// Stable messages from ef.mjs / ef-clock.mjs judge transports: the judge answered, but not in the required shape.
const judgeSchemaMessages = new Set([
  'Judge Responses output failed, incomplete or malformed',
  'Judge Responses output contains an unexpected tool or output type',
  'Judge Responses refused, truncated or returned no usable structured output',
  'Judge returned invalid completion choices',
  'Judge returned an invalid completion',
  'Judge refused, truncated or returned no usable completion',
  'Invalid judge token usage',
  'Invalid judge token usage details',
]);
const notVerbatim = /^(?:Clock\/value quotation is not verbatim retained evidence|Local clock is not verbatim timestamp evidence)$/u;

const failureHints = {
  'provider-transport-failed': 'Search request failed in transit (network error, reset or timeout); check connectivity and provider status, then retry.',
  'judge-transport-failed': 'Judge request failed in transit (network error, reset or timeout); check the judge endpoint, network and timeoutMs, then retry.',
  'judge-output-truncated': 'Judge output exceeded the fixed per-call budget (Weather 1,024 / Finance 2,000 tokens); ' +
    'use the reference judge or a model that fits the budget.',
  'judge-schema-rejected': 'Judge output was refused, empty or failed JSON/schema validation; ' +
    'the judge must support strict JSON Schema structured output.',
  'judge-evidence-not-verbatim': 'Judge quoted text not present in returned evidence; ' +
    'use the reference judge or a model that quotes evidence verbatim.',
  'call-budget-exhausted': 'Raise --max-judge-calls or the search budget, or select fewer tasks.',
  'configuration-error': 'Fix the named credential or configuration before retrying.',
  'evaluation-integrity-error': 'Outputs failed an integrity check; rerun into a new --out directory.',
  interrupted: 'The run was cancelled; reconcile reserved calls before retrying.',
};

export function failureHint(reason) {
  if (failureHints[reason]) return failureHints[reason];
  if (/^judge-http-(?:401|403|404)$/u.test(reason)) return 'Judge rejected credentials or deployment; check the judge key, endpoint and model.';
  if (/^judge-http-\d{3}$/u.test(reason)) return 'Judge endpoint returned an HTTP error; check its status, quota or rate limits, then retry.';
  if (/^http-\d{3}$/u.test(reason)) return 'Search provider returned an HTTP error; check its key, quota or rate limits.';
  return 'Inspect the metadata-only checkpoint, reconcile reserved calls and retry.';
}

// Assignment-level failures that --continue-after-failure may record and move past. Credential (401/403/404),
// budget, configuration, integrity, interruption and unclassified failures always stop the run.
export const continuableFailure = reason => ['provider-transport-failed', 'judge-transport-failed',
  'judge-output-truncated', 'judge-schema-rejected', 'judge-evidence-not-verbatim'].includes(reason) ||
  /^judge-http-(?:408|409|429|5\d\d)$/u.test(reason);

function judgeOutputCategory(error, judgeError) {
  if (judgeError?.name === 'JudgeCompletionOutputError') {
    if (judgeError.finishReason === 'length') return 'judge-output-truncated';
    if (judgeError.repairCategory === 'literal' || notVerbatim.test(judgeError.reason ?? '')) {
      return 'judge-evidence-not-verbatim';
    }
    return 'judge-schema-rejected';
  }
  if (error?.name === 'FreshSearchIncompleteJudgmentError') {
    const attempts = Array.isArray(error.diagnostics?.attempts) ? error.diagnostics.attempts : [];
    return attempts.some(attempt => attempt?.outputErrorCategory === 'literal' ||
      notVerbatim.test(attempt?.outputError ?? '')) ? 'judge-evidence-not-verbatim' : 'judge-schema-rejected';
  }
  if (error?.name === 'FreshSearchJudgeDiagnosticsError' && (judgeError instanceof SyntaxError ||
    judgeError?.name === 'SearchResponseRetentionError' || judgeError?.name === 'ZodError')) {
    return 'judge-schema-rejected';
  }
  return judgeSchemaMessages.has(judgeError instanceof Error ? judgeError.message : '')
    ? 'judge-schema-rejected' : null;
}

export function safeLiveFailure(error, interrupted) {
  if (error?.[safeError] === true) {
    return { reason: error.reason, error };
  }
  const message = error instanceof Error ? error.message : '';
  const wrapped = error?.name === 'FreshSearchJudgeDiagnosticsError' || error?.name === 'FreshSearchIncompleteJudgmentError';
  const judgeError = wrapped ? error.cause : error;
  const outputCategory = judgeOutputCategory(error, judgeError);
  let reason = 'collection-or-validation-failed';
  let diagnostic = 'Live collection or scoring failed; inspect the metadata-only checkpoint and reconcile usage.';
  if (interrupted || ['AbortError', 'TimeoutError'].includes(error?.name)) {
    reason = 'interrupted';
    diagnostic = 'Live collection was interrupted or timed out; reconcile reserved calls before retrying.';
  } else if (/^(?:search|judge) call budget exhausted$/u.test(message)) {
    reason = 'call-budget-exhausted';
    diagnostic = message;
  } else if (/^Judge returned HTTP \d{3}$/u.test(message)) {
    reason = `judge-http-${message.slice(-3)}`;
    diagnostic = message;
  } else if (outputCategory === 'judge-output-truncated' ||
    message === 'Judge Responses output reached its output-token limit') {
    reason = 'judge-output-truncated';
    diagnostic = 'Judge reply reached its output-token limit; EF is incomplete. ' +
      'Check the configured judge model and deployment against the recommended gpt-5.6-sol; ' +
      'reconcile reserved calls before retrying. Do not treat partial results as a complete score.';
  } else if (outputCategory === 'judge-evidence-not-verbatim') {
    reason = outputCategory;
    diagnostic = 'Judge quotation or locator was not found verbatim in the returned evidence; EF is incomplete.';
  } else if (outputCategory === 'judge-schema-rejected') {
    reason = outputCategory;
    diagnostic = 'Judge output was refused, empty or failed JSON/schema validation; EF is incomplete.';
  } else if (wrapped && (['AbortError', 'TimeoutError'].includes(judgeError?.name) || isNetworkError(judgeError))) {
    reason = 'judge-transport-failed';
    diagnostic = 'Judge request failed in transit (network error, reset or timeout); EF is incomplete.';
  } else if (error instanceof ProviderRequestError && error.reason === 'provider-transport-failed') {
    reason = error.reason;
    diagnostic = 'Search provider request failed in transit (network error, reset or timeout).';
  } else if (error instanceof ProviderRequestError && /^http-\d{3}$/u.test(error.reason)) {
    reason = error.reason;
    diagnostic = `Search provider returned HTTP ${error.reason.slice(5)}`;
  } else if ([
    'Evaluation report has invalid judge reservation accounting',
    'Evaluation report assignment mismatch',
    'Evaluation scorer or adapter changed',
    'Evaluation provider configuration changed',
    'Duplicate or missing evaluation receipt',
    'Evaluation scoring policy or provenance changed',
    'Evaluation judge configuration changed',
    'Evaluation report case belongs to another assignment',
    'FCD report lacks its bound reference',
    'FCD providers used different reference cohorts',
  ].includes(message)) {
    reason = 'evaluation-integrity-error';
    diagnostic = message;
  } else if (/^Set [A-Z][A-Z0-9_]{0,100}$/u.test(message) || [
    'Live mode requires --provider module.mjs and --max-calls N',
    'EF requires --judge-config FILE',
    'EF requires --max-judge-calls (integer from 1 to 2000)',
    'Confirmed-clock EF requires a Chat Completions judge transport',
  ].includes(message)) {
    reason = 'configuration-error';
    diagnostic = message;
  }
  const safe = new Error(diagnostic, { cause: error });
  safe.name = 'LiveRunError';
  safe.reason = reason;
  safe[safeError] = true;
  return { reason, error: safe };
}

const contextCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Structured, sanitized failure record: only stable identifiers, a category and call counts.
export function failureRecord(failure, { panel, category, unitId, feedId, providerId, calls } = {}) {
  const record = { reason: failure.reason, message: failure.message, hint: failureHint(failure.reason) };
  for (const [field, value] of Object.entries({ panel, category, unitId, feedId, providerId })) {
    if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) record[field] = value;
  }
  if (calls) record.calls = Object.fromEntries(['search', 'searchLimit', 'judge', 'judgeLimit']
    .map(field => [field, contextCount(calls[field])]));
  return record;
}

export function describeFailure(record) {
  const subject = [record.panel?.toUpperCase(), record.category, record.providerId, record.feedId ?? record.unitId]
    .filter(Boolean).join(' · ');
  const calls = record.calls ? ` (search calls ${record.calls.search ?? '?'}/${record.calls.searchLimit ?? '?'}` +
    (record.panel === 'ef' ? `, judge calls ${record.calls.judge ?? '?'}/${record.calls.judgeLimit ?? '?'}` : '') + ')' : '';
  return `${record.reason}${subject ? ` at ${subject}` : ''}${calls}: ${record.message} Hint: ${record.hint}`;
}

// Re-wraps a sanitized failure with an actionable message built only from describeFailure().
export function contextualFailure(failure, record) {
  const safe = new Error(describeFailure(record), { cause: failure.cause ?? failure });
  safe.name = 'LiveRunError';
  safe.reason = failure.reason;
  safe[safeError] = true;
  return safe;
}

export function requireSafeIdentifier(value, label) {
  ensure(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value),
    `${label} must be a short identifier without spaces or URLs`);
  return value;
}

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : null;
const uuid = value => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function reservationReceipt(reservation) {
  ensure(['search', 'judge'].includes(reservation.stage) &&
    ['reserved', 'settled', 'unknown'].includes(reservation.status) &&
    count(reservation.ordinal) !== null, 'Invalid reservation in metadata-only checkpoint');
  return {
    stage: reservation.stage,
    ordinal: reservation.ordinal,
    status: reservation.status,
    traceId: uuid(reservation.traceId),
    reservationId: uuid(reservation.reservationId),
  };
}

function executionReceipt(execution, key) {
  if (!execution) return undefined;
  const sourceHashes = {};
  for (const name of ['run.mjs', 'trace.mjs', 'retention.mjs', 'runtime.mjs', 'ef.mjs', 'ef-clock.mjs',
    'providers/normalization.cjs',
    'evaluate.mjs', 'evaluation-report.mjs', 'report.mjs', 'freshsearch.cjs',
    'freshsearch-confirmed-clock.cjs']) {
    if (digest(execution.sourceHashes?.[name])) sourceHashes[name] = execution.sourceHashes[name];
  }
  const adapter = execution.adapter && {
    version: 'freshsearch-adapter-source-v1',
    entrySha256: digest(execution.adapter.entrySha256),
    sharedSha256: digest(execution.adapter.sharedSha256),
    dependencyIdentity: execution.adapter.dependencyIdentity === 'builtin-node-fetch-no-runtime-dependencies'
      ? 'builtin-node-fetch-no-runtime-dependencies' : 'custom-dependencies-unknown',
  };
  const reservations = Array.isArray(execution.reservations)
    ? execution.reservations.map(reservationReceipt) : [];
  return {
    version: 'freshsearch-execution-receipt-v1',
    sourceHashes,
    ...(execution.runtime ? { runtime: {
      node: /^v\d+\.\d+\.\d+$/u.test(execution.runtime.node) ? execution.runtime.node : null,
      icu: /^[\d.]+$/u.test(execution.runtime.icu) ? execution.runtime.icu : null,
      timeZoneData: /^\d{4}[a-z]$/u.test(execution.runtime.timeZoneData)
        ? execution.runtime.timeZoneData : null,
    } } : {}),
    adapter: adapter || null,
    budgets: {
      search: count(execution.budgets?.search),
      judge: count(execution.budgets?.judge),
      externalReference: count(execution.budgets?.externalReference),
    },
    reserved: {
      search: count(execution.reserved?.search),
      judge: count(execution.reserved?.judge),
    },
    reservations,
    pacing: { searchDelayMs: count(execution.pacing?.searchDelayMs) },
    judgeConfigFingerprint: execution.judgeConfigHash
      ? receiptFingerprint(key, execution.judgeConfigHash) : null,
    fcdReferenceId: uuid(execution.fcdReferenceId),
  };
}

export function metadataCheckpoint(input, receiptId, key, status = 'running') {
  ensure(['live-capture', 'retained-capture'].includes(input.kind) &&
    ['ef', 'fcd'].includes(input.panel) && uuid(receiptId) &&
    ['running', 'complete'].includes(status), 'Invalid metadata-only checkpoint');
  return {
    version: 'freshsearch-metadata-checkpoint-v1',
    kind: input.kind,
    panel: input.panel,
    receiptId,
    status,
    replayable: false,
    providerCalls: count(input.providerCalls),
    assignmentCount: Array.isArray(input.assignments) ? input.assignments.length :
      Array.isArray(input.episodes) ? input.episodes.length : null,
    pendingTraceId: uuid(input.pendingTask?.traceId),
    execution: executionReceipt(input.execution, key),
  };
}

function caseReceipt(row, panel, key) {
  const identifier = panel === 'fcd' ? row.id.replace(/\/(?:[1-9]|10)$/u, '') : row.id;
  requireSafeIdentifier(identifier, 'Case ID');
  requireSafeIdentifier(row.providerId, 'Provider ID');
  ensure(['scored', 'held', 'provider-error', 'capture-unknown', 'access-held', 'age-excluded']
    .includes(row.status), 'Invalid metadata-only case status');
  const receipt = {
    id: row.id,
    providerId: row.providerId,
    status: row.status,
    score: row.score,
    reason: row.status === 'scored' ? panel === 'fcd' && row.score === 100 ? 'hit' :
      panel === 'fcd' ? 'miss' : 'scored' : row.status,
  };
  if (['weather', 'finance', 'news'].includes(row.category)) receipt.category = row.category;
  for (const field of ['ageMinutes', 'points', 'earnedPoints', 'searchMs', 'judgeMs',
    'referenceMs', 'totalMs']) {
    if (row[field] !== undefined) receipt[field] = finite(row[field]);
  }
  if (digest(row.effectiveConfigHash)) {
    receipt.effectiveConfigHash = receiptFingerprint(key, row.effectiveConfigHash);
  }
  return receipt;
}

export function metadataReport(report, receiptId, key) {
  ensure(['live-capture', 'retained-capture'].includes(report.kind) && uuid(receiptId),
    'Invalid metadata-only report');
  for (const summary of report.summary) requireSafeIdentifier(summary.providerId, 'Provider ID');
  if (report.panel === 'ef') {
    requireSafeIdentifier(report.policy.policyId, 'Policy ID');
    requireSafeIdentifier(report.policy.policyVersion, 'Policy version');
  }
  return {
    version: report.version,
    panel: report.panel,
    kind: report.kind,
    receiptId,
    retention: 'metadata-only-not-replayable',
    interpretation: report.interpretation,
    source: report.source,
    policy: report.policy,
    summary: report.summary,
    cases: report.cases.map(row => caseReceipt(row, report.panel, key)),
    ...(report.execution ? { execution: executionReceipt(report.execution, key) } : {}),
    ...(report.timingPolicy ? { timingPolicy: report.timingPolicy } : {}),
  };
}
