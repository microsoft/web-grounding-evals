// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const fs = require('node:fs');
const path = require('node:path');
const at = '2026-11-05T18:00:00.000Z';
const record = (id, category, minutes, status = 'eligible') => ({
  recordVersion: 'fresh-search-run-v1', panel: 'freshness',
  queryId: id, releaseId: 'synthetic-smoke-v1', providerId: 'fixture',
  runId: `fixture-${id}`, requestTime: at, eligibilityStatus: status,
  ...(status === 'not_scored' ? { exclusionReason: 'reference_unavailable' } : {}),
  category, tier: 'head',
  evidence: status === 'not_scored' ? [] : [{
    evidenceId: `${id}-G1`, rank: 1, relevant: true, provenanceStatus: 'supported',
    timestamp: { earliestUtc: new Date(Date.parse(at) - minutes * 60000).toISOString(),
      timezoneKnown: true, type: category === 'news' ? 'publication' : category === 'finance' ? 'specified_quote' : 'observation' },
  }],
});
const ef = {
  version: 'freshsearch-portable-input-v1', panel: 'ef', kind: 'synthetic-fixture',
  records: [
    record('weather-full', 'weather', 30),
    record('finance-half', 'finance', 20),
    record('news-full', 'news', 180),
    { ...record('timestamp-missing', 'weather', 10),
      evidence: [{ evidenceId: 'missing-G1', rank: 1, relevant: true, provenanceStatus: 'missing' }] },
    record('reference-held', 'weather', 0, 'not_scored'),
  ],
};
const targets = Array.from({ length: 10 }, (_, index) => ({
  rank: index + 1, url: `https://publisher.example.com/science/article-${index + 1}`,
  aliases: [`https://publisher.example.com/science/article-${index + 1}`],
  title: `Synthetic article ${index + 1}`,
  publishedAt: new Date(Date.parse(at) - [10, 30, 60, 360, 1440, 10, 10, 10, 10, 10][index] * 60000).toISOString(),
  status: index === 9 ? 'provider-error' : 'captured',
  ...(index === 9 ? { reason: 'synthetic-provider-failure' } : { requestTime: at }),
  results: index % 2 === 0 ? [{ url: `https://publisher.example.com/science/article-${index + 1}`, content: 'Synthetic article text. '.repeat(5) }] : [],
}));
const fcd = {
  version: 'freshsearch-portable-input-v1', panel: 'fcd', kind: 'synthetic-fixture',
  episodes: [
    { id: 'synthetic-feed', providerId: 'fixture', eligible: true, targets },
    { id: 'held-feed', providerId: 'fixture', eligible: false, reason: 'synthetic-source-access-hold' },
  ],
};
for (const [name, value] of [['ef.json', ef], ['fcd.json', fcd]]) {
  fs.writeFileSync(path.join(__dirname, name), JSON.stringify(value, null, 2) + '\n');
}
console.log('Generated explicitly synthetic EF and FCD smoke inputs; no publisher/provider calls.');
