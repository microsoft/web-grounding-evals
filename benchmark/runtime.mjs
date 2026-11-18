// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ensure } from './trace.mjs';

export const supportedNodeRange = '^22.0.0 || ^24.0.0 || ^26.0.0';

export function runtimeIdentity(versions = process.versions) {
  ensure(/^(?:22|24|26)\.\d+\.\d+$/u.test(versions.node ?? '') &&
    typeof versions.icu === 'string' && /^\d+(?:\.\d+)*$/u.test(versions.icu) &&
    typeof versions.tz === 'string' && /^\d{4}[a-z]$/u.test(versions.tz),
  'FreshSearch requires Node 22, 24 or 26 with ICU and timezone data');
  return { node: `v${versions.node}`, icu: versions.icu, timeZoneData: versions.tz };
}

export function assertRuntimeSupport() {
  runtimeIdentity();
  for (const [time, zone, expected] of [
    ['2026-01-15T17:00:00Z', 'America/New_York', '12:00'],
    ['2026-07-15T17:00:00Z', 'America/New_York', '13:00'],
    ['2026-03-08T06:59:00Z', 'America/New_York', '01:59'],
    ['2026-03-08T07:00:00Z', 'America/New_York', '03:00'],
    ['2026-11-01T05:30:00Z', 'America/New_York', '01:30'],
    ['2026-11-01T06:30:00Z', 'America/New_York', '01:30'],
    ['2026-07-15T12:00:00Z', 'Asia/Kolkata', '17:30'],
  ]) {
    const actual = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(time));
    ensure(actual === expected, `Timezone conformance failed for ${zone} at ${time}`);
  }
}
