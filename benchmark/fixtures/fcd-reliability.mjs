// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export function fcdReliabilityFixture({ allUnavailable = false } = {}) {
  const referenceAsOf = '2026-01-01T12:00:00.000Z';
  const statuses = ['captured', 'provider-error', 'capture-unknown', 'access-held',
    'captured', 'captured', 'captured', 'captured', 'captured', 'captured'];
  const targets = statuses.map((original, index) => {
    const url = `https://publisher.example.com/item-${index + 1}`;
    const status = allUnavailable ? 'capture-unknown' : original;
    return {
      rank: index + 1, url, aliases: [url], title: `Synthetic article ${index + 1}`,
      publishedAt: index < 2 ? '2026-01-01T11:31:00.000Z' : '2026-01-01T10:59:00.000Z',
      status,
      ...(status === 'captured' ? {
        requestTime: '2026-01-01T12:02:00.000Z',
        results: index === 0 ? [{ url, content: 'Synthetic article.' }] : [],
      } : { reason: 'synthetic-unavailable', results: [] }),
    };
  });
  return {
    version: 'freshsearch-fcd-capture-v1', panel: 'fcd', kind: 'synthetic-fixture',
    episodes: [{ id: 'synthetic-feed', providerId: 'fixture', eligible: true, referenceAsOf, targets }],
  };
}
