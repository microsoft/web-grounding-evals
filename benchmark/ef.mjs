// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import freshsearch from './freshsearch.cjs';
import { captureSearch, ensure, hash, httpsEndpoint, retainDiagnostics, retainResults } from './trace.mjs';

const correctiveHandlingVersion = 'freshsearch-original-corrective-v1';

export function parseJudgeConfiguration(value) {
  ensure(value?.version === 'freshsearch-judge-config-v1', 'Judge configuration version is required');
  ensure(value.transport === undefined || ['openai', 'azure-openai', 'azure-openai-responses'].includes(value.transport),
    'Judge transport must be openai, azure-openai or azure-openai-responses');
  const azure = value.transport === 'azure-openai';
  const responses = value.transport === 'azure-openai-responses';
  const endpoint = httpsEndpoint(value.endpoint);
  ensure(typeof value.model === 'string' && value.model.trim() === value.model &&
    value.model.length > 0 && value.model.length <= 200, 'Explicit pinned judge model is required');
  ensure(typeof value.apiKeyEnv === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/u.test(value.apiKeyEnv),
    'Judge apiKeyEnv must name an environment variable, not contain a key');
  ensure(Number.isInteger(value.timeoutMs) && value.timeoutMs > 0 && value.timeoutMs <= 60000,
    'Judge timeoutMs must be an explicit integer from 1 to 60000');
  if (azure || responses) {
    ensure(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value.model),
      'Azure judge model must be an explicit deployment name');
  }
  if (azure) {
    ensure(typeof value.apiVersion === 'string' && /^\d{4}-\d{2}-\d{2}(?:-preview)?$/u.test(value.apiVersion),
      'Azure judge apiVersion must be explicit, for example 2024-12-01-preview');
    ensure(!/\/openai(?:\/|$)/u.test(new URL(endpoint).pathname),
      'Azure judge endpoint must be the resource base URL, not an OpenAI API URL');
  } else {
    ensure(value.apiVersion === undefined, 'Judge apiVersion requires azure-openai Chat Completions transport; Responses uses v1');
    if (responses) ensure(new URL(endpoint).pathname === '/openai/v1/responses',
      'Azure Responses judge endpoint must be the full /openai/v1/responses URL');
  }
  return { version: value.version, endpoint, model: value.model,
    apiKeyEnv: value.apiKeyEnv, timeoutMs: value.timeoutMs, physicalRetries: 0,
    ...(azure ? { transport: 'azure-openai', apiVersion: value.apiVersion } : {}),
    ...(responses ? { transport: 'azure-openai-responses' } : {}) };
}

export function judgeConfiguration(value, environment = process.env) {
  if (value?.transport === 'azure-openai' && value.endpoint === undefined) {
    ensure(typeof environment.AZURE_OPENAI_ENDPOINT === 'string' && environment.AZURE_OPENAI_ENDPOINT.trim(),
      'Set AZURE_OPENAI_ENDPOINT');
    value = { ...value, endpoint: environment.AZURE_OPENAI_ENDPOINT };
  }
  const config = parseJudgeConfiguration(value);
  ensure(!/(?:^|\.)invalid$/i.test(new URL(config.endpoint).hostname) &&
    !/replace_with_|your_/i.test(config.endpoint) && !/replace_with_|your_/i.test(config.model),
  'Replace the placeholder judge endpoint and model before a live run');
  ensure(typeof environment[config.apiKeyEnv] === 'string' && environment[config.apiKeyEnv].trim(),
    `Set ${config.apiKeyEnv}`);
  return config;
}

export function judgeRequest(plan, config) {
  if (config.transport !== 'azure-openai-responses') return plan.body;
  return {
    model: plan.body.model, input: plan.body.messages,
    text: { format: { type: 'json_schema', ...plan.body.response_format.json_schema } },
    max_output_tokens: plan.body.max_completion_tokens,
    ...(plan.body.temperature === undefined ? {} : { temperature: plan.body.temperature }),
    ...(plan.body.reasoning_effort === undefined ? {} : {
      reasoning: { effort: plan.body.reasoning_effort },
    }),
    store: false,
  };
}

export function responsesContent(payload) {
  ensure(!(payload?.status === 'incomplete' && payload.error == null &&
    payload.incomplete_details?.reason === 'max_output_tokens'),
  'Judge Responses output reached its output-token limit');
  ensure(payload.status === 'completed' && payload.error == null && payload.incomplete_details == null &&
    Array.isArray(payload.output) && payload.output.length > 0 && payload.output.length <= 100,
  'Judge Responses output failed, incomplete or malformed');
  ensure(payload.output.every(item => item && (item.type === 'reasoning' || item.type === 'message')),
    'Judge Responses output contains an unexpected tool or output type');
  const messages = payload.output.filter(item => item.type === 'message');
  ensure(messages.length === 1 && messages[0].role === 'assistant' && messages[0].status === 'completed' &&
    Array.isArray(messages[0].content) && messages[0].content.length === 1 &&
    messages[0].content[0]?.type === 'output_text' &&
    typeof messages[0].content[0].text === 'string' &&
    messages[0].content[0].text.length <= 1000000,
  'Judge Responses refused, truncated or returned no usable structured output');
  return messages[0].content[0].text;
}

export function efHoldReason(contract, at) {
  if (contract.timestampExtractorVersion === 'confirmed-clock' || contract.answerProtocolVersion ||
    contract.financeWindowOverride || contract.sportsShadow ||
    contract.answerBearingEvidenceSetVersion || contract.evidenceMatcherVersion ||
    contract.returnedEvidenceSetVersion ||
    contract.rssIntake || contract.internationalFinance || !['weather', 'finance', 'news'].includes(contract.category)) {
    return 'unsupported-standalone-task-mode';
  }
  if (!contract.queryText?.trim() || !contract.canonicalEntity?.id || !contract.canonicalEntity?.name ||
    !contract.informationType) return 'incomplete-task-entity-query-information-contract';
  if (contract.category === 'finance' &&
    (!contract.quote?.exchange || !contract.quote.currency || !contract.timezone ||
      contract.quote.session !== 'regular')) return 'finance-listing-clock-incomplete';
  if (contract.category === 'news' && !contract.geographicRelevanceRule) return 'news-scope-rule-missing';
  const wait = freshsearch.getFreshSearchCollectionWait(contract, Date.parse(at));
  if (wait) return `outside_run_window:${wait.resumeAt}`;
  return null;
}

function labelerResults(results, traceId) {
  return results.map((item, index) => {
    const updated = item.metadata?.timestamps.filter(t => t.kind === 'updated' && t.value !== null) ?? [];
    const estimated = item.metadata?.timestamps.filter(t => t.kind === 'estimated_publication' && t.value !== null) ?? [];
    const published = item.metadata?.timestamps.find(t => t.kind === 'published' && t.value);
    const crawled = item.metadata?.timestamps.find(t => t.kind === 'crawled' && t.value);
    const crawledAt = freshsearch.normalizeFreshSearchZonedTime(crawled?.value);
    return { id: `${traceId}/${index + 1}`, rank: index + 1,
      // The old two-field adapter interface has no title. A rank label supplies no source facts.
      title: item.metadata?.title?.trim() || `Returned evidence ${index + 1}`,
      ...(item.url ? { url: item.url } : {}), content: item.content,
      ...(published || crawled ? { datePublished: (published ?? crawled).value,
        datePublishedSource: published ? 'published' : 'crawled' } : {}),
      ...(crawledAt ? { crawledAt } : {}),
      ...(updated.length || estimated.length ? { providerTimestampHints: [
        ...updated.map(t => ({ kind: 'provider_last_updated', value: t.value })),
        ...estimated.map(t => ({ kind: 'provider_estimated_publication', value: t.value })),
      ] } : {}) };
  });
}

function heldRecord(base, contract, reason) {
  return { ...base, eligibilityStatus: 'not_scored',
    exclusionReason: reason.startsWith('outside_run_window') ? 'outside_run_window' : 'other',
    ...(contract.answerBearingEvidenceSetVersion ? { answerBearingEvidenceSetExclusion: {
      version: 'fresh-search-answer-bearing-evidence-set-exclusion-v1',
      selectorVersion: contract.answerBearingEvidenceSetVersion,
      ...(contract.evidenceMatcherVersion ? { evidenceMatcherVersion: contract.evidenceMatcherVersion } : {}),
      reason: 'no_bound_references',
    } } : {}) };
}

function inspectAttempt(attempt, input) {
  if (attempt.completionFailure !== undefined) {
    ensure(['incomplete', 'empty'].includes(attempt.completionFailure),
      'Unknown retained judge completion failure');
    return { labels: [], rejectedLabels: [], outputError: attempt.completionFailure === 'incomplete'
      ? 'Judge returned an incomplete completion' : 'Judge returned no JSON content' };
  }
  try {
    const inspected = freshsearch.inspectPlannedFreshSearchJudgment(attempt.response, input);
    return { ...inspected, outputError: inspected.rejectedLabels.length
      ? inspected.rejectedLabels.map(label => label.reason).join('; ') : null };
  } catch (error) {
    if (!(error instanceof freshsearch.FreshSearchEvidenceLabelerOutputError)) throw error;
    return { labels: [], rejectedLabels: [], outputError: error.message };
  }
}

function replayCorrectiveJudgments(chunks, config, attempts) {
  let cursor = 0;
  const labels = [];
  let correctiveRetryUsed = false;
  for (const chunk of chunks) {
    const ordered = [...chunk.results].sort((a, b) => a.rank - b.rank);
    const validated = new Map();
    let pending = ordered;
    let correction;
    for (let index = 0; index < 2; index++) {
      const attempt = attempts[cursor++];
      ensure(attempt, 'EF judgment chunks mismatch');
      const input = { ...chunk, results: pending };
      const plan = freshsearch.planFreshSearchJudgment(input, config.model, correction);
      const request = judgeRequest(plan, config);
      ensure(attempt.promptVersion === plan.promptVersion &&
        hash(attempt.evidenceIds) === hash(pending.map(result => result.id)) &&
        hash(attempt.request) === hash(request) && attempt.requestHash === hash(request) &&
        attempt.schemaHash === hash(plan.body.response_format) && attempt.promptHash === hash(plan.body.messages),
      'EF retained judgment request binding mismatch');
      const outcome = inspectAttempt(attempt, input);
      ensure(hash(attempt.labels) === hash(outcome.labels) &&
        hash(attempt.rejectedLabels) === hash(outcome.rejectedLabels) &&
        (outcome.outputError
          ? attempt.status === 'rejected' && attempt.outputError === outcome.outputError && index === 0
          : attempt.status === 'validated' && attempt.outputError === undefined),
      'EF retained corrective judgment outcome mismatch');
      outcome.labels.forEach(label => validated.set(label.evidenceId, label));
      if (!outcome.outputError) break;
      correctiveRetryUsed = true;
      pending = ordered.filter(result => !validated.has(result.id));
      correction = freshsearch.freshSearchJudgmentCorrection(outcome.outputError);
    }
    ensure(ordered.every(result => validated.has(result.id)), 'EF corrected judgment remains incomplete');
    labels.push(...ordered.map(result => validated.get(result.id)));
  }
  ensure(cursor === attempts.length, 'EF judgment chunks mismatch');
  return { labels, correctiveRetryUsed };
}

export function validateEFTrace(trace, record, capture) {
  ensure(trace.id === record.runId && trace.providerId === record.providerId &&
    trace.queryId === record.queryId && trace.requestTime === record.requestTime,
  'EF trace record identity mismatch');
  const contract = freshsearch.parseFreshSearchTaskContract(trace.contract);
  ensure(hash(contract) === trace.taskHash, 'EF task hash mismatch');
  if (trace.status === 'held' && trace.queryProvenance === 'not-dispatched' && trace.query === null &&
    contract.returnedEvidenceSetVersion) {
    // Undispatched holds have no capture lineage; their exact held record is checked below.
    freshsearch.parseFreshSearchRunRecord(record);
    ensure(Array.isArray(capture?.assignments), 'EF held task assignment binding mismatch');
    const assignments = capture.assignments.filter(assignment =>
      assignment.queryId === trace.queryId && assignment.providerId === trace.providerId);
    ensure(assignments.length === 1 && assignments[0].contract.queryId === trace.queryId &&
      assignments[0].taskHash === trace.taskHash &&
      hash(freshsearch.parseFreshSearchTaskContract(assignments[0].contract)) === trace.taskHash,
    'EF held task assignment binding mismatch');
    ensure(['searchReservation', 'request', 'results', 'reference', 'judge',
      'effectiveConfig', 'effectiveConfigHash', 'responseTime', 'searchMs']
      .every(field => trace[field] === undefined) &&
      trace.referenceMs === null && trace.judgeMs === null,
      'Undispatched returned-evidence hold has dispatch state');
    ensure(Array.isArray(capture.execution?.reservations) &&
      !capture.execution.reservations.some(reservation => reservation?.traceId === trace.id),
    'Undispatched returned-evidence hold has reservation ledger evidence');
  } else {
    freshsearch.validateFreshSearchRecordForTask(record, contract);
  }
  const base = freshsearch.buildFreshSearchFreshnessRecord({
    contract, providerId: record.providerId, requestTime: record.requestTime, runId: record.runId, sources: [],
  });
  if (trace.status === 'held') {
    const notDispatched = trace.queryProvenance === 'not-dispatched';
    const reason = notDispatched ? efHoldReason(contract, record.requestTime) :
      base.eligibilityStatus === 'not_scored' ? 'outside_run_window' : null;
    ensure(record.eligibilityStatus === 'not_scored' && !record.evidence.length &&
      (notDispatched && trace.query === null || trace.queryProvenance === 'exact-submitted' &&
        trace.query === contract.queryText && trace.requestTime === record.requestTime),
    'Invalid held EF trace');
    ensure(reason && trace.reason === reason &&
      hash(record) === hash(notDispatched ? heldRecord(base, contract, reason) : base),
    'EF held record differs from original admission');
    return;
  }
  ensure(trace.status === 'evaluated' && trace.queryProvenance === 'exact-submitted' &&
    trace.query === contract.queryText &&
    trace.requestTime === record.requestTime, 'EF trace query/request clock mismatch');
  const results = retainResults(trace.results, record.providerId, Math.min(10, contract.retrievalBudget ?? 10), 7000);
  const captured = labelerResults(results, trace.id);
  ensure(trace.reference?.taskHash === trace.taskHash && trace.reference.requestTime === trace.requestTime &&
    trace.reference.independentlyVerifiedTruth === false && hash(captured) === trace.reference.evidenceHash &&
    hash(captured) === hash(trace.reference.results), 'EF retained reference binding mismatch');
  if (trace.effectiveConfig !== null) {
    ensure(hash(retainDiagnostics(trace.effectiveConfig, record.providerId)) === trace.effectiveConfigHash,
      'EF effective configuration hash mismatch');
  }
  const config = parseJudgeConfiguration(trace.judge.config);
  ensure(hash(config) === trace.judge.configHash, 'EF judge configuration hash mismatch');
  const chunks = freshsearch.freshSearchEvidenceChunkInputs({ contract, requestTime: record.requestTime, results: captured });
  ensure(trace.judge.correctiveHandlingVersion === undefined ||
    trace.judge.correctiveHandlingVersion === correctiveHandlingVersion, 'Unsupported EF corrective handling version');
  const corrective = trace.judge.correctiveHandlingVersion === correctiveHandlingVersion;
  if (!corrective) ensure(chunks.length === trace.judge.attempts.length, 'EF judgment chunks mismatch');
  const replayed = corrective ? replayCorrectiveJudgments(chunks, config, trace.judge.attempts) : null;
  if (corrective) ensure(Boolean(trace.judge.correctiveRetryUsed) === replayed.correctiveRetryUsed,
    'EF corrective retry provenance mismatch');
  const labels = replayed?.labels ?? chunks.flatMap((chunk, index) => {
    const attempt = trace.judge.attempts[index];
    const plan = freshsearch.planFreshSearchJudgment(chunk, config.model);
    const request = judgeRequest(plan, config);
    ensure(attempt.status === 'validated' && attempt.promptVersion === plan.promptVersion &&
      hash(attempt.request) === hash(request) && attempt.requestHash === hash(request) &&
      attempt.schemaHash === hash(plan.body.response_format) && attempt.promptHash === hash(plan.body.messages),
    'EF retained judgment request binding mismatch');
    return freshsearch.parsePlannedFreshSearchJudgment(attempt.response, chunk);
  });
  const promptVersion = trace.judge.attempts[0]?.promptVersion ?? null;
  ensure(trace.judge.promptVersion === promptVersion, 'EF record judge provenance mismatch');
  const expected = { ...base, evidence: labels.map(label => label.record),
    ...(chunks.length ? { judgment: {
      kind: 'agent_evidence_labeler', promptVersion,
      ...(contract.timestampValidationVersion ? { timestampValidationVersion: contract.timestampValidationVersion } : {}),
      model: config.model, retrievalProtocolVersion: 'fresh-search-controlled-first-search-v1',
    } } : {}) };
  ensure(hash(record) === hash(expected), 'EF record differs from retained original judgments');
}

async function judgeAttempt(input, config, { reserve, save, trace, signal, fetchImpl = fetch,
  environment = process.env }, correction) {
  signal.throwIfAborted();
  const key = environment[config.apiKeyEnv];
  ensure(typeof key === 'string' && key.trim(), `Set ${config.apiKeyEnv}`);
  const responses = config.transport === 'azure-openai-responses';
  const azureChat = config.transport === 'azure-openai';
  const endpoint = new URL(azureChat ?
    `${config.endpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(config.model)}/chat/completions` :
    config.endpoint);
  if (azureChat) endpoint.searchParams.set('api-version', config.apiVersion);
  const plan = freshsearch.planFreshSearchJudgment(input, config.model, correction);
  const request = judgeRequest(plan, config);
  const attempt = { stage: 'judge', status: 'planned', promptVersion: plan.promptVersion,
    promptHash: hash(plan.body.messages), schemaHash: hash(plan.body.response_format),
    requestHash: hash(request), evidenceIds: input.results.map(result => result.id),
    request, response: null, usage: null,
    responseModel: null, responseId: null, responseFingerprint: null };
  trace.judge.attempts.push(attempt);
  await reserve('judge', attempt);
  signal.throwIfAborted();
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const requestSignal = AbortSignal.any([signal, timeout]);
  requestSignal.throwIfAborted();
  const start = performance.now();
  attempt.requestTime = new Date().toISOString();
  if (correction !== undefined) trace.judge.correctiveRetryUsed = true;
  try {
    const response = await fetchImpl(endpoint.href, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: requestSignal,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        ...(azureChat || responses ? { 'api-key': key } : { Authorization: `Bearer ${key}` }) },
      body: JSON.stringify(request),
    });
    ensure(response.ok, `Judge returned HTTP ${response.status}`);
    const payload = await response.json();
    requestSignal.throwIfAborted();
    ensure(payload && typeof payload === 'object' && !Array.isArray(payload), 'Judge returned invalid completion');
    for (const [field, retained] of [['model', 'responseModel'], ['id', 'responseId'],
      ['system_fingerprint', 'responseFingerprint']]) {
      ensure(payload[field] == null || typeof payload[field] === 'string' && payload[field].length <= 300,
        'Invalid judge response provenance');
      attempt[retained] = payload[field] ?? null;
    }
    if (responses) {
      if (payload.status === 'incomplete' && payload.error == null &&
        payload.incomplete_details?.reason === 'max_output_tokens') attempt.completionFailure = 'incomplete';
      else {
        attempt.response = responsesContent(payload);
        if (!attempt.response.trim()) attempt.completionFailure = 'empty';
      }
    }
    else {
      ensure(Array.isArray(payload.choices) && payload.choices.length === 1,
        'Judge returned invalid completion choices');
      const choice = payload.choices[0];
      ensure(!choice.message?.refusal && choice.finish_reason !== 'content_filter' &&
        choice.message && (choice.message.content === null ||
          typeof choice.message.content === 'string' && choice.message.content.length <= 1000000),
      'Judge refused, truncated or returned no usable completion');
      attempt.response = choice.message.content;
      if (choice.finish_reason && choice.finish_reason !== 'stop') attempt.completionFailure = 'incomplete';
      else if (!attempt.response?.trim()) attempt.completionFailure = 'empty';
    }
    if (payload.usage !== undefined) {
      const fields = responses ? ['input_tokens', 'output_tokens', 'total_tokens'] :
        ['prompt_tokens', 'completion_tokens', 'total_tokens'];
      ensure(payload.usage && fields.every(key =>
        Number.isSafeInteger(payload.usage[key]) && payload.usage[key] >= 0), 'Invalid judge token usage');
      attempt.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens']
        .map((key, index) => [key, payload.usage[fields[index]]]));
    }
    const outcome = inspectAttempt(attempt, input);
    attempt.labels = outcome.labels;
    attempt.rejectedLabels = outcome.rejectedLabels;
    if (outcome.outputError) {
      attempt.outputError = outcome.outputError;
      attempt.status = 'rejected';
      throw new freshsearch.FreshSearchEvidenceLabelerOutputError(outcome.outputError);
    }
    attempt.status = 'validated';
    return outcome.labels;
  } finally {
    attempt.responseTime = new Date().toISOString();
    attempt.elapsedMs = performance.now() - start;
    await save();
  }
}

export async function judgeChunk(input, config, options) {
  const { trace, signal } = options;
  trace.judge.correctiveHandlingVersion ??= correctiveHandlingVersion;
  const ordered = [...input.results].sort((a, b) => a.rank - b.rank);
  const validated = new Map();
  let pending = ordered;
  let correction;
  for (let index = 0; index < 2; index++) {
    try {
      const labels = await judgeAttempt({ ...input, results: pending }, config, options, correction);
      labels.forEach(label => validated.set(label.evidenceId, label));
      return ordered.map(result => validated.get(result.id));
    } catch (error) {
      if (!(error instanceof freshsearch.FreshSearchEvidenceLabelerOutputError) || index === 1) throw error;
      const attempt = trace.judge.attempts.at(-1);
      attempt.labels.forEach(label => validated.set(label.evidenceId, label));
      pending = ordered.filter(result => !validated.has(result.id));
      correction = freshsearch.freshSearchJudgmentCorrection(error.message);
      await delay(500, undefined, { signal });
    }
  }
}

export async function evaluateEF({ contract: raw, adapter, identity, config, reserve, save, input,
  signal, fetchImpl, environment }) {
  const contract = freshsearch.parseFreshSearchTaskContract(raw);
  ensure(contract.panel === 'freshness', 'EF tasks require the freshness panel');
  const trace = { id: randomUUID(), queryId: contract.queryId, providerId: adapter.providerId,
    contract, taskHash: hash(contract), adapter: identity, status: 'capture-unknown',
    query: null, queryProvenance: 'not-dispatched',
    referenceMs: null, judgeMs: null };
  input.traces.push(trace);
  input.pendingTask = { queryId: contract.queryId, providerId: adapter.providerId, traceId: trace.id };
  await save();
  const totalStart = performance.now();
  try {
    signal.throwIfAborted();
    let requestTime = new Date().toISOString();
    trace.requestTime = requestTime;
    const held = efHoldReason(contract, requestTime);
    const base = () => freshsearch.buildFreshSearchFreshnessRecord({
      contract, providerId: adapter.providerId, requestTime, runId: trace.id, sources: [],
    });
    if (held) {
      trace.status = 'held'; trace.reason = held;
      return heldRecord(base(), contract, held);
    }
    // Validate the full task clock profile before any paid dispatch, even for empty searches.
    freshsearch.validateFreshSearchLabelerInput({ contract, requestTime, results: [] });
    trace.searchReservation = { stage: 'search', status: 'planned', traceId: trace.id };
    await reserve('search', trace.searchReservation);
    const results = await captureSearch(adapter, { query: contract.queryText, signal,
      maxResults: Math.min(10, contract.retrievalBudget ?? 10), maxLength: 7000 }, trace, save);
    trace.searchReservation.status = 'captured';
    requestTime = trace.requestTime;
    const captured = labelerResults(results, trace.id);
    trace.reference = { version: 'freshsearch-retained-evidence-reference-v1',
      kind: 'retained-provider-evidence-task-request-clock', independentlyVerifiedTruth: false,
      taskHash: trace.taskHash, evidenceHash: hash(captured), requestTime, results: captured };
    if (base().eligibilityStatus === 'not_scored') {
      trace.status = 'held'; trace.reason = 'outside_run_window';
      return base();
    }
    trace.judge = { config, configHash: hash(config), attempts: [], promptVersion: null };
    const labels = [];
    const judgeStart = performance.now();
    try {
      const judgmentInput = { contract, requestTime, results: captured };
      for (const chunk of freshsearch.freshSearchEvidenceChunkInputs(judgmentInput)) {
        signal.throwIfAborted();
        labels.push(...await judgeChunk(chunk, config,
          { reserve, save, trace, signal, fetchImpl, environment }));
      }
    } finally {
      trace.judgeMs = captured.length ? performance.now() - judgeStart : null;
    }
    signal.throwIfAborted();
    const record = { ...base(), evidence: labels.map(label => label.record),
      ...(captured.length ? { judgment: {
        kind: 'agent_evidence_labeler', promptVersion: trace.judge.attempts[0].promptVersion,
        ...(contract.timestampValidationVersion ? { timestampValidationVersion: contract.timestampValidationVersion } : {}),
        model: config.model, retrievalProtocolVersion: 'fresh-search-controlled-first-search-v1',
      } } : {}) };
    trace.judge.promptVersion = record.judgment?.promptVersion ?? null;
    freshsearch.parseFreshSearchRunRecord(record);
    freshsearch.validateFreshSearchRecordForTask(record, contract);
    ensure(record.providerId === adapter.providerId && record.requestTime === trace.requestTime &&
      record.runId === trace.id, 'EF provider/request clock binding mismatch');
    trace.status = 'evaluated';
    return record;
  } finally {
    trace.totalMs = performance.now() - totalStart;
    await save();
  }
}
