// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';
import portable from './freshsearch-confirmed-clock.cjs';
import { judgeRequest, parseJudgeConfiguration, responsesContent } from './ef.mjs';
import { caseTrace, ensure, hash, retainDiagnostics } from './trace.mjs';
import { assertRuntimeSupport } from './runtime.mjs';

const captureVersion = 'freshsearch-confirmed-clock-capture-v1';
const retrievalProtocolVersion = 'freshsearch-portable-full-response-v1';

export function currentEFTask(raw) {
  assertRuntimeSupport();
  const parsed = portable.parseFreshSearchTaskContract(raw);
  ensure(parsed.panel === 'freshness' && ['weather', 'finance'].includes(parsed.category),
    'The current full-response profile supports only Weather and Finance freshness tasks');
  ensure(!parsed.answerBearingEvidenceSetVersion && !parsed.evidenceMatcherVersion &&
    !parsed.answerProtocolVersion && !parsed.experimental && !parsed.internationalFinance &&
    !parsed.sportsShadow && !parsed.rssIntake && !parsed.financeWindowOverride,
  'The current full-response profile does not support experimental or answer-dependent tasks');
  const profile = {
    timestampExtractorVersion: 'confirmed-clock',
    clockProofVersion: 'freshsearch-ef-clock-proof-v1',
    returnedEvidenceSetVersion: portable.FRESH_SEARCH_FULL_RESPONSE_VERSION,
    returnedEvidenceProfile: { version: portable.FRESH_SEARCH_PORTABLE_SCORING_PROFILE,
      maxTokens: parsed.category === 'weather' ? 1024 : 2000 },
    ...(parsed.category === 'weather'
      ? { clockValidation: portable.FRESH_SEARCH_SUPPORTED_WEATHER_CLOCK_VALIDATION } : {}),
  };
  for (const field of ['timestampExtractorVersion', 'clockProofVersion', 'returnedEvidenceSetVersion',
    'returnedEvidenceProfile', 'clockValidation']) {
    if (parsed[field] !== undefined) ensure(profile[field] !== undefined &&
      hash(parsed[field]) === hash(profile[field]),
      `EF task ${field} conflicts with the current full-response profile`);
  }
  const contract = portable.parseFreshSearchTaskContract({
    ...parsed, retrievalBudget: parsed.retrievalBudget ?? 10, ...profile,
  });
  portable.validateFreshSearchLabelerInput({ contract, requestTime: new Date().toISOString(), results: [] });
  return contract;
}

function requestReceipt(messages, options) {
  ensure(options && typeof options.model === 'string' && Array.isArray(messages) &&
    Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0 &&
    options.reasoningEffort === 'low' && options.responseFormat,
  'Invalid confirmed-clock completion request');
  return { messages, model: options.model, maxTokens: options.maxTokens,
    reasoningEffort: options.reasoningEffort, responseFormat: options.responseFormat,
    ...(options.seed === undefined ? {} : { seed: options.seed }) };
}

function completionUsage(payload, responses) {
  const usage = payload.usage;
  ensure(usage === undefined || usage && typeof usage === 'object' && !Array.isArray(usage),
    'Invalid judge token usage');
  const source = !responses || usage === undefined ? usage : {
    prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens, prompt_tokens_details: usage.input_tokens_details,
    completion_tokens_details: usage.output_tokens_details,
  };
  if (source === undefined) return { reported: false, value: {
    promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, totalTokens: 0,
  } };
  ensure(source && ['prompt_tokens', 'completion_tokens', 'total_tokens']
    .every(key => Number.isSafeInteger(source[key]) && source[key] >= 0),
  'Invalid judge token usage');
  const reasoningTokens = source.completion_tokens_details?.reasoning_tokens ?? 0;
  const cachedTokens = source.prompt_tokens_details?.cached_tokens ?? 0;
  ensure([reasoningTokens, cachedTokens].every(value => Number.isSafeInteger(value) && value >= 0),
    'Invalid judge token usage details');
  return { reported: true, value: { promptTokens: source.prompt_tokens,
    completionTokens: source.completion_tokens, reasoningTokens, cachedTokens,
    totalTokens: source.total_tokens } };
}

function completionBody(config, receipt) {
  return judgeRequest({ body: { model: receipt.model, messages: receipt.messages, store: false,
    max_completion_tokens: receipt.maxTokens, reasoning_effort: receipt.reasoningEffort,
    response_format: receipt.responseFormat,
    ...(receipt.seed === undefined ? {} : { seed: receipt.seed }) } }, config);
}

async function dispatchCompletion(config, receipt, { signal, fetchImpl, environment }) {
  const key = environment[config.apiKeyEnv];
  ensure(typeof key === 'string' && key.trim(), `Set ${config.apiKeyEnv}`);
  const azure = config.transport === 'azure-openai';
  const responses = config.transport === 'azure-openai-responses';
  const endpoint = new URL(azure
    ? `${config.endpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(config.model)}/chat/completions`
    : config.endpoint);
  if (azure) endpoint.searchParams.set('api-version', config.apiVersion);
  const body = completionBody(config, receipt);
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
  const response = await fetchImpl(endpoint.href, { method: 'POST', redirect: 'error', cache: 'no-store',
    signal: requestSignal,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      ...(azure || responses ? { 'api-key': key } : { Authorization: `Bearer ${key}` }) },
    body: JSON.stringify(body) });
  ensure(response.ok, `Judge returned HTTP ${response.status}`);
  const payload = await portable.readRetainedSearchResponse(response, 'judge', {
    query: 'confirmed-clock', maxResults: 1, maxLength: 7000,
  });
  requestSignal.throwIfAborted();
  if (responses) {
    const content = responsesContent(payload);
    const usage = completionUsage(payload, true);
    return { completion: {
      message: { role: 'assistant', content, refusal: null },
      finishReason: 'stop', usage: usage.value,
    }, usageReported: usage.reported };
  }
  ensure(payload && typeof payload === 'object' && !Array.isArray(payload) &&
    Array.isArray(payload.choices) && payload.choices.length === 1,
  'Judge returned invalid completion choices');
  const choice = payload.choices[0];
  ensure(choice && choice.message && (choice.message.content === null ||
    typeof choice.message.content === 'string' && choice.message.content.length <= 1_000_000) &&
    (choice.message.refusal == null || typeof choice.message.refusal === 'string') &&
    (choice.finish_reason == null || ['stop', 'length', 'content_filter'].includes(choice.finish_reason)),
  'Judge returned an invalid completion');
  const usage = completionUsage(payload);
  return { completion: {
    message: { role: 'assistant', content: choice.message.content, refusal: choice.message.refusal ?? null },
    ...(choice.finish_reason == null ? {} : { finishReason: choice.finish_reason }),
    usage: usage.value,
  }, usageReported: usage.reported };
}

function ledgerFor(input, id) {
  const matches = input.execution.reservations.filter(row => row.reservationId === id);
  ensure(matches.length === 1, 'Missing or duplicate paid-call reservation');
  return matches[0];
}

function liveJudgeContext({ config, input, trace, reserve, save, signal, fetchImpl, environment }) {
  let active;
  return {
    model: config.model,
    async reserve(plan) {
      ensure(!active, 'Overlapping judge attempts are not supported');
      const attempt = { reservationId: randomUUID(), traceId: trace.id, stage: 'judge',
        status: 'planned', planHash: hash(plan), requestHash: hash(plan) };
      trace.judge.attempts.push(attempt);
      await reserve('judge', attempt);
      active = attempt;
      return attempt;
    },
    async complete(messages, options) {
      ensure(active && active.status === 'reserved', 'Judge completion lacks a reserved attempt');
      const receipt = requestReceipt(messages, options);
      ensure(receipt.model === config.model &&
        active.planHash === hash({ model: receipt.model, maxTokens: receipt.maxTokens,
          prompt: { messages: receipt.messages, response_format: receipt.responseFormat } }),
      'Judge completion differs from its reserved prompt');
      active.request = receipt;
      active.completionRequestHash = hash(receipt);
      active.wireRequestHash = hash(completionBody(config, receipt));
      active.startedAt = new Date().toISOString();
      await save();
      const output = await dispatchCompletion(config, receipt, { signal, fetchImpl, environment });
      active.response = output.completion;
      active.responseHash = hash(output.completion);
      active.usageReported = output.usageReported;
      active.completedAt = new Date().toISOString();
      await save();
      return output.completion;
    },
    async settle(attempt, usage) {
      ensure(attempt === active && attempt.response && hash(attempt.response.usage) === hash(usage),
        'Judge settlement differs from its completion');
      attempt.status = 'settled';
      ledgerFor(input, attempt.reservationId).status = 'settled';
      await save();
      active = undefined;
    },
    async retain(attempt, error) {
      ensure(attempt === active, 'Unknown judge attempt does not match its reservation');
      attempt.status = 'unknown';
      attempt.failure = error instanceof Error ? error.name : 'UnknownError';
      ledgerFor(input, attempt.reservationId).status = 'unknown';
      await save();
      active = undefined;
    },
  };
}

function replayJudgeContext(trace, input) {
  let cursor = 0;
  let active;
  const attempts = trace.judge.attempts;
  const seen = new Set();
  return {
    model: trace.judge.config.model,
    async reserve(plan) {
      ensure(!active, 'Overlapping retained judge attempts');
      const attempt = attempts[cursor];
      ensure(attempt && attempt.status === 'settled' && typeof attempt.reservationId === 'string' &&
        !seen.has(attempt.reservationId) && attempt.planHash === hash(plan),
      'Retained judge reservation differs from the original prompt');
      const ledger = ledgerFor(input, attempt.reservationId);
      ensure(ledger.stage === 'judge' && ledger.traceId === trace.id && ledger.status === 'settled' &&
        ledger.requestHash === attempt.planHash, 'Retained judge ledger binding mismatch');
      seen.add(attempt.reservationId);
      active = attempt;
      return attempt;
    },
    async complete(messages, options) {
      const receipt = requestReceipt(messages, options);
      ensure(active && active.completionRequestHash === hash(receipt) &&
        hash(active.request) === hash(receipt) && active.responseHash === hash(active.response) &&
        active.wireRequestHash === hash(completionBody(trace.judge.config, receipt)) &&
        typeof active.usageReported === 'boolean', 'Retained judge completion binding mismatch');
      cursor++;
      return active.response;
    },
    async settle(attempt, usage) {
      ensure(active === attempt && hash(attempt.response.usage) === hash(usage),
        'Retained judge usage binding mismatch');
      active = undefined;
    },
    async retain() { throw new Error('Retained judge attempts cannot dispatch or recover'); },
    assertConsumed() {
      ensure(!active && cursor === attempts.length, 'Retained judge attempts are incomplete or unused');
    },
  };
}

function preparedCapture(contract, trace) {
  ensure(trace.response && Array.isArray(trace.sources) && trace.response.provider === trace.providerId,
    'Full-response trace lacks its original provider response and sources');
  return portable.prepareFullResponseEvidenceCapture(contract, {
    runId: trace.id, callId: trace.id, providerId: trace.providerId,
    requestTime: trace.requestTime, retrievalProtocolVersion,
    response: trace.response, sources: trace.sources,
  });
}

function judgedRecord(prepared, judgment) {
  return { ...prepared.record, evidence: judgment.labels.map(label => label.record),
    ...(prepared.results.length ? {
      judgment: portable.buildFreshSearchJudgmentProvenance(prepared, judgment),
    } : {}) };
}

export async function evaluateConfirmedClockEF({ contract: raw, adapter, identity, config, reserve, save, input,
  signal, fetchImpl = fetch, environment = process.env }) {
  const contract = currentEFTask(raw);
  const trace = { id: randomUUID(), queryId: contract.queryId, providerId: adapter.providerId,
    contract, taskHash: hash(contract), adapter: identity, status: 'capture-unknown',
    query: null, queryProvenance: 'not-dispatched', referenceMs: null, judgeMs: null };
  input.traces.push(trace);
  input.pendingTask = { queryId: contract.queryId, providerId: adapter.providerId, traceId: trace.id };
  await save();
  const started = performance.now();
  try {
    signal.throwIfAborted();
    ensure(typeof adapter.searchFullResponse === 'function',
      'Provider does not implement full-response evidence capture');
    if (contract.clockValidation) portable.assertFreshSearchClockRuntime(contract.clockValidation.runtime);
    const admissionTime = new Date().toISOString();
    const wait = portable.getFreshSearchCollectionWait(contract, Date.parse(admissionTime));
    if (wait) {
      trace.requestTime = admissionTime;
      trace.status = 'held';
      trace.reason = `outside_run_window:${wait.resumeAt}`;
      return portable.buildFreshSearchFreshnessRecord({
        contract, providerId: adapter.providerId, requestTime: admissionTime, runId: trace.id, sources: [],
      });
    }
    trace.searchReservation = { reservationId: randomUUID(), traceId: trace.id, stage: 'search',
      status: 'planned' };
    await reserve('search', trace.searchReservation);
    signal.throwIfAborted();
    trace.requestTime = new Date().toISOString();
    ensure(!portable.getFreshSearchCollectionWait(contract, Date.parse(trace.requestTime)),
      'EF collection window closed before the reserved search could start');
    trace.query = contract.queryText;
    trace.queryProvenance = 'reserved-not-confirmed';
    trace.request = { maxResults: contract.retrievalBudget, maxLength: 7000 };
    await save();
    const searchStarted = performance.now();
    let responses = [];
    try {
      const results = await portable.captureSearchResponses(
        () => adapter.searchFullResponse({ query: contract.queryText, signal,
          maxResults: contract.retrievalBudget, maxLength: 7000, onDiagnostics: async value => {
            ensure(trace.effectiveConfig === undefined, 'Provider emitted duplicate diagnostics');
            trace.effectiveConfig = retainDiagnostics(value, adapter.providerId);
            trace.effectiveConfigHash = hash(trace.effectiveConfig);
            await save();
          } }),
        captured => { responses = captured; },
      );
      ensure(responses.length === 1, 'Full-response provider must retain exactly one search response');
      trace.response = responses[0];
      trace.sources = results.map(result => ({ ...result, id: result.label }));
      trace.queryProvenance = 'exact-submitted';
      trace.searchReservation.status = 'settled';
      ledgerFor(input, trace.searchReservation.reservationId).status = 'settled';
    } finally {
      if (!trace.response && responses.length === 1) trace.response = responses[0];
      if (trace.searchReservation.status === 'reserved') {
        trace.searchReservation.status = 'unknown';
        ledgerFor(input, trace.searchReservation.reservationId).status = 'unknown';
      }
      trace.responseTime = new Date().toISOString();
      trace.searchMs = performance.now() - searchStarted;
      await save();
    }
    const prepared = preparedCapture(contract, trace);
    trace.reference = { version: 'freshsearch-full-response-reference-v1',
      kind: 'retained-provider-evidence-task-request-clock', independentlyVerifiedTruth: false,
      taskHash: trace.taskHash, requestTime: trace.requestTime, evidenceHash: hash(prepared.results),
      receivedCount: prepared.results.length };
    trace.judge = { config, configHash: hash(config), attempts: [] };
    const judgeStarted = performance.now();
    let judgment;
    try {
      judgment = await portable.labelFreshSearchConfirmedClocks({
        contract, requestTime: trace.requestTime, results: prepared.results,
        policy: portable.DEFAULT_FRESH_SEARCH_POLICY, signal,
      }, liveJudgeContext({ config, input, trace, reserve, save, signal, fetchImpl, environment }));
    } finally {
      trace.judgeMs = prepared.results.length ? performance.now() - judgeStarted : null;
    }
    const record = judgedRecord(prepared, judgment);
    portable.parseFreshSearchRunRecord(record);
    portable.validateFreshSearchRecordForTask(record, contract);
    trace.status = 'evaluated';
    return record;
  } finally {
    trace.totalMs = performance.now() - started;
    await save();
  }
}

export async function validateConfirmedClockEFTrace(trace, record, input, policy) {
  const contract = currentEFTask(trace.contract);
  ensure(trace.id === record.runId && trace.providerId === record.providerId &&
    trace.queryId === record.queryId && trace.taskHash === hash(contract) &&
    trace.requestTime === record.requestTime, 'EF full-response trace identity mismatch');
  const assignments = input.assignments.filter(row =>
    row.queryId === trace.queryId && row.providerId === trace.providerId);
  ensure(assignments.length === 1 && assignments[0].taskHash === trace.taskHash &&
    hash(assignments[0].contract) === trace.taskHash, 'EF full-response assignment mismatch');
  if (trace.status === 'held') {
    const wait = portable.getFreshSearchCollectionWait(contract, Date.parse(trace.requestTime));
    const expected = portable.buildFreshSearchFreshnessRecord({
      contract, providerId: record.providerId, requestTime: record.requestTime, runId: record.runId, sources: [],
    });
    ensure(wait && trace.reason === `outside_run_window:${wait.resumeAt}` &&
      trace.queryProvenance === 'not-dispatched' && trace.query === null &&
      !input.execution.reservations.some(row => row.traceId === trace.id) &&
      hash(record) === hash(expected), 'Invalid undispatched full-response hold');
    return;
  }
  ensure(trace.status === 'evaluated' && trace.queryProvenance === 'exact-submitted' &&
    trace.query === contract.queryText, 'Invalid full-response query binding');
  const search = ledgerFor(input, trace.searchReservation?.reservationId);
  ensure(search.stage === 'search' && search.traceId === trace.id && search.status === 'settled' &&
    trace.searchReservation.status === 'settled', 'Full-response search reservation mismatch');
  if (trace.effectiveConfig !== undefined) ensure(
    hash(retainDiagnostics(trace.effectiveConfig, record.providerId)) === trace.effectiveConfigHash,
    'Full-response provider configuration mismatch');
  const config = parseJudgeConfiguration(trace.judge.config);
  ensure(hash(config) === trace.judge.configHash &&
    Array.isArray(trace.judge.attempts), 'Full-response judge configuration mismatch');
  const prepared = preparedCapture(contract, trace);
  ensure(trace.reference?.taskHash === trace.taskHash &&
    trace.reference.requestTime === trace.requestTime &&
    trace.reference.independentlyVerifiedTruth === false &&
    trace.reference.receivedCount === prepared.results.length &&
    trace.reference.evidenceHash === hash(prepared.results), 'Full-response reference mismatch');
  const context = replayJudgeContext(trace, input);
  const judgment = await portable.labelFreshSearchConfirmedClocks({
    contract, requestTime: trace.requestTime, results: prepared.results, policy,
  }, context);
  context.assertConsumed();
  ensure(hash(judgedRecord(prepared, judgment)) === hash(record),
    'EF record differs from replayed full-response judgments');
  portable.validateFreshSearchRecordForTask(record, contract);
}

export async function scoreConfirmedClockEFCapture(input) {
  ensure(input?.version === captureVersion && input.panel === 'ef' &&
    ['synthetic-fixture', 'retained-capture', 'live-capture'].includes(input.kind) &&
    Array.isArray(input.records) && Array.isArray(input.traces) &&
    Array.isArray(input.assignments) && Array.isArray(input.execution?.reservations),
  'Invalid full-response EF capture');
  const policy = portable.parseFreshSearchScoreRequest({ records: [], policy: input.policy }).policy ??
    portable.DEFAULT_FRESH_SEARCH_POLICY;
  const rows = [];
  const seen = new Set();
  const assignments = new Set();
  for (const assignment of input.assignments) {
    const key = `${assignment.providerId}/${assignment.queryId}`;
    ensure(!assignments.has(key) && assignment.contract?.queryId === assignment.queryId &&
      assignment.taskHash === hash(assignment.contract), 'Duplicate or invalid full-response assignment');
    assignments.add(key);
  }
  ensure(new Set(input.traces.map(trace => trace.id)).size === input.traces.length,
    'Duplicate full-response trace identity');
  for (const record of input.records) {
    const key = `${record.providerId}/${record.queryId}`;
    ensure(!seen.has(key), 'Duplicate full-response EF record');
    seen.add(key);
    const trace = input.traces.find(candidate => candidate.id === record.runId);
    ensure(trace, 'Full-response EF record has no bound trace');
    await validateConfirmedClockEFTrace(trace, record, input, policy);
    const result = portable.scoreFreshnessRun(record, policy);
    rows.push({ id: record.queryId, providerId: record.providerId, category: record.category,
      status: result.score === null ? 'held' : 'scored', score: result.score,
      reason: trace.reason ?? (result.score === null ? record.exclusionReason ?? 'not_scored' :
        result.evidenceScores.map(item => item.reason).join(';')),
      details: result, recordHash: hash(record), ...caseTrace(trace) });
  }
  for (const assignment of input.assignments) {
    if (rows.some(row => row.id === assignment.queryId && row.providerId === assignment.providerId)) continue;
    const trace = input.traces.find(row => row.queryId === assignment.queryId &&
      row.providerId === assignment.providerId);
    rows.push({ id: assignment.queryId, providerId: assignment.providerId,
      category: assignment.contract.category, status: 'capture-unknown', score: null,
      reason: trace ? 'reserved-or-interrupted-dispatch' : 'not-dispatched', ...caseTrace(trace ?? {}) });
  }
  return { rows, policy, observations: [] };
}

export { captureVersion as CONFIRMED_CLOCK_EF_CAPTURE_VERSION };
