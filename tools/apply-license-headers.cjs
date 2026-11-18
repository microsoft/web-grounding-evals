// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const fs = require('node:fs');
const path = require('node:path');

const BUNDLE_BANNER = '// Copyright (c) Microsoft Corporation.\n' +
  '// Microsoft-authored portions are licensed under the MIT license.\n' +
  '// Third-party components retain their licenses; see ../NOTICE.';
const SOURCE = /\.(?:[cm]?js|tsx?|jsx|py|ps1|sh|css|html)$/;

function withHeader(bytes, filename) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error(`Non-UTF-8 source: ${filename}`);
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = text.slice(bom.length);
  const opening = body.match(/^(?:(?:\s*\/\/[^\n]*(?:\n|$))|(?:\s*#[^\n]*(?:\n|$))|(?:\s*\/\*[\s\S]*?\*\/)|(?:\s*<!--[\s\S]*?-->))*/u)[0];
  if (/copyright|@license|SPDX-License-Identifier|licensed under/i.test(opening)) return bytes;
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.match(/[^\n]*(?:\n|$)/g);
  let count = body.startsWith('#!') ? 1 : 0;
  if (filename.endsWith('.py')) {
    for (let i = 0; i < Math.min(2, lines.length); i++) {
      if (/^[ \t]*#.*?coding[:=][ \t]*[-\w.]+/.test(lines[i])) count = i + 1;
    }
  }
  const prefix = lines.slice(0, count).join('');
  const rest = body.slice(prefix.length);
  let header;
  if (['benchmark/freshsearch.cjs', 'benchmark/freshsearch-confirmed-clock.cjs'].includes(filename)) header = BUNDLE_BANNER;
  else {
    const marker = /\.(?:py|ps1|sh)$/.test(filename) ? '#' : '//';
    const notice = 'Copyright (c) Microsoft Corporation.';
    const license = 'Licensed under the MIT license.';
    header = filename.endsWith('.css') ? `/* ${notice}\n * ${license} */` :
      filename.endsWith('.html') ? `<!-- ${notice}\n${license} -->` :
      `${marker} ${notice}\n${marker} ${license}`;
  }
  header = header.replaceAll('\n', newline);
  return Buffer.from(bom + prefix + (prefix && !prefix.endsWith('\n') ? newline : '') +
    header + newline + newline + rest);
}

function sourceFiles(root) {
  const rules = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/)
    .filter(line => line && !line.startsWith('#')).map(line => {
      const negate = line.startsWith('!');
      const pattern = negate ? line.slice(1) : line;
      return { negate, directory: pattern.endsWith('/'), anchored: pattern.startsWith('/'),
        pattern: pattern.replace(/^\//, '').replace(/\/$/, '') };
    });
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name === '.git') continue;
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      let ignored = false;
      for (const rule of rules) {
        if (rule.directory && !entry.isDirectory()) continue;
        const candidate = rule.anchored || rule.pattern.includes('/') ? relative : entry.name;
        if (path.posix.matchesGlob(candidate, rule.pattern)) ignored = !rule.negate;
      }
      if (ignored) continue;
      if (entry.isSymbolicLink()) throw new Error(`Cannot inspect symbolic link: ${relative}`);
      if (entry.isDirectory()) walk(relative);
      else if (entry.isFile() && SOURCE.test(relative)) files.push(relative);
    }
  }
  walk('');
  return files;
}

function prepareHeaders(root, { write = false } = {}) {
  const changes = sourceFiles(root)
    .map(name => {
      const before = fs.readFileSync(path.join(root, name));
      const after = withHeader(before, name);
      return { name, before, after };
    }).filter(change => !change.before.equals(change.after));
  if (!write || !changes.length) return changes.map(({ name }) => name);

  if (changes.some(change => ['benchmark/freshsearch.cjs', 'benchmark/freshsearch-confirmed-clock.cjs'].includes(change.name)))
    throw new Error('The scorer bundle must not be modified by the header tool');
  for (const change of changes) fs.writeFileSync(path.join(root, change.name), change.after);
  return changes.map(({ name }) => name);
}

if (require.main === module) {
  const mode = process.argv.slice(2);
  if (mode.length !== 1 || !['--check', '--write'].includes(mode[0])) {
    throw new Error('Usage: node tools/apply-license-headers.cjs --check|--write');
  }
  const missing = prepareHeaders(path.resolve(__dirname, '..'), { write: mode[0] === '--write' });
  if (mode[0] === '--check' && missing.length) {
    console.error(`Missing source notices in ${missing.length} files:\n${missing.join('\n')}`);
    process.exitCode = 1;
  } else console.log(`PASS: ${mode[0] === '--write' ? `prepared ${missing.length}` : 'checked'} source notices.`);
}

module.exports = { BUNDLE_BANNER, withHeader, prepareHeaders };
