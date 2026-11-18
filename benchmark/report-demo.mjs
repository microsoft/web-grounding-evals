// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { main as run } from './run.mjs';
import { main as report } from './report.mjs';
import { runCli } from './cli.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    out: { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage: node report-demo.mjs --out NEW_DIRECTORY\nBuilds a clearly synthetic offline demo report; no provider, publisher or judge calls are made.');
    return;
  }
  if (!values.out) throw new Error('Require --out NEW_DIRECTORY for the clearly synthetic offline demo');
  const out = path.resolve(values.out);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(out);
  const folders = [];
  const source = JSON.parse(await fs.readFile(path.join(root, 'examples/fcd.json'), 'utf8'));
  for (const [index, name] of ['atlas', 'birch', 'coral'].entries()) {
    const input = structuredClone(source);
    for (const episode of input.episodes) {
      episode.providerId = `synthetic-${name}`;
      // Illustrative variations of the bundled synthetic capture, not provider measurements.
      for (const target of episode.targets ?? []) {
        if (index > 0 && target.status === 'captured' && target.rank <= index * 2) target.results = [];
      }
    }
    const filename = path.join(out, `synthetic-${name}-input.json`);
    await fs.writeFile(filename, JSON.stringify(input, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const folder = path.join(out, `synthetic-${name}-fcd`);
    await run(['--panel', 'fcd', '--input', filename, '--out', folder]);
    folders.push(folder);
  }
  const efFolder = path.join(out, 'synthetic-ef');
  await run(['--panel', 'ef', '--input', path.join(root, 'examples/ef.json'), '--out', efFolder]);
  folders.push(efFolder);
  const replay = path.join(out, 'synthetic-atlas-replay');
  await fs.mkdir(replay);
  await fs.copyFile(path.join(folders[0], 'results.json'), path.join(replay, 'results.json'));
  folders.push(replay);
  const failed = path.join(out, 'synthetic-interrupted');
  await fs.mkdir(failed);
  await fs.writeFile(path.join(failed, 'failure.json'), JSON.stringify({ status: 'failed' }));
  folders.push(failed);
  return report([...folders.flatMap(folder => ['--run', folder]), '--out', path.join(out, 'results.html')], {
    diagnostic: message => message.startsWith('Failure receipt present.') ?
      'Synthetic failure receipt (demo; no calls were made).' : message,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(main);
}
