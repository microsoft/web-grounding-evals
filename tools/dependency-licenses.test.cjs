// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { generate } = require('./dependency-licenses.cjs');

test('generated NOTICE includes every versioned license without trailing whitespace', () => {
  const root = path.resolve(__dirname, '..');
  const { notice } = generate(root);
  const sources = JSON.parse(fs.readFileSync(path.join(root, 'docs/dependency-license-sources.json'), 'utf8'));
  for (const source of sources) {
    assert.ok(notice.includes(`${source.name}@${source.version}`));
    assert.ok(notice.includes(source.text.replace(/[ \t]+$/gm, '').trimEnd()));
  }
  assert.doesNotMatch(notice, /[ \t]+$/m);
  assert.ok(notice.endsWith('\n') && !notice.endsWith('\n\n'));
});

test('rejects bundle drift and missing or mismatched package notices', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshsearch-licenses-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['benchmark', 'benchmark/providers', 'docs']) fs.mkdirSync(path.join(root, directory));
  const repo = path.resolve(__dirname, '..');
  for (const file of ['benchmark/build-manifest.json', 'benchmark/freshsearch.cjs',
    'benchmark/confirmed-clock-build-manifest.json', 'benchmark/freshsearch-confirmed-clock.cjs',
    'benchmark/providers/normalization.cjs',
    'docs/dependency-license-sources.json'])
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  const manifestPath = path.join(root, 'benchmark/build-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  const legacyOnlyPackage = manifest.bundledPackages.find(item => item.name === 'parse5');
  legacyOnlyPackage.license = 'incorrect';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => generate(root), /Missing or mismatched bundled notice/);
  manifest.bundledPackages = manifest.bundledPackages.filter(item => item.name !== 'parse5');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => generate(root), /exactly the bundled package versions/);
  fs.appendFileSync(path.join(root, 'benchmark/freshsearch.cjs'), 'changed');
  assert.throws(() => generate(root), /bundle hash mismatch/);
});

test('rejects drift in confirmed-clock scorer and provider-normalization bundles', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshsearch-clock-licenses-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['benchmark', 'benchmark/providers', 'docs']) fs.mkdirSync(path.join(root, directory));
  const repo = path.resolve(__dirname, '..');
  for (const file of ['benchmark/build-manifest.json', 'benchmark/freshsearch.cjs',
    'benchmark/confirmed-clock-build-manifest.json', 'benchmark/freshsearch-confirmed-clock.cjs',
    'benchmark/providers/normalization.cjs',
    'docs/dependency-license-sources.json'])
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  for (const file of ['benchmark/freshsearch-confirmed-clock.cjs', 'benchmark/providers/normalization.cjs']) {
    const original = fs.readFileSync(path.join(root, file));
    fs.appendFileSync(path.join(root, file), 'changed');
    assert.throws(() => generate(root), /bundle hash mismatch/);
    fs.writeFileSync(path.join(root, file), original);
  }
});
