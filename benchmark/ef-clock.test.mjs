// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import portable from './freshsearch-confirmed-clock.cjs';
import normalization from './providers/normalization.cjs';
import { assertRuntimeSupport, runtimeIdentity } from './runtime.mjs';
import { currentEFTask, evaluateConfirmedClockEF, scoreConfirmedClockEFCapture,
  CONFIRMED_CLOCK_EF_CAPTURE_VERSION } from './ef-clock.mjs';
import { judgeConfiguration } from './ef.mjs';
import { hash } from './trace.mjs';

const task = {
  contractVersion: 'fresh-search-task-v1', queryId: 'offline-weather',
  releaseId: 'offline-fixtures', panel: 'freshness', category: 'weather', tier: 'head',
  timestampType: 'observation', queryText: 'Current temperature in New York City?',
  canonicalEntity: { id: 'new-york-city', name: 'New York City' },
  informationType: 'current_temperature', timezone: 'Etc/UTC',
};
const config = judgeConfiguration({
  version: 'freshsearch-judge-config-v1', endpoint: 'https://judge.example/v1/chat/completions',
  model: 'offline-model', apiKeyEnv: 'OFFLINE_JUDGE_KEY', timeoutMs: 1000,
}, { OFFLINE_JUDGE_KEY: 'offline-key' });
function harness({ unrelated = 0, maximumJudge = 100, transport } = {}) {
  const contract = currentEFTask(task);
  const input = {
    version: CONFIRMED_CLOCK_EF_CAPTURE_VERSION, panel: 'ef', kind: 'live-capture',
    records: [], traces: [],
    assignments: [{ queryId: contract.queryId, providerId: 'fixture-provider',
      contract, taskHash: hash(contract) }],
    execution: { reserved: { search: 0, judge: 0 }, reservations: [] },
  };
  const checkpoints = [];
  const calls = [];
  const clock = new Date(Date.now() - 10 * 60000);
  clock.setUTCMilliseconds(0);
  const observed = clock.toISOString().replace('.000Z', 'Z');
  const title = 'Current observation for New York City';
  const content = `${title}\nTemperature 10 C\nObserved: ${observed}`;
  const payload = {
    results: [
      ...Array.from({ length: unrelated }, (_, index) => ({
        evidence: { type: 'text', content: `Unrelated page ${index + 1}` },
        citations: [{ title: `Page ${index + 1}`, url: `https://example.org/${index}` }],
      })),
      { evidence: { type: 'text', content },
        citations: [{ title, url: 'https://example.org/weather' }] },
    ],
  };
  const adapter = {
    providerId: 'fixture-provider',
    async searchFullResponse(options) {
      calls.push('search');
      assert.equal(input.execution.reserved.search, 1);
      const data = await portable.readRetainedSearchResponse(
        new Response(JSON.stringify(payload)), this.providerId, options,
      );
      return normalization.mapWebIQAutoFullResponse(data, options.maxResults, options.maxLength,
        portable.retainedResponseReceivedAt(data));
    },
  };
  const reserve = async (stage, attempt) => {
    if (stage === 'judge' && input.execution.reserved.judge >= maximumJudge) {
      throw new Error('judge call budget exhausted');
    }
    input.execution.reserved[stage]++;
    attempt.status = 'reserved';
    input.execution.reservations.push({
      stage, ordinal: input.execution.reserved[stage], traceId: attempt.traceId,
      reservationId: attempt.reservationId, requestHash: attempt.requestHash ?? null,
      status: 'reserved',
    });
    await save();
  };
  const save = async () => { checkpoints.push(structuredClone(input)); };
  const fetchImpl = async (_, options) => {
    calls.push('judge');
    assert.equal(checkpoints.at(-1).execution.reservations.at(-1).status, 'reserved');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['Cache-Control'], 'no-store');
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    const responses = transport === 'azure-openai-responses';
    assert.equal(responses ? body.reasoning.effort : body.reasoning_effort, 'low');
    assert.equal(responses ? body.max_output_tokens : body.max_completion_tokens, 1024);
    if (responses) {
      assert.equal(options.headers['api-key'], 'offline-key');
      assert.equal(body.text.format.type, 'json_schema');
      assert.equal(body.text.format.strict, true);
      assert.ok(!Object.hasOwn(body, 'seed'));
      assert.ok(!Object.hasOwn(body, 'messages'));
    }
    const messages = responses ? body.input : body.messages;
    const prompt = JSON.parse(messages.find(message => message.role === 'user').content);
    const source = prompt.results[0];
    const answering = source.content === content;
    const reading = answering ? {
      status: 'supported', recordLocator: title,
      observedAt: { date: observed.slice(0, 10), time: observed.slice(11, 19), zone: 'Z' },
      relativeClock: null, timestampQuote: observed, evidenceQuote: 'Temperature 10 C',
      reason: 'Captured observation',
    } : {
      status: 'not_answering', recordLocator: null, observedAt: null, relativeClock: null,
      timestampQuote: null, evidenceQuote: null, reason: 'Not an observation',
    };
    if (responses) return Response.json({ status: 'completed', output: [{
      type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify({ reading }) }],
    }], usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 } });
    return Response.json({ choices: [{ finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify({ reading }), refusal: null } }],
    usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } });
  };
  const judge = transport ? judgeConfiguration({
    version: 'freshsearch-judge-config-v1', transport,
    endpoint: 'https://judge.example/openai/v1/responses', model: 'offline-model',
    apiKeyEnv: 'OFFLINE_JUDGE_KEY', timeoutMs: 1000,
  }, { OFFLINE_JUDGE_KEY: 'offline-key' }) : config;
  return { contract, input, adapter, identity: { entrySha256: 'offline-test' }, config: judge,
    reserve, save, signal: new AbortController().signal, fetchImpl,
    environment: { OFFLINE_JUDGE_KEY: 'offline-key' }, calls, checkpoints };
}

test('current EF tasks reject conflicting scoring versions', () => {
  const contract = currentEFTask(task);
  assert.equal(contract.timestampExtractorVersion, 'confirmed-clock');
  assert.equal(contract.returnedEvidenceSetVersion, portable.FRESH_SEARCH_FULL_RESPONSE_VERSION);
  assert.throws(() => currentEFTask({ ...task, timestampExtractorVersion: 'legacy-extractor-v1' }), /conflicts/u);
});

test('a different recorded Weather runtime is rejected before any physical attempt', async () => {
  const h = harness();
  h.contract.clockValidation.runtime.icu = '0.0';
  await assert.rejects(evaluateConfirmedClockEF(h), /runtime|scoring contract|conflicts/iu);
  assert.deepEqual(h.calls, []);
  assert.equal(h.input.execution.reservations.length, 0);
});

test('full-response EF saves independently reserved reads and replays without network access',
  async () => {
    const h = harness();
    const record = await evaluateConfirmedClockEF(h);
    h.input.records.push(record);
    delete h.input.pendingTask;
    assert.deepEqual(h.calls, ['search', 'judge', 'judge']);
    assert.equal(record.evidence[0].provenanceStatus, 'supported');
    assert.equal(h.input.traces[0].response.mapping.receivedCount, 1);
    assert.deepEqual(h.input.execution.reservations.map(row => row.status), ['settled', 'settled', 'settled']);
    const scored = await scoreConfirmedClockEFCapture(h.input);
    assert.equal(scored.rows[0].score, 100);
    assert.deepEqual(h.calls, ['search', 'judge', 'judge']);
    assert.ok(!JSON.stringify(h.input).includes('offline-key'));

    const corruptions = [
      value => { value.traces[0].response.rawBody += ' '; },
      value => { value.traces[0].sources[0].content += 'tampered'; },
      value => { value.traces[0].judge.attempts[0].response.message.content = '{}'; },
      value => { value.traces[0].judge.attempts[0].request.messages[0].content += 'tampered'; },
      value => { value.traces[0].judge.attempts.pop(); },
      value => { value.execution.reservations[1].status = 'unknown'; },
    ];
    for (const corrupt of corruptions) {
      const changed = structuredClone(h.input);
      corrupt(changed);
      await assert.rejects(scoreConfirmedClockEFCapture(changed));
    }
  });

test('full-response EF judges a qualifying eleventh result rather than truncating at ten',
  async () => {
    const h = harness({ unrelated: 10 });
    const record = await evaluateConfirmedClockEF(h);
    h.input.records.push(record);
    delete h.input.pendingTask;
    const scored = await scoreConfirmedClockEFCapture(h.input);
    assert.equal(scored.rows[0].score, 100);
    assert.equal(scored.rows[0].details.evidenceScores[0].rank, 11);
    assert.equal(h.input.execution.reserved.judge, 12);
  });

test('judge budget exhaustion does not retry or create a completed record', async () => {
  const h = harness({ maximumJudge: 1 });
  await assert.rejects(evaluateConfirmedClockEF(h), /budget exhausted/u);
  assert.deepEqual(h.calls, ['search', 'judge']);
  assert.equal(h.input.records.length, 0);
  assert.ok(h.input.pendingTask);
});

test('supported runtime patches pass without disabling recorded-runtime and timezone checks', () => {
  assertRuntimeSupport();
  for (const node of ['22.0.0', '22.23.5', '24.0.0', '24.99.1', '26.13.0']) {
    assert.deepEqual(runtimeIdentity({ node, icu: '78.3', tz: '2026e' }),
      { node: `v${node}`, icu: '78.3', timeZoneData: '2026e' });
  }
  for (const node of ['20.19.0', '23.0.0', '25.0.0', '26.0.0-rc.1']) {
    assert.throws(() => runtimeIdentity({ node, icu: '78.3', tz: '2026e' }), /requires Node/u);
  }
  assert.throws(() => runtimeIdentity({ node: '26.0.0', icu: '78.3' }), /timezone/u);
});

test('Azure Responses supports strict confirmed-clock judgments and bound offline replay', async () => {
  const h = harness({ transport: 'azure-openai-responses' });
  const record = await evaluateConfirmedClockEF(h);
  h.input.records.push(record);
  delete h.input.pendingTask;
  assert.deepEqual(h.calls, ['search', 'judge', 'judge']);
  const scored = await scoreConfirmedClockEFCapture(h.input);
  assert.equal(scored.rows[0].score, 100);
  const changed = structuredClone(h.input);
  changed.traces[0].judge.attempts[0].wireRequestHash = '0'.repeat(64);
  await assert.rejects(scoreConfirmedClockEFCapture(changed));
});

test('Azure Responses rejects incomplete, refused and malformed usage without a retry', async () => {
  for (const corrupt of [
    payload => { payload.status = 'incomplete'; },
    payload => { payload.output[0].content = [{ type: 'refusal', refusal: 'Refused' }]; },
    payload => { payload.output.push({ type: 'function_call' }); },
    payload => { payload.usage.input_tokens = -1; },
    payload => { payload.usage = null; },
  ]) {
    const h = harness({ transport: 'azure-openai-responses' });
    const fetch = h.fetchImpl;
    h.fetchImpl = async (...args) => {
      const payload = await (await fetch(...args)).json();
      corrupt(payload);
      return Response.json(payload);
    };
    await assert.rejects(evaluateConfirmedClockEF(h), /Judge Responses|judge token usage/iu);
    assert.deepEqual(h.calls, ['search', 'judge']);
    assert.equal(h.input.records.length, 0);
  }
});
