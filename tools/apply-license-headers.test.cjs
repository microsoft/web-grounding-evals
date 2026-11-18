// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withHeader, prepareHeaders, BUNDLE_BANNER } = require('./apply-license-headers.cjs');

test('headers preserve original source bytes, BOM, line endings and executable prefixes', () => {
  for (const [file, text, prefix] of [
    ['example.mjs', 'export const value = 1;\n', ''],
    ['example.ts', '\uFEFFexport const value = 1;\r\n', '\uFEFF'],
    ['example.sh', '#!/bin/sh\nprintf hello\n', '#!/bin/sh\n'],
    ['example.py', '#!/usr/bin/env python3\n# coding: utf-8\nprint("hello")\n',
      '#!/usr/bin/env python3\n# coding: utf-8\n'],
    ['example.py', '# module\n# coding: latin-1\nprint("hello")\n',
      '# module\n# coding: latin-1\n'],
  ]) {
    const original = Buffer.from(text);
    const result = withHeader(original, file);
    assert.ok(result.toString().startsWith(prefix));
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const marker = /\.(py|sh)$/.test(file) ? '#' : '//';
    const inserted = `${marker} Copyright (c) Microsoft Corporation.${newline}` +
      `${marker} Licensed under the MIT license.${newline}${newline}`;
    assert.equal(result.toString(), prefix + inserted + text.slice(prefix.length));
    assert.deepEqual(withHeader(result, file), result);
  }
});

test('existing third-party notices are preserved; generated bundle separates ownership', () => {
  for (const text of [
    '// Copyright (c) Another author.\n// BSD-2-Clause\nexport const value=1;\n',
    '/* SPDX-License-Identifier: Apache-2.0 */\nexport const value=1;\n',
    '# Copyright (c) Another author.\n# coding: utf-8\nprint("hello")\n',
  ]) {
    const bytes = Buffer.from(text);
    assert.deepEqual(withHeader(bytes, 'example.ts'), bytes);
  }
  const body = Buffer.from('"use strict";\nexports.value = 1;\n');
  for (const file of ['benchmark/freshsearch.cjs', 'benchmark/freshsearch-confirmed-clock.cjs']) {
    assert.equal(withHeader(body, file).toString(), BUNDLE_BANNER + '\n\n' + body.toString());
  }
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshsearch-headers-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), value);
  };
  const source = 'export const value = 1;\n';
  write('source.ts', source);
  write('.gitignore', fs.readFileSync(path.join(__dirname, '..', '.gitignore')));
  return { root, write, source };
}

test('bulk application adds headers and is idempotent', t => {
  const { root } = fixture(t);
  assert.equal(prepareHeaders(root).length, 1);
  assert.equal(prepareHeaders(root, { write: true }).length, 1);
  const before = fs.readFileSync(path.join(root, 'source.ts'));
  assert.deepEqual(prepareHeaders(root, { write: true }), []);
  assert.deepEqual(fs.readFileSync(path.join(root, 'source.ts')), before);
});

test('checkout metadata does not change source checks; ignored artifacts stay excluded', t => {
  const { root, write } = fixture(t);
  for (const directory of ['node_modules', 'dist', 'coverage', '__pycache__', 'local-runs', 'captures']) {
    write(`${directory}/generated.js`, 'ignored\n');
    write(`nested/${directory}/generated.js`, 'ignored\n');
  }
  write('nested/source.js', 'export const value = 1;\n');
  const expected = ['nested/source.js', 'source.ts'];
  assert.deepEqual(prepareHeaders(root), expected);
  write('.git/metadata.js', 'not source\n');
  assert.deepEqual(prepareHeaders(root), expected);
  fs.rmSync(path.join(root, '.git'), { recursive: true });
  write('.git', 'gitdir: unavailable\n');
  assert.deepEqual(prepareHeaders(root), expected);
});

test('source inventory honors file patterns, negation and root-relative exclusions', t => {
  const { root, write } = fixture(t);
  fs.appendFileSync(path.join(root, '.gitignore'), '\n# Test patterns\n*.generated.js\n!keep.generated.js\n/root-only.js\nnested/private.js\n');
  write('skip.generated.js', 'ignored\n');
  write('nested/skip.generated.js', 'ignored\n');
  write('keep.generated.js', 'export const value = 1;\n');
  write('root-only.js', 'ignored\n');
  write('nested/root-only.js', 'export const value = 1;\n');
  write('nested/private.js', 'ignored\n');
  assert.deepEqual(prepareHeaders(root), ['keep.generated.js', 'nested/root-only.js', 'source.ts']);
});

test('refuses to modify the scorer bundle before changing any source', t => {
  const { root, write } = fixture(t);
  write('benchmark/freshsearch.cjs', '"use strict";\nexports.value = 1;\n');
  const bundle = fs.readFileSync(path.join(root, 'benchmark/freshsearch.cjs'));
  assert.throws(() => prepareHeaders(root, { write: true }), /bundle must not be modified/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'benchmark/freshsearch.cjs')), bundle);
  assert.equal(fs.readFileSync(path.join(root, 'source.ts'), 'utf8'), 'export const value = 1;\n');
});
