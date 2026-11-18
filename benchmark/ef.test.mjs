// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import freshsearch from './freshsearch.cjs';
import { main, scoreCapture } from './run.mjs';
import { runEvaluation } from './evaluate.mjs';
import { evaluateEF, judgeConfiguration, efHoldReason, validateEFTrace } from './ef.mjs';
import { hash } from './trace.mjs';

const task = (patch = {}) => ({ contractVersion: 'fresh-search-task-v1', queryId: 'weather-test',
  releaseId: 'offline-integration', panel: 'freshness', category: 'weather', tier: 'head',
  timestampType: 'observation', queryText: '  Windhoek "temperature" now?  ',
  canonicalEntity: { id: 'windhoek', name: 'Windhoek, Namibia' },
  informationType: 'current_temperature', timezone: 'Africa/Windhoek', ...patch });
const configuration = { version: 'freshsearch-judge-config-v1', endpoint: 'https://judge.example/v1/chat/completions',
  model: 'explicit-offline-model', apiKeyEnv: 'OFFLINE_JUDGE_KEY', timeoutMs: 1000 };
const azureConfiguration = { version: 'freshsearch-judge-config-v1', transport: 'azure-openai',
  model: 'approved-judge-deployment', apiKeyEnv: 'AZURE_OPENAI_KEY',
  apiVersion: '2024-12-01-preview', timeoutMs: 1000 };
const responsesConfiguration = { version: 'freshsearch-judge-config-v1', transport: 'azure-openai-responses',
  endpoint: 'https://azure-judge.example/openai/v1/responses',
  model: 'gpt-5.6-luna', apiKeyEnv: 'AZURE_OPENAI_KEY', timeoutMs: 1000 };
const environment = { OFFLINE_JUDGE_KEY: 'never-retain-this-judge-key',
  AZURE_OPENAI_ENDPOINT: 'https://azure-judge.example/',
  AZURE_OPENAI_KEY: 'never-retain-this-azure-judge-key' };
const content = 'Windhoek temperature 25 C. Observation: 2026-10-14T12:51:00Z.';
const rawLabel = (id, patch = {}) => ({
  evidenceId: id, entityRelevant: true, informationTypeRelevant: true, qualifyingTimestampSupported: true,
  timestampText: '2026-10-14T12:51:00Z', timestampType: 'observation', timezoneBasis: 'explicit_utc',
  timezoneKnown: true, earliestUtc: '2026-10-14T12:51:00Z', latestUtc: null,
  provenanceStatus: 'supported', evidencePassage: content, rationale: 'Verbatim observation clock.',
  ...patch,
});
const completion = labels => Response.json({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ labels }) } }],
  usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
});
const responsesPayload = labels => ({
  id: 'resp-offline-test', model: 'reported-model-revision', status: 'completed',
  output: [
    { type: 'reasoning', id: 'reasoning-offline', summary: [] },
    { type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify({ labels }), annotations: [] }] },
  ],
  usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 },
});
const labelsForBody = body => {
  const prompt = JSON.parse((body.messages ?? body.input).find(message => message.role === 'user').content);
  return prompt.untrustedResults.map(result => rawLabel(result.id));
};

function confirmedReading(observed) {
  return { status: 'supported', recordLocator: 'Current observation for Windhoek, Namibia',
    observedAt: { date: observed.slice(0, 10), time: observed.slice(11, 19), zone: 'Z' },
    relativeClock: null, timestampQuote: observed, evidenceQuote: 'Temperature 25 C',
    reason: 'Captured observation' };
}

function confirmedCompletion(reading) {
  return Response.json({ choices: [{ finish_reason: 'stop',
    message: { role: 'assistant', content: JSON.stringify({ reading }), refusal: null } }],
  usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } });
}

test('standalone scorer rejects structured provider source evidence', () => {
  assert.throws(() => freshsearch.buildFreshSearchFreshnessRecord({
    contract: task(), providerId: 'offline-adapter', requestTime: '2026-10-14T12:51:00Z',
    runId: 'test', sources: [{ id: 'source', rank: 1 }],
  }), /Structured provider source evidence is not supported/);
});

function harness(overrides = {}) {
  const input = { traces: [], records: [] };
  const dispatches = [];
  const checkpoints = [];
  const signal = new AbortController().signal;
  const adapter = { providerId: 'offline-adapter', async search(options) {
    options.signal.throwIfAborted();
    dispatches.push('search');
    assert.equal(options.query, task().queryText);
    return [{ url: 'https://source.example/weather', content }];
  } };
  const reserve = async (stage, attempt) => {
    dispatches.push(`${stage}-reserved`);
    attempt.status = 'reserved';
  };
  const save = async () => { checkpoints.push(structuredClone(input)); };
  const fetchImpl = async (_, options) => {
    dispatches.push('judge');
    assert.ok(checkpoints.at(-1)?.pendingTask);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['Cache-Control'], 'no-store');
    return completion(labelsForBody(JSON.parse(options.body)));
  };
  return { contract: task(), adapter, identity: { entrySha256: 'offline-test' },
    config: judgeConfiguration(configuration, environment), reserve, save, input, signal,
    fetchImpl, environment, dispatches, checkpoints, ...overrides };
}

test('shared EF performs one exact search, grounded original judgment, and original record/scorer', async () => {
  const h = harness();
  const record = await evaluateEF(h);
  assert.deepEqual(h.dispatches, ['search-reserved', 'search', 'judge-reserved', 'judge']);
  assert.equal(record.evidence[0].provenanceStatus, 'supported');
  assert.equal(record.judgment.kind, 'agent_evidence_labeler');
  assert.equal(record.judgment.promptVersion, 'freshsearch-evidence-labeler-legacy-revision-twelve-v1');
  assert.equal(record.requestTime, h.input.traces[0].requestTime);
  assert.equal(record.providerId, h.adapter.providerId);
  assert.deepEqual(freshsearch.parseFreshSearchRunRecord(record), record);
  freshsearch.validateFreshSearchRecordForTask(record, task());
  const trace = h.input.traces[0];
  const originalLabels = freshsearch.parsePlannedFreshSearchJudgment(trace.judge.attempts[0].response,
    { contract: task(), requestTime: record.requestTime, results: trace.reference.results });
  assert.deepEqual(record.evidence, originalLabels.map(label => label.record));
  assert.deepEqual(record, { ...freshsearch.buildFreshSearchFreshnessRecord({
    contract: task(), providerId: record.providerId, requestTime: record.requestTime,
    runId: record.runId, sources: [],
  }), evidence: originalLabels.map(label => label.record), judgment: record.judgment });
  assert.equal(trace.reference.independentlyVerifiedTruth, false);
  assert.equal(trace.reference.evidenceHash, hash(trace.reference.results));
  assert.equal(trace.referenceMs, null);
  assert.equal(trace.judge.attempts[0].responseModel, null);
  assert.equal(trace.judge.attempts[0].responseId, null);
  assert.equal(trace.judge.attempts[0].responseFingerprint, null);
  assert.ok(trace.searchMs >= 0 && trace.judgeMs >= 0 && trace.totalMs >= trace.searchMs);
  assert.equal(trace.query, task().queryText);
  assert.ok(!JSON.stringify(h.input).includes(environment.OFFLINE_JUDGE_KEY));
});

test('default correction preserves valid labels, fixes only the rejected quote and replays both attempts', async () => {
  for (const configurationValue of [configuration, azureConfiguration, responsesConfiguration]) {
    const h = harness({ config: judgeConfiguration(configurationValue, environment) });
    h.adapter.search = async () => {
      h.dispatches.push('search');
      return Array.from({ length: 3 }, (_, index) => ({
        url: `https://source.example/${index}`, content: `${content}\nUpdated7 minutes ago`,
      }));
    };
    let calls = 0;
    h.fetchImpl = async (_, options) => {
      h.dispatches.push('judge');
      const body = JSON.parse(options.body);
      const prompt = JSON.parse((body.messages ?? body.input).find(message => message.role === 'user').content);
      const labels = labelsForBody(body);
      if (calls++ === 0) {
        assert.equal(prompt.correction, undefined);
        labels[1].timestampText = 'Updated 7 minutes ago';
      } else {
        assert.equal(labels.length, 1);
        assert.ok(labels[0].evidenceId.endsWith('/2'));
        assert.match(prompt.correction, /non-verbatim timestamp text/);
        assert.equal(prompt.task.requestTime, h.input.traces[0].requestTime);
        assert.equal(prompt.untrustedResults[0].content, `${content}\nUpdated7 minutes ago`);
        labels[0].timestampText = 'Updated7 minutes ago';
        labels[0].earliestUtc = new Date(Date.parse(prompt.task.requestTime) - 7 * 60000).toISOString();
        labels[0].latestUtc = labels[0].earliestUtc;
      }
      return body.input ? Response.json(responsesPayload(labels)) : completion(labels);
    };
    const record = await evaluateEF(h);
    assert.equal(calls, 2);
    assert.equal(h.dispatches.filter(stage => stage === 'search').length, 1);
    const trace = h.input.traces[0];
    assert.deepEqual(trace.judge.attempts.map(attempt => attempt.status), ['rejected', 'validated']);
    assert.deepEqual(trace.judge.attempts.map(attempt => attempt.labels.length), [2, 1]);
    assert.equal(trace.judge.correctiveRetryUsed, true);
    assert.equal(record.evidence.length, 3);
    validateEFTrace(trace, record);
    const partial = { version: 'freshsearch-traced-input-v1', panel: 'ef',
      kind: 'synthetic-fixture', records: [record], traces: [trace] };
    assert.equal(scoreCapture(partial, 'ef').rows[0].status, 'scored');
    for (const corrupt of [
      value => { value.judge.attempts.splice(0, 1); },
      value => { value.judge.attempts.push(value.judge.attempts[1]); },
      value => { value.judge.attempts[0].outputError = 'different correction'; },
      value => { value.judge.attempts[0].labels = []; },
      value => { value.judge.attempts[1].evidenceIds.push('another-id'); },
      value => { value.judge.correctiveRetryUsed = false; },
      value => { delete value.judge.correctiveHandlingVersion; },
    ]) {
      const tampered = structuredClone(trace);
      corrupt(tampered);
      assert.throws(() => validateEFTrace(tampered, record));
    }
  }
});

test('persistent quotation errors stop after one corrective attempt and retain partial valid labels', async () => {
  const h = harness();
  let calls = 0;
  h.fetchImpl = async (_, options) => {
    calls++;
    return completion(labelsForBody(JSON.parse(options.body)).map(label => ({
      ...label, timestampText: 'fabricated timestamp',
    })));
  };
  await assert.rejects(evaluateEF(h), /non-verbatim timestamp text/);
  assert.equal(calls, 2);
  assert.deepEqual(h.input.traces[0].judge.attempts.map(attempt => attempt.status), ['rejected', 'rejected']);
  assert.equal(h.input.records.length, 0);
  assert.ok(h.input.pendingTask);
});

test('a corrective reservation cannot exceed the explicit budget or bypass cancellation/checkpoint failure', async () => {
  for (const stop of ['budget', 'cancel', 'checkpoint']) {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    let reserved = 0;
    let calls = 0;
    h.reserve = async (stage, attempt) => {
      if (stage === 'judge' && ++reserved > 1) throw new Error('judge call budget exhausted');
      attempt.status = 'reserved';
    };
    const originalSave = h.save;
    h.save = async () => {
      await originalSave();
      if (stop === 'checkpoint' && h.input.traces[0].judge?.attempts[0]?.status === 'rejected') {
        throw new Error('checkpoint write failed');
      }
    };
    h.fetchImpl = async () => {
      calls++;
      if (stop === 'cancel') controller.abort(new Error('cancelled correction'));
      return completion([]);
    };
    await assert.rejects(evaluateEF(h), stop === 'budget' ? /budget exhausted/ :
      stop === 'checkpoint' ? /checkpoint write failed/ : /cancelled/);
    assert.equal(calls, 1);
    assert.equal(h.input.records.length, 0);
  }
});

test('malformed JSON, wrong IDs, empty and truncated completions receive one bounded corrective request', async () => {
  for (const initial of [
    () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{bad' } }] }),
    () => completion([]),
    () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }),
    () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{partial' } }] }),
  ]) {
    const h = harness();
    let calls = 0;
    h.fetchImpl = async (_, options) => calls++ === 0 ? initial() : completion(labelsForBody(JSON.parse(options.body)));
    const record = await evaluateEF(h);
    assert.equal(calls, 2);
    validateEFTrace(h.input.traces[0], record);
  }
});

test('a ten-result task can use four individually reserved judge calls, without additional searches', async () => {
  const h = harness();
  h.adapter.search = async () => {
    h.dispatches.push('search');
    return Array.from({ length: 10 }, (_, index) => ({ url: `https://source.example/${index}`, content }));
  };
  let calls = 0;
  h.fetchImpl = async (_, options) => {
    calls++;
    const body = JSON.parse(options.body);
    const prompt = JSON.parse(body.messages.find(message => message.role === 'user').content);
    const labels = labelsForBody(body);
    if (!prompt.correction) labels[0].timestampText = 'fabricated timestamp';
    return completion(labels);
  };
  const record = await evaluateEF(h);
  assert.equal(calls, 4);
  assert.equal(h.dispatches.filter(stage => stage === 'judge-reserved').length, 4);
  assert.equal(h.dispatches.filter(stage => stage === 'search').length, 1);
  assert.equal(record.evidence.length, 10);
  validateEFTrace(h.input.traces[0], record);
});

test('Responses truncation and empty text get one correction while refusals and HTTP failures do not', async () => {
  for (const first of [
    { status: 'incomplete', error: null, incomplete_details: { reason: 'max_output_tokens' } },
    { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: '' }] }] },
  ]) {
    const h = harness({ config: judgeConfiguration(responsesConfiguration, environment) });
    let calls = 0;
    h.fetchImpl = async (_, options) => Response.json(calls++ === 0
      ? first : responsesPayload(labelsForBody(JSON.parse(options.body))));
    const record = await evaluateEF(h);
    assert.equal(calls, 2);
    validateEFTrace(h.input.traces[0], record);
  }
});

test('historical captures without corrective provenance still replay unchanged', async () => {
  const h = harness();
  const record = await evaluateEF(h);
  const trace = h.input.traces[0];
  delete trace.judge.correctiveHandlingVersion;
  delete trace.judge.attempts[0].rejectedLabels;
  validateEFTrace(trace, record);
});

test('Azure judge uses FreshSearch resource/deployment URL, api-version and API-key authentication', async () => {
  const config = judgeConfiguration(azureConfiguration, environment);
  const h = harness({ config });
  h.fetchImpl = async (url, options) => {
    h.dispatches.push('judge');
    assert.equal(url, 'https://azure-judge.example/openai/deployments/approved-judge-deployment/chat/completions?api-version=2024-12-01-preview');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'api-key': environment.AZURE_OPENAI_KEY });
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.model, azureConfiguration.model);
    assert.equal(body.response_format.type, 'json_schema');
    return completion(labelsForBody(body));
  };
  const record = await evaluateEF(h);
  assert.deepEqual(h.dispatches, ['search-reserved', 'search', 'judge-reserved', 'judge']);
  validateEFTrace(h.input.traces[0], record);
  assert.equal(h.input.traces[0].judge.config.endpoint, environment.AZURE_OPENAI_ENDPOINT);
  assert.equal(h.input.traces[0].judge.config.apiVersion, azureConfiguration.apiVersion);
  assert.ok(!JSON.stringify(h.input).includes(environment.AZURE_OPENAI_KEY));
  const corrupted = structuredClone(h.input.traces[0]);
  corrupted.judge.config.apiVersion = '2025-01-01-preview';
  assert.throws(() => validateEFTrace(corrupted, record), /configuration hash mismatch/);
});

test('Azure configuration resolves FreshSearch endpoint explicitly while legacy normalization stays unchanged', () => {
  assert.deepEqual(judgeConfiguration(configuration, environment), { ...configuration, physicalRetries: 0 });
  assert.deepEqual(judgeConfiguration(azureConfiguration, environment), {
    ...azureConfiguration, endpoint: environment.AZURE_OPENAI_ENDPOINT, physicalRetries: 0,
  });
  assert.equal(judgeConfiguration({ ...azureConfiguration, endpoint: 'https://pinned-azure.example/' },
    { AZURE_OPENAI_KEY: environment.AZURE_OPENAI_KEY }).endpoint, 'https://pinned-azure.example/');
  for (const endpoint of [undefined, '', ' ']) {
    assert.throws(() => judgeConfiguration(azureConfiguration, { ...environment, AZURE_OPENAI_ENDPOINT: endpoint }),
      /Set AZURE_OPENAI_ENDPOINT/);
  }
  assert.throws(() => judgeConfiguration(azureConfiguration, {
    AZURE_OPENAI_ENDPOINT: environment.AZURE_OPENAI_ENDPOINT,
  }), /Set AZURE_OPENAI_KEY/);
  for (const patch of [
    { transport: 'unknown' }, { apiVersion: undefined }, { apiVersion: '2024-12-01-preview&key=secret' },
    { model: '../other' }, { model: 'deployment with spaces' },
    { endpoint: 'https://azure-judge.example/openai/v1/chat/completions' },
    { endpoint: 'https://azure-judge.example/?api-version=2024-12-01-preview' },
    { endpoint: 'http://azure-judge.example' },
  ]) assert.throws(() => judgeConfiguration({ ...azureConfiguration, ...patch }, environment));
  assert.throws(() => judgeConfiguration({ ...configuration, apiVersion: '2024-12-01-preview' }, environment),
    /requires azure-openai/);
});

test('Azure Responses uses the exact v1 endpoint, original prompt/schema, API key and a non-stored request', async () => {
  const h = harness({ config: judgeConfiguration(responsesConfiguration, environment) });
  h.fetchImpl = async (url, options) => {
    h.dispatches.push('judge');
    assert.equal(url, responsesConfiguration.endpoint);
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'api-key': environment.AZURE_OPENAI_KEY });
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    const trace = h.input.traces[0];
    const plan = freshsearch.planFreshSearchJudgment({
      contract: task(), requestTime: trace.requestTime, results: trace.reference.results,
    }, responsesConfiguration.model);
    assert.deepEqual(body.input, plan.body.messages);
    assert.deepEqual(body.text.format, { type: 'json_schema', ...plan.body.response_format.json_schema });
    assert.equal(body.max_output_tokens, plan.body.max_completion_tokens);
    assert.equal(body.store, false);
    for (const key of ['seed', 'messages', 'response_format', 'max_completion_tokens',
      'previous_response_id', 'tools', 'background', 'temperature']) assert.equal(body[key], undefined);
    assert.equal(trace.judge.attempts[0].requestHash, hash(body));
    return Response.json(responsesPayload(labelsForBody(body)));
  };
  const record = await evaluateEF(h);
  assert.deepEqual(h.dispatches, ['search-reserved', 'search', 'judge-reserved', 'judge']);
  const attempt = h.input.traces[0].judge.attempts[0];
  assert.equal(attempt.responseModel, 'reported-model-revision');
  assert.equal(attempt.responseId, 'resp-offline-test');
  assert.deepEqual(attempt.usage, { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 });
  validateEFTrace(h.input.traces[0], record);
  assert.ok(!JSON.stringify(h.input).includes(environment.AZURE_OPENAI_KEY));
  const tampered = structuredClone(h.input.traces[0]);
  tampered.judge.attempts[0].request.store = true;
  assert.throws(() => validateEFTrace(tampered, record), /request binding mismatch/);
});

test('Responses configuration rejects wrong API paths and legacy API versions before dispatch', () => {
  assert.deepEqual(judgeConfiguration(responsesConfiguration, environment), { ...responsesConfiguration, physicalRetries: 0 });
  for (const patch of [
    { endpoint: undefined }, { endpoint: 'https://azure-judge.example/' },
    { endpoint: 'https://azure-judge.example/openai/v1/chat/completions' },
    { endpoint: 'https://azure-judge.example/openai/v1/responses?api-version=2024-12-01-preview' },
    { endpoint: 'http://azure-judge.example/openai/v1/responses' },
    { apiVersion: '2024-12-01-preview' }, { model: '../other' },
  ]) assert.throws(() => judgeConfiguration({ ...responsesConfiguration, ...patch }, environment));
  assert.throws(() => judgeConfiguration(responsesConfiguration, {}), /Set AZURE_OPENAI_KEY/);
});

test('Responses schema and explicit non-reasoning temperature are preserved', async () => {
  const contract = task({ timestampExtractorVersion: 'legacy-extractor-v1' });
  const h = harness({ contract,
    config: judgeConfiguration({ ...responsesConfiguration, model: 'approved-legacy-deployment' }, environment) });
  h.fetchImpl = async (_, options) => {
    const body = JSON.parse(options.body);
    const trace = h.input.traces[0];
    const plan = freshsearch.planFreshSearchJudgment({
      contract, requestTime: trace.requestTime, results: trace.reference.results,
    }, h.config.model);
    assert.equal(body.temperature, plan.body.temperature);
    assert.equal(body.temperature, 0);
    assert.equal(body.seed, undefined);
    assert.deepEqual(body.text.format.schema, plan.body.response_format.json_schema.schema);
    assert.ok(JSON.stringify(body.text.format).includes('timestamps'));
    return Response.json(responsesPayload([{
      evidenceId: trace.reference.results[0].id, entityRelevant: true, informationTypeRelevant: true,
      targetText: '25 C', itemBinding: { scope: 'single_item_page', text: 'Windhoek temperature' },
      timestamps: [{
        role: 'observation', bindingText: content, dateText: '2026-10-14',
        timeText: '12:51:00', zoneText: 'Z', yearText: null, relativeText: null,
        dayFirst: false, dateFromCrawl: false, zoneAssumedTaskLocation: false, closeDate: null,
      }],
      provenanceStatus: 'supported', reasonCode: 'ok', rationale: 'Literal observation.',
    }]));
  };
  const record = await evaluateEF(h);
  validateEFTrace(h.input.traces[0], record);
});

test('Responses transport/refusal failures stay unknown; invalid labels get at most one corrective attempt', async () => {
  for (const mutate of [
    payload => { payload.status = 'incomplete'; payload.incomplete_details = { reason: 'max_output_tokens' }; },
    payload => { payload.status = 'failed'; payload.error = { message: 'private error' }; },
    payload => { payload.output = []; },
    payload => { payload.output[1].content = [{ type: 'refusal', refusal: 'private refusal' }]; },
    payload => { payload.output[1].status = 'in_progress'; },
    payload => { payload.output[1].role = 'user'; },
    payload => { payload.output.push({ type: 'function_call' }); },
    payload => { payload.output.push(structuredClone(payload.output[1])); },
    payload => { payload.output[1].content.push({ type: 'output_text', text: '{}' }); },
    payload => { payload.output[1].content[0].text = '{bad'; },
    payload => { payload.output[1].content[0].text = '{"labels":[]}'; },
    payload => { payload.usage.input_tokens = -1; },
    payload => { payload.model = 42; },
  ]) {
    const h = harness({ config: judgeConfiguration(responsesConfiguration, environment) });
    let attempts = 0;
    h.fetchImpl = async (_, options) => {
      attempts++;
      const payload = responsesPayload(labelsForBody(JSON.parse(options.body)));
      mutate(payload);
      return Response.json(payload);
    };
    await assert.rejects(evaluateEF(h));
    const rejected = h.input.traces[0].judge.attempts[0].status === 'rejected';
    assert.equal(attempts, rejected ? 2 : 1);
    assert.equal(h.input.records.length, 0);
    assert.ok(h.input.pendingTask);
    assert.equal(h.input.traces[0].judge.attempts.at(-1).status, rejected ? 'rejected' : 'reserved');
    assert.ok(!JSON.stringify(h.input).includes('private refusal'));
    assert.ok(!JSON.stringify(h.input).includes('private error'));
  }
});

test('Azure HTTP failures preserve the reserved attempt without retrying or retaining response secrets', async () => {
  for (const judge of [azureConfiguration, responsesConfiguration]) for (const status of [401, 429, 500, 503]) {
    const h = harness({ config: judgeConfiguration(judge, environment) });
    let attempts = 0;
    h.fetchImpl = async () => {
      attempts++;
      return new Response('private Azure failure body', { status });
    };
    await assert.rejects(evaluateEF(h), new RegExp(`HTTP ${status}`));
    assert.equal(attempts, 1);
    assert.equal(h.input.traces[0].judge.attempts[0].status, 'reserved');
    assert.ok(!JSON.stringify(h.input).includes('private Azure failure body'));
    assert.ok(!JSON.stringify(h.input).includes(environment.AZURE_OPENAI_KEY));
  }
});

test('a removed judge credential fails before reserving or sending a judge attempt', async () => {
  for (const judge of [configuration, azureConfiguration, responsesConfiguration]) {
    const h = harness({ config: judgeConfiguration(judge, environment), environment: {} });
    await assert.rejects(evaluateEF(h), new RegExp(`Set ${judge.apiKeyEnv}`));
    assert.deepEqual(h.dispatches, ['search-reserved', 'search']);
    assert.equal(h.input.traces[0].judge.attempts.length, 0);
  }
});

test('judge response identity is provider-reported separately from the requested model', async () => {
  for (const metadata of [
    { model: 'reported-model-revision', id: 'completion-id', system_fingerprint: 'fingerprint' },
    { model: 42 }, { system_fingerprint: { invalid: true } },
  ]) {
    const h = harness();
    h.fetchImpl = async (_, options) => {
      const payload = await completion(labelsForBody(JSON.parse(options.body))).json();
      return Response.json({ ...payload, ...metadata });
    };
    if (typeof metadata.model === 'string') {
      const record = await evaluateEF(h);
      assert.equal(record.judgment.model, configuration.model);
      const receipt = h.input.traces[0].judge.attempts[0];
      assert.equal(receipt.responseModel, metadata.model);
      assert.equal(receipt.responseId, metadata.id);
      assert.equal(receipt.responseFingerprint, metadata.system_fingerprint);
      validateEFTrace(h.input.traces[0], record);
    } else {
      await assert.rejects(evaluateEF(h), /Invalid judge response provenance/);
      assert.equal(h.input.records.length, 0);
      const partial = { ...h.input, version: 'freshsearch-traced-input-v1',
        kind: 'synthetic-fixture', panel: 'ef' };
      assert.equal(scoreCapture(partial, 'ef').rows[0].status, 'capture-unknown');
    }
  }
});

test('empty successful search is original empty evidence, not invented missing labels/judge call', async () => {
  const h = harness({ adapter: { providerId: 'empty', search: async () => [] } });
  const record = await evaluateEF(h);
  assert.deepEqual(record.evidence, []);
  assert.equal(record.judgment, undefined);
  assert.deepEqual(h.dispatches, ['search-reserved']);
  assert.equal(freshsearch.scoreFreshnessRun(record, freshsearch.DEFAULT_FRESH_SEARCH_POLICY).score, 0);
});

test('provider failures cannot trigger judging, fallbacks or fabricated evidence', async () => {
  for (const reason of ['HTTP 401', 'HTTP 429', 'HTTP 503', 'provider timeout', 'malformed provider JSON']) {
    let searches = 0;
    const h = harness({ adapter: { providerId: 'failed-search', search: async () => {
      searches++; throw new Error(reason);
    } } });
    await assert.rejects(evaluateEF(h), new RegExp(reason));
    assert.equal(searches, 1);
    assert.deepEqual(h.dispatches, ['search-reserved']);
    assert.equal(h.input.records.length, 0);
    assert.equal(h.input.traces[0].status, 'capture-unknown');
    assert.equal(h.input.traces[0].judge, undefined);
  }
});

test('legacy EF tasks use the original candidate schema and normalizer', async () => {
  for (const role of ['observation', 'publication', 'page_update', 'crawl_metadata']) {
    const contract = task({ timestampExtractorVersion: 'legacy-extractor-v1' });
    const h = harness({ contract });
    h.fetchImpl = async (_, options) => {
      h.dispatches.push('judge');
      const body = JSON.parse(options.body);
      assert.ok(JSON.stringify(body.response_format).includes('timestamps'));
      const id = h.input.traces[0].reference.results[0].id;
      return completion([{
        evidenceId: id, entityRelevant: true, informationTypeRelevant: true,
        targetText: '25 C', itemBinding: { scope: 'single_item_page', text: 'Windhoek temperature' },
        timestamps: [{
          role, bindingText: content, dateText: '2026-10-14',
          timeText: '12:51:00', zoneText: 'Z', yearText: null, relativeText: null,
          dayFirst: false, dateFromCrawl: false, zoneAssumedTaskLocation: false, closeDate: null,
        }],
        provenanceStatus: 'supported', reasonCode: 'ok', rationale: 'Literal observation.',
      }]);
    };
    const record = await evaluateEF(h);
    assert.deepEqual(h.dispatches, ['search-reserved', 'search', 'judge-reserved', 'judge']);
    assert.notEqual(record.judgment.promptVersion, 'freshsearch-evidence-labeler-legacy-revision-twelve-v1');
    validateEFTrace(h.input.traces[0], record);
    if (role === 'observation') {
      assert.equal(record.evidence[0].provenanceStatus, 'supported');
      assert.equal(record.evidence[0].timestamp.type, 'observation');
    } else {
      assert.equal(record.evidence[0].provenanceStatus, 'unsupported');
      assert.equal(record.evidence[0].timestamp, undefined);
      assert.equal(freshsearch.scoreFreshnessRun(record, freshsearch.DEFAULT_FRESH_SEARCH_POLICY).score, 0);
    }
    assert.ok(record.evidence[0].timestampExtraction);
  }
});

test('returned-evidence tasks are held before reservations and replay only as undispatched holds', async () => {
  const contract = task({ timestampExtractorVersion: 'legacy-extractor-v1', retrievalBudget: 3,
    returnedEvidenceSetVersion: 'fresh-search-returned-evidence-set-v1' });
  assert.equal(freshsearch.parseFreshSearchTaskContract(contract).returnedEvidenceSetVersion,
    contract.returnedEvidenceSetVersion);
  assert.equal(efHoldReason(contract, '2026-11-09T15:00:00Z'),
    'unsupported-standalone-task-mode');
  const h = harness({ contract });
  h.input.assignments = [{ queryId: contract.queryId, providerId: h.adapter.providerId,
    contract: freshsearch.parseFreshSearchTaskContract(contract),
    taskHash: hash(freshsearch.parseFreshSearchTaskContract(contract)) }];
  h.input.execution = { reservations: [] };
  const record = await evaluateEF(h);
  assert.deepEqual(h.dispatches, []);
  assert.equal(record.eligibilityStatus, 'not_scored');
  assert.equal(record.returnedEvidenceSet, undefined);
  assert.equal(record.judgment, undefined);
  assert.deepEqual(record.evidence, []);
  const trace = h.input.traces[0];
  assert.equal(trace.status, 'held');
  assert.equal(trace.queryProvenance, 'not-dispatched');
  assert.equal(trace.query, null);
  assert.equal(trace.searchReservation, undefined);
  assert.equal(trace.judge, undefined);
  const capture = { version: 'freshsearch-traced-input-v1', panel: 'ef',
    kind: 'synthetic-fixture', records: [record], traces: h.input.traces,
    assignments: h.input.assignments, execution: h.input.execution };
  validateEFTrace(trace, record, capture);
  assert.equal(scoreCapture(capture, 'ef').rows[0].status, 'held');
  assert.throws(() => freshsearch.validateFreshSearchRecordForTask(record, contract),
    /Returned-evidence version or budget/);
  assert.throws(() => validateEFTrace(trace, { ...record, releaseId: 'another-release' }, capture),
    /EF held record differs/);
  assert.throws(() => validateEFTrace({ ...trace, status: 'evaluated' }, record, capture),
    /Returned-evidence version or budget/);
  assert.throws(() => validateEFTrace({ ...trace, queryProvenance: 'exact-submitted',
    query: contract.queryText }, record, capture));
  for (const dispatched of [{ searchReservation: { stage: 'search', status: 'reserved' } },
    { judge: { attempts: [] } }]) {
    assert.throws(() => validateEFTrace({ ...trace, ...dispatched }, record, capture), /hold has dispatch state/);
  }
  assert.throws(() => validateEFTrace(trace, record), /task assignment binding/);
  const reassigned = structuredClone(capture);
  reassigned.traces[0].contract.queryText = 'a different retained query';
  reassigned.traces[0].taskHash = hash(freshsearch.parseFreshSearchTaskContract(reassigned.traces[0].contract));
  assert.throws(() => scoreCapture(reassigned, 'ef'), /task assignment binding/);
  for (const stage of ['search', 'judge']) {
    const reserved = structuredClone(capture);
    reserved.execution.reservations.push({ stage, traceId: trace.id, status: 'reserved' });
    assert.throws(() => scoreCapture(reserved, 'ef'), /reservation ledger evidence/);
  }
  const evaluated = harness();
  await evaluateEF(evaluated);
  const dispatched = structuredClone(capture);
  Object.assign(dispatched.traces[0], evaluated.input.traces[0], {
    id: trace.id, requestTime: trace.requestTime, contract: trace.contract, taskHash: trace.taskHash,
    status: 'held', query: null, queryProvenance: 'not-dispatched',
  });
  assert.throws(() => scoreCapture(dispatched, 'ef'), /hold has dispatch state/);
});

test('finance-window and unsupported-mode holds dispatch nothing', async () => {
  for (const contract of [
    task({ category: 'traffic', experimental: true }),
    task({ category: 'sports', experimental: true }),
    task({ category: 'commerce', experimental: true }),
    task({ queryText: undefined }),
    task({ category: 'finance', timestampType: 'specified_quote' }),
    task({ category: 'news', timestampType: 'publication', informationType: 'latest_news' }),
    task({ timestampExtractorVersion: 'legacy-extractor-v1', answerBearingEvidenceSetVersion: 'freshsearch-answer-bearing-selection-v1' }),
    task({ timestampExtractorVersion: 'confirmed-clock' }),
    task({ answerProtocolVersion: 'fresh-search-participant-answer-v1',
      timestampExtractorVersion: 'legacy-extractor-v1', answerBearingEvidenceSetVersion: 'freshsearch-answer-bearing-selection-v1',
      evidenceMatcherVersion: 'captured-evidence-identity-v1' }),
    task({ category: 'finance', timestampType: 'specified_quote', financeWindowOverride: 'ignore-window' }),
  ]) {
    const h = harness({ contract });
    const record = await evaluateEF(h);
    assert.equal(record.eligibilityStatus, 'not_scored');
    assert.deepEqual(h.dispatches, []);
    assert.equal(freshsearch.scoreFreshnessRun(record, freshsearch.DEFAULT_FRESH_SEARCH_POLICY).score, null);
    validateEFTrace(h.input.traces[0], record);
    assert.throws(() => validateEFTrace({ ...h.input.traces[0], reason: 'invented-hold' }, record),
      /original admission/);
    assert.equal(scoreCapture({ version: 'freshsearch-traced-input-v1', panel: 'ef',
      kind: 'synthetic-fixture', records: [record], traces: h.input.traces }, 'ef').rows[0].status, 'held');
  }
  const finance = task({ category: 'finance', timestampType: 'specified_quote',
    quote: { exchange: 'XNYS', currency: 'USD', quoteType: 'price', session: 'regular' } });
  assert.equal(efHoldReason(task({ category: 'traffic' }), '2026-11-09T15:00:00Z'),
    'unsupported-standalone-task-mode');
  assert.equal(efHoldReason(task({ category: 'sports' }), '2026-11-09T15:00:00Z'),
    'unsupported-standalone-task-mode');
  assert.match(efHoldReason(finance, '2026-11-08T15:00:00Z'), /outside_run_window/);
  assert.equal(efHoldReason(finance, '2026-11-09T15:00:00Z'), null);
});

test('portable evidence retains normalized crawl anchors alongside publication clocks', async () => {
  const h = harness({ contract: task({ timestampExtractorVersion: 'legacy-extractor-v1' }) });
  h.adapter.search = async () => [{ url: 'https://source.example/weather', content,
    metadata: { version: 'freshsearch-result-metadata-v1', providerId: h.adapter.providerId,
      resultType: 'web', title: 'Conditions', titleTruncated: false, contentTruncated: false, timestamps: [
      { attribution: 'provider-reported', field: 'published', kind: 'published', value: '2026-10-13T10:00:00Z' },
      { attribution: 'provider-reported', field: 'crawled', kind: 'crawled', value: '2026-10-14T14:51:00.123456+02:00' },
    ] } }];
  h.fetchImpl = async () => completion([{
    evidenceId: h.input.traces[0].reference.results[0].id,
    entityRelevant: true, informationTypeRelevant: true, targetText: '25 C',
    itemBinding: { scope: 'single_item_page', text: 'Windhoek temperature' },
    timestamps: [], provenanceStatus: 'unsupported', reasonCode: 'no_timestamp',
    rationale: 'No qualifying literal clock.',
  }]);
  const record = await evaluateEF(h);
  const result = h.input.traces[0].reference.results[0];
  assert.equal(result.datePublished, '2026-10-13T10:00:00Z');
  assert.equal(result.datePublishedSource, 'published');
  assert.equal(result.crawledAt, '2026-10-14T12:51:00.123Z');
  validateEFTrace(h.input.traces[0], record);
});

test('missing config/key, unsafe endpoints and absent explicit model fail before dispatch', () => {
  for (const config of [null, { ...configuration, model: '' },
    { ...configuration, endpoint: 'http://judge.example' },
    { ...configuration, endpoint: 'https://judge.example?key=secret' },
    { ...configuration, endpoint: 'https://u:secret@judge.example' },
    { ...configuration, timeoutMs: 0 }, { ...configuration, apiKeyEnv: 'literal-key' }]) {
    assert.throws(() => judgeConfiguration(config, environment));
  }
  assert.throws(() => judgeConfiguration(configuration, {}), /Set OFFLINE_JUDGE_KEY/);
  for (const patch of [
    { endpoint: 'https://judge.example.invalid/v1/chat/completions' },
    { endpoint: 'https://REPLACE_WITH_RESOURCE.example.com/v1/chat/completions' },
    { model: 'REPLACE_WITH_EXPLICIT_PINNED_MODEL' },
    { model: 'YOUR_MODEL_ID' },
  ]) assert.throws(() => judgeConfiguration({ ...configuration, ...patch }, environment), /placeholder/);
});

test('all stage cancellations retain unknown and cannot trigger later calls', async () => {
  for (const boundary of ['before', 'search-reserved', 'search-returned', 'judge-reserved', 'judge-returned']) {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    if (boundary === 'before') controller.abort();
    h.reserve = async (stage) => {
      h.dispatches.push(`${stage}-reserved`);
      if (boundary === `${stage}-reserved`) controller.abort();
    };
    const search = h.adapter.search;
    h.adapter.search = async options => {
      const results = await search(options);
      if (boundary === 'search-returned') controller.abort();
      return results;
    };
    const fetchImpl = h.fetchImpl;
    h.fetchImpl = async (...args) => {
      const response = await fetchImpl(...args);
      if (boundary === 'judge-returned') controller.abort();
      return response;
    };
    await assert.rejects(evaluateEF(h), /abort/i);
    assert.equal(h.input.records.length, 0);
    assert.ok(h.input.pendingTask);
    if (['before', 'search-reserved'].includes(boundary)) assert.ok(!h.dispatches.includes('search'));
    if (boundary !== 'judge-returned') assert.ok(!h.dispatches.includes('judge'));
  }
});

test('budget/checkpoint failure prevents next physical dispatch and keeps partial judge unknown', async () => {
  for (const denied of ['search', 'judge']) {
    const h = harness();
    h.reserve = async stage => { if (stage === denied) throw new Error('call budget exhausted'); };
    await assert.rejects(evaluateEF(h), /budget exhausted/);
    assert.ok(!h.dispatches.includes(denied));
    assert.ok(h.input.pendingTask);
    if (denied === 'judge') assert.equal(h.input.traces[0].results.length, 1);
  }
  const h = harness();
  h.save = async () => { throw new Error('checkpoint unavailable'); };
  await assert.rejects(evaluateEF(h), /checkpoint unavailable/);
  assert.deepEqual(h.dispatches, []);
});

for (const status of [401, 429, 500, 503]) {
  test(`HTTP ${status} is one attempt, never an invented miss or retry`, async () => {
    const h = harness();
    h.fetchImpl = async () => { h.dispatches.push('judge'); return new Response('private failure body', { status }); };
    await assert.rejects(evaluateEF(h), new RegExp(`HTTP ${status}`));
    assert.equal(h.dispatches.filter(stage => stage === 'judge').length, 1);
    assert.equal(h.input.traces[0].judge.attempts[0].status, 'reserved');
    assert.ok(!JSON.stringify(h.input).includes('private failure body'));
  });
}

test('malformed, refused, truncated, future, wrong-kind, fabricated and mismatched labels fail explicitly', async () => {
  for (const response of [
    () => new Response('{bad'),
    () => Response.json({ choices: [] }),
    () => Response.json({ choices: [{ finish_reason: 'stop', message: { refusal: 'no' } }] }),
    () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
    body => completion(labelsForBody(body).map(label => ({ ...label, timestampText: 'invented timestamp' }))),
    body => completion(labelsForBody(body).map(label => ({ ...label, evidenceId: 'wrong-binding' }))),
    body => completion(labelsForBody(body).map(label => ({ ...label, timestampType: 'publication' }))),
    body => completion(labelsForBody(body).map(label => ({ ...label, earliestUtc: '2099-01-01T00:00:00Z' }))),
    body => completion(labelsForBody(body).map(label => ({ ...label, timezoneBasis: 'unknown' }))),
  ]) {
    const h = harness();
    h.fetchImpl = async (_, options) => response(JSON.parse(options.body));
    await assert.rejects(evaluateEF(h));
    assert.equal(h.input.records.length, 0);
    assert.ok(h.input.pendingTask);
  }
});

test('source missing/crawl metadata alone is never auto-credited; real missing label is scored original zero', async () => {
  const h = harness({ adapter: { providerId: 'crawl-only', search: async () => [{
    url: 'https://source.example/weather', content: 'Windhoek temperature 25 C, no observation clock.',
    metadata: {
      version: 'freshsearch-result-metadata-v1', providerId: 'crawl-only', resultType: 'web',
      title: 'Windhoek Weather', titleTruncated: false, contentTruncated: false,
      timestamps: [{ attribution: 'provider-reported', field: 'crawledAt', kind: 'crawled',
        value: '2026-10-14T12:51:00Z' }],
    },
  }] } });
  h.fetchImpl = async (_, options) => completion(labelsForBody(JSON.parse(options.body)).map(label => ({
    ...label, qualifyingTimestampSupported: false, timestampText: null, timestampType: null,
    timezoneBasis: null, timezoneKnown: false, earliestUtc: null, latestUtc: null,
    provenanceStatus: 'missing', evidencePassage: null,
  })));
  const record = await evaluateEF(h);
  assert.equal(h.input.traces[0].reference.results[0].datePublishedSource, 'crawled');
  assert.equal(record.evidence[0].provenanceStatus, 'missing');
  assert.equal(record.evidence[0].timestamp, undefined);
  assert.equal(freshsearch.scoreFreshnessRun(record, freshsearch.DEFAULT_FRESH_SEARCH_POLICY).score, 0);
});

test('five-result original chunks reserve separately; second-chunk failure retains first without a score', async () => {
  const h = harness({ adapter: { providerId: 'many', search: async () =>
    Array.from({ length: 10 }, (_, index) => ({ url: `https://source.example/${index}`, content })) } });
  let count = 0;
  h.fetchImpl = async (_, options) => {
    count++;
    const body = JSON.parse(options.body);
    assert.equal(labelsForBody(body).length, 5);
    if (count === 2) throw new Error('second chunk interrupted');
    return completion(labelsForBody(body));
  };
  await assert.rejects(evaluateEF(h), /interrupted/);
  assert.equal(count, 2);
  const attempts = h.input.traces[0].judge.attempts;
  assert.deepEqual(attempts.map(a => a.status), ['validated', 'reserved']);
  assert.equal(attempts[0].labels.length, 5);
  assert.ok(h.input.pendingTask);
});

for (const judge of [configuration, responsesConfiguration]) {
  test(`${judge.transport ?? 'openai'} judge timeout covers response body and retains reservation with no retry`, async () => {
    const h = harness({ config: { ...judgeConfiguration(judge, environment), timeoutMs: 10 } });
    h.fetchImpl = async (_, options) => ({ ok: true, json: () => new Promise((_, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('deadline was not enforced')), 500);
      options.signal.addEventListener('abort', () => {
        clearTimeout(keepAlive); reject(options.signal.reason);
      }, { once: true });
    }) });
    await assert.rejects(evaluateEF(h), /timeout/i);
    assert.equal(h.input.traces[0].judge.attempts.length, 1);
  });
}

for (const judge of [configuration, azureConfiguration, responsesConfiguration]) {
  test(`CLI ${judge.transport ?? 'openai'} writes metadata-only receipts without retaining source or judge content`,
    async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'freshsearch-ef-receipt-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    for (const [key, value] of Object.entries({ ...environment, EXA_API_KEY: 'never-retain-this-search-key' })) {
      const old = process.env[key]; process.env[key] = value;
      t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    }
    let calls = 0;
    const observed = new Date(Date.now() - 10 * 60000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
    const marker = 'UNIQUE_PROVIDER_PUBLISHER_CONTENT_DO_NOT_RETAIN';
    const source = `Current observation for Windhoek, Namibia\nTemperature 25 C\nObserved: ${observed}\n${marker}`;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls++;
      const checkpoint = JSON.parse(await fs.readFile(path.join(temporary, 'run', 'checkpoint.json'), 'utf8'));
      if (String(url).includes('api.exa.ai')) {
        assert.equal(checkpoint.execution.reserved.search, 1);
        return Response.json({ results: [{ url: 'https://source.example/weather', text: source,
          title: 'Current observation for Windhoek, Namibia' }] });
      }
      assert.equal(checkpoint.execution.reservations.at(-1).status, 'reserved');
      assert.equal(JSON.parse(options.body).store, false);
      if (judge.transport === 'azure-openai') {
        assert.equal(String(url), 'https://azure-judge.example/openai/deployments/approved-judge-deployment/chat/completions?api-version=2024-12-01-preview');
        assert.equal(options.headers['api-key'], environment.AZURE_OPENAI_KEY);
        assert.equal(options.headers.Authorization, undefined);
      }
      if (judge.transport === 'azure-openai-responses') {
        assert.equal(options.headers['api-key'], environment.AZURE_OPENAI_KEY);
        const payload = responsesPayload([]);
        payload.output[1].content[0].text = JSON.stringify({ reading: confirmedReading(observed) });
        return Response.json(payload);
      }
      return confirmedCompletion(confirmedReading(observed));
    });
    await fs.writeFile(path.join(temporary, 'config.json'), JSON.stringify(judge));
    await fs.writeFile(path.join(temporary, 'tasks.json'), JSON.stringify({
      version: 'freshsearch-rt-tasks-v1', tasks: [task()],
    }));
    const out = path.join(temporary, 'run');
    const report = await main(['--live', '--confirm-authorized-use', '--panel', 'ef', '--input', path.join(temporary, 'tasks.json'),
      '--provider', fileURLToPath(new URL('./providers/exa-auto.mjs', import.meta.url)),
      '--judge-config', path.join(temporary, 'config.json'), '--max-calls', '1',
      '--max-judge-calls', '2', '--out', out]);
    assert.equal(calls, 3);
    assert.equal(report.version, 'freshsearch-launch-report-v1');
    assert.equal(report.cases[0].score, 100);
    assert.equal(report.retention, 'metadata-only-not-replayable');
    const checkpoint = JSON.parse(await fs.readFile(path.join(out, 'checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.replayable, false);
    assert.deepEqual(checkpoint.execution.reserved, { search: 1, judge: 2 });
    await assert.rejects(fs.stat(path.join(out, 'capture.json')), /ENOENT/);
    for (const name of ['checkpoint.json', 'results.json', 'cases.csv', 'issues.csv']) {
      const saved = await fs.readFile(path.join(out, name), 'utf8');
      for (const secret of [environment.OFFLINE_JUDGE_KEY, environment.AZURE_OPENAI_KEY,
        process.env.EXA_API_KEY, marker, source, task().queryText, observed,
        'https://source.example/weather']) {
        assert.ok(!saved.includes(secret));
      }
    }
    const csv = await fs.readFile(path.join(out, 'cases.csv'), 'utf8');
    assert.doesNotMatch(csv, /queryProvenance/);
    await assert.rejects(main(['--panel', 'ef', '--input', path.join(out, 'checkpoint.json'),
      '--out', path.join(temporary, 'replay')]), /capture|panel/i);
    assert.equal(calls, 3);
  });
}

test('capture-only partial input replays as unknown without any dispatch', async () => {
  const h = harness();
  h.fetchImpl = async () => { throw new Error('interrupted'); };
  await assert.rejects(evaluateEF(h));
  const input = { ...h.input, version: 'freshsearch-traced-input-v1', panel: 'ef',
    kind: 'synthetic-fixture', records: [] };
  const scored = scoreCapture(input, 'ef');
  assert.equal(scored.rows[0].status, 'capture-unknown');
  assert.equal(scored.rows[0].score, null);
  input.assignments = [{ queryId: task().queryId, providerId: h.adapter.providerId, contract: task() },
    { queryId: 'later-task', providerId: h.adapter.providerId, contract: task({ queryId: 'later-task' }) }];
  const assigned = scoreCapture(input, 'ef').rows;
  assert.equal(assigned.length, 2);
  assert.equal(assigned[1].reason, 'not-dispatched');
  assert.equal(assigned[1].query, null);
});

test('real CLI judge budget preserves reservations without retaining partial content',
  async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'freshsearch-ef-budget-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  for (const [key, value] of Object.entries({ ...environment, EXA_API_KEY: 'offline-search-secret' })) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  await fs.writeFile(path.join(temporary, 'config.json'), JSON.stringify(configuration));
  await fs.writeFile(path.join(temporary, 'tasks.json'), JSON.stringify({
    version: 'freshsearch-rt-tasks-v1', tasks: [task(), task({ queryId: 'not-yet-dispatched' })],
  }));
  const out = path.join(temporary, 'run');
  let requests = 0;
  const observed = new Date(Date.now() - 10 * 60000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const marker = 'UNIQUE_PARTIAL_PROVIDER_CONTENT_DO_NOT_RETAIN';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++;
    if (String(url).includes('api.exa.ai')) return Response.json({
      results: [{ url: 'https://source.example/weather',
        title: 'Current observation for Windhoek, Namibia',
        text: `Current observation for Windhoek, Namibia\nTemperature 25 C\nObserved: ${observed}\n${marker}` }],
    });
    const saved = JSON.parse(await fs.readFile(path.join(out, 'checkpoint.json'), 'utf8'));
    assert.equal(saved.execution.reserved.judge, 1);
    assert.equal(JSON.parse(options.body).store, false);
    return confirmedCompletion(confirmedReading(observed));
  });
  const args = ['--live', '--confirm-authorized-use', '--panel', 'ef', '--input', path.join(temporary, 'tasks.json'),
    '--provider', fileURLToPath(new URL('./providers/exa-auto.mjs', import.meta.url)),
    '--judge-config', path.join(temporary, 'config.json'), '--max-calls', '2',
    '--max-judge-calls', '1', '--out', out];
  await assert.rejects(main(args), /judge call budget exhausted/);
  assert.equal(requests, 2);
  const checkpoint = JSON.parse(await fs.readFile(path.join(out, 'checkpoint.json'), 'utf8'));
  assert.deepEqual(checkpoint.execution.reserved, { search: 1, judge: 1 });
  assert.equal(checkpoint.assignmentCount, 2);
  assert.equal(checkpoint.replayable, false);
  assert.ok(!JSON.stringify(checkpoint).includes(marker));
  await assert.rejects(fs.stat(path.join(out, 'results.json')), /ENOENT/);
  await assert.rejects(main(['--panel', 'ef', '--input', path.join(out, 'checkpoint.json'),
    '--out', path.join(temporary, 'replay')]), /capture|panel/i);
  // Neither missing credential/config nor an omitted judge budget can dispatch anything.
  const missingBudget = [...args];
  missingBudget.splice(missingBudget.indexOf('--max-judge-calls'), 2);
  await assert.rejects(main(missingBudget.map(value =>
    value === out ? path.join(temporary, 'missing-budget') : value)), /max-judge-calls/);
  delete process.env.OFFLINE_JUDGE_KEY;
  await assert.rejects(main(args.map(value =>
    value === out ? path.join(temporary, 'missing-key') : value)), /Set OFFLINE_JUDGE_KEY/);
  assert.equal(requests, 2);
});

for (const judge of [configuration, responsesConfiguration]) {
  test(`truncated ${judge.transport ?? 'openai'} judge output has actionable private diagnostics through the launcher`,
    async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'freshsearch-truncated-judge-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    for (const [key, value] of Object.entries({ ...environment, EXA_API_KEY: 'offline-search-secret' })) {
      const previous = process.env[key]; process.env[key] = value;
      t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    }
    const judgeFile = path.join(temporary, 'judge.json');
    const taskFile = path.join(temporary, 'tasks.json');
    await fs.writeFile(judgeFile, JSON.stringify(judge));
    await fs.writeFile(taskFile, JSON.stringify({
      version: 'freshsearch-rt-tasks-v1', tasks: [task(), task({ queryId: 'not-yet-dispatched' })],
    }));
    const marker = 'PRIVATE_TRUNCATED_PROVIDER_AND_JUDGE_CONTENT';
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (String(url).includes('api.exa.ai')) {
        requests.push('search');
        return Response.json({ results: [{ url: 'https://source.example/private', title: 'Private title',
          text: marker }] });
      }
      requests.push('judge');
      const body = JSON.parse(options.body);
      assert.equal(body.max_completion_tokens ?? body.max_output_tokens, 1024);
      if (judge.transport === 'azure-openai-responses') {
        return Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
          output: [{ type: 'reasoning', summary: [{ text: marker }] }],
          usage: { input_tokens: 100, output_tokens: 1024, total_tokens: 1124 } });
      }
      return Response.json({ choices: [{ finish_reason: 'length',
        message: { role: 'assistant', content: marker, refusal: null } }],
      usage: { prompt_tokens: 100, completion_tokens: 1024, total_tokens: 1124,
        completion_tokens_details: { reasoning_tokens: 1000 } } });
    });
    const out = path.join(temporary, 'evaluation');
    await assert.rejects(runEvaluation({
      live: true, 'confirm-authorized-use': true, 'ef-only': true,
      provider: [fileURLToPath(new URL('./providers/exa-auto.mjs', import.meta.url))],
      'ef-input': taskFile, 'judge-config': judgeFile, 'max-ef-calls': '2', 'max-judge-calls': '4', out,
    }), error => {
      assert.equal(error.name, 'LiveRunError');
      assert.equal(error.reason, 'judge-output-truncated');
      assert.match(error.message, /output-token limit/);
      assert.match(error.message, /model.*deployment/);
      assert.ok(!error.message.includes(marker));
      return true;
    });
    assert.deepEqual(requests, ['search', 'judge']);
    const manifest = JSON.parse(await fs.readFile(path.join(out, 'evaluation.json'), 'utf8'));
    assert.equal(manifest.failure.reason, 'judge-output-truncated');
    assert.deepEqual(manifest.assignments.map(row => row.status), ['failed', 'pending']);
    const summary = JSON.parse(await fs.readFile(path.join(out, 'summary.json'), 'utf8'));
    assert.equal(summary.completed, 0);
    assert.equal(summary.panels[0].unknown, 2);
    assert.equal(summary.panels[0].scored, 0);
    assert.equal(summary.combined[0].score, null);
    const child = path.join(out, manifest.assignments[0].directory);
    const failure = JSON.parse(await fs.readFile(path.join(child, 'failure.json'), 'utf8'));
    assert.equal(failure.reason, 'judge-output-truncated');
    assert.match(failure.message, /output-token limit/);
    const checkpoint = JSON.parse(await fs.readFile(path.join(child, 'checkpoint.json'), 'utf8'));
    assert.deepEqual(checkpoint.execution.reserved, { search: 1, judge: 1 });
    for (const filename of [path.join(out, 'evaluation.json'), path.join(out, 'summary.json'),
      path.join(out, 'results.html'), path.join(child, 'failure.json'), path.join(child, 'checkpoint.json')]) {
      const saved = await fs.readFile(filename, 'utf8');
      for (const sensitive of [marker, environment.OFFLINE_JUDGE_KEY, environment.AZURE_OPENAI_KEY,
        process.env.EXA_API_KEY, 'https://source.example/private', 'Private title', task().queryText]) {
        assert.ok(!saved.includes(sensitive), `${path.basename(filename)} retained private content`);
      }
    }
  });
}

for (const cancellation of [false, true]) {
  test(`partial EF ${cancellation ? 'cancellation' : 'judge failure'} does not persist or print provider content`,
    async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'freshsearch-ef-private-failure-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    for (const [key, value] of Object.entries({ ...environment, EXA_API_KEY: 'offline-search-secret' })) {
      const old = process.env[key]; process.env[key] = value;
      t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    }
    await fs.writeFile(path.join(temporary, 'config.json'), JSON.stringify(configuration));
    await fs.writeFile(path.join(temporary, 'tasks.json'), JSON.stringify({
      version: 'freshsearch-rt-tasks-v1', tasks: [task()],
    }));
    const marker = 'UNIQUE_PRIVATE_PROVIDER_AND_JUDGE_FAILURE_CONTENT';
    const controller = new AbortController();
    const printed = [];
    t.mock.method(console, 'error', value => printed.push(String(value)));
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async url => {
      requests++;
      if (String(url).includes('api.exa.ai')) return Response.json({
        results: [{ url: 'https://source.example/private', title: 'Private source title', text: marker }],
      });
      if (cancellation) controller.abort(new Error(marker));
      throw new Error(marker);
    });
    const out = path.join(temporary, 'run');
    let failure;
    try {
      await main(['--live', '--confirm-authorized-use', '--panel', 'ef',
        '--input', path.join(temporary, 'tasks.json'),
        '--provider', fileURLToPath(new URL('./providers/exa-auto.mjs', import.meta.url)),
        '--judge-config', path.join(temporary, 'config.json'), '--max-calls', '1',
        '--max-judge-calls', '2', '--out', out], { signal: controller.signal });
      assert.fail('failure must stop the run');
    } catch (error) {
      failure = error;
    }
    assert.equal(failure.name, 'LiveRunError');
    assert.equal(failure.reason, cancellation ? 'interrupted' : 'collection-or-validation-failed');
    assert.ok(!failure.message.includes(marker));
    assert.equal(requests, 2);
    const checkpoint = JSON.parse(await fs.readFile(path.join(out, 'checkpoint.json'), 'utf8'));
    assert.deepEqual(checkpoint.execution.reserved, { search: 1, judge: 1 });
    assert.equal(checkpoint.execution.reservations.at(-1).status, 'unknown');
    assert.equal(checkpoint.replayable, false);
    for (const name of await fs.readdir(out)) {
      const saved = await fs.readFile(path.join(out, name), 'utf8');
      for (const privateValue of [marker, 'https://source.example/private', 'Private source title',
        environment.OFFLINE_JUDGE_KEY, process.env.EXA_API_KEY, task().queryText]) {
        assert.ok(!saved.includes(privateValue), `${name} retained private content`);
      }
    }
    assert.ok(printed.every(message => !message.includes(marker)));
  });
}

const categoryCases = [
  ['provider-transport-failed', { search: () => { throw new TypeError('fetch failed'); } }, ['search', 'search']],
  ['judge-transport-failed', { judge: () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); } }],
  ['judge-http-503', { judge: () => new Response('{"error":"PRIVATE_JUDGE_BODY"}', { status: 503 }) }],
  ['judge-schema-rejected', { judge: () => Response.json({ choices: [{ finish_reason: 'stop',
    message: { role: 'assistant', content: 'PRIVATE_JUDGE_BODY not json', refusal: null } }] }) }],
  ['judge-evidence-not-verbatim', { judge: observed => confirmedCompletion({ ...confirmedReading(observed),
    evidenceQuote: 'PRIVATE_JUDGE_BODY fabricated quote' }) }],
];

for (const [reason, behavior, expectedRequests] of categoryCases) {
  test(`${reason} is a sanitized, actionable category and continue-after-failure records it per task`, async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'freshsearch-ef-category-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    for (const [key, value] of Object.entries({ ...environment, EXA_API_KEY: 'offline-search-secret' })) {
      const previous = process.env[key]; process.env[key] = value;
      t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    }
    const judgeFile = path.join(temporary, 'judge.json');
    const taskFile = path.join(temporary, 'tasks.json');
    await fs.writeFile(judgeFile, JSON.stringify(configuration));
    await fs.writeFile(taskFile, JSON.stringify({ version: 'freshsearch-rt-tasks-v1',
      tasks: [task(), task({ queryId: 'weather-second' })] }));
    const observed = new Date(Date.now() - 10 * 60000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
    const marker = 'PRIVATE_JUDGE_BODY';
    const requests = [];
    t.mock.method(globalThis, 'fetch', async url => {
      if (String(url).includes('api.exa.ai')) {
        requests.push('search');
        if (behavior.search) return behavior.search();
        return Response.json({ results: [{ url: 'https://source.example/private',
          title: 'Current observation for Windhoek, Namibia',
          text: `Current observation for Windhoek, Namibia\nTemperature 25 C\nObserved: ${observed}\nPRIVATE_SOURCE_TEXT` }] });
      }
      requests.push('judge');
      return behavior.judge(observed);
    });
    const out = path.join(temporary, 'evaluation');
    const progress = [];
    const { manifest, summary } = await runEvaluation({
      live: true, 'confirm-authorized-use': true, 'ef-only': true, 'continue-after-failure': true,
      provider: [fileURLToPath(new URL('./providers/exa-auto.mjs', import.meta.url))],
      'ef-input': taskFile, 'judge-config': judgeFile, 'max-ef-calls': '2', 'max-judge-calls': '8', out,
    }, { progress: { write: line => progress.push(line) } });
    assert.equal(manifest.status, 'partial');
    assert.deepEqual(manifest.assignments.map(row => row.status), ['failed', 'failed']);
    assert.ok(requests.filter(kind => kind === 'search').length === 2, 'the second task still ran');
    if (expectedRequests) assert.deepEqual(requests, expectedRequests);
    for (const [index, row] of manifest.assignments.entries()) {
      assert.equal(row.failure.reason, reason);
      assert.equal(row.failure.panel, 'ef');
      assert.equal(row.failure.category, 'weather');
      assert.equal(row.failure.providerId, 'exa-auto');
      assert.equal(row.failure.unitId, index ? 'weather-second' : 'weather-test');
      assert.equal(row.failure.calls.search, 1);
      assert.ok(row.failure.calls.judge <= row.failure.calls.judgeLimit);
      assert.match(row.failure.hint, /\S/);
    }
    assert.deepEqual([summary.failed, summary.completed], [2, 0]);
    assert.ok(progress.some(line => line.includes(`failed (${reason})`)));
    for (const filename of ['evaluation.json', 'summary.json', 'results.html',
      path.join(manifest.assignments[0].directory, 'failure.json')]) {
      const saved = await fs.readFile(path.join(out, filename), 'utf8');
      for (const sensitive of [marker, 'PRIVATE_SOURCE_TEXT', 'https://source.example/private',
        environment.OFFLINE_JUDGE_KEY, process.env.EXA_API_KEY, 'judge.example', task().queryText]) {
        assert.ok(!saved.includes(sensitive), `${filename} retained private content`);
      }
    }
    assert.ok(progress.every(line => !line.includes(marker) && !/https?:/.test(line)));
  });
}
