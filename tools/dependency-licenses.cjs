// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
const read = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

function generate(root) {
  const bundles = [
    { file: 'benchmark/freshsearch.cjs', build: read(root, 'benchmark/build-manifest.json') },
    { file: 'benchmark/freshsearch-confirmed-clock.cjs',
      build: read(root, 'benchmark/confirmed-clock-build-manifest.json') },
    { file: 'benchmark/providers/normalization.cjs',
      build: { ...read(root, 'benchmark/confirmed-clock-build-manifest.json'),
        outputSha256: read(root, 'benchmark/confirmed-clock-build-manifest.json').providerOutputSha256 } },
  ].map(({ file, build }) => {
    const outputSha256 = digest(fs.readFileSync(path.join(root, file)));
    if (outputSha256 !== build.outputSha256) throw new Error(`Scorer bundle hash mismatch: ${file}`);
    return { file, outputSha256, bundledPackages: build.bundledPackages };
  });
  const sources = read(root, 'docs/dependency-license-sources.json');
  const sourceByPackage = new Map();
  for (const source of sources) {
    const bytes = Buffer.from(source.text);
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (blob !== source.blobSha) throw new Error(`License source text drift: ${source.name}@${source.version}`);
    const key = `${source.name}@${source.version}`;
    if (sourceByPackage.has(key)) throw new Error(`Duplicate license source: ${key}`);
    sourceByPackage.set(key, source);
  }
  const packageByKey = new Map();
  for (const bundle of bundles) for (const item of bundle.bundledPackages) {
    const key = `${item.name}@${item.version}`;
    const previous = packageByKey.get(key);
    if (previous && previous.license !== item.license) throw new Error(`Conflicting bundled license: ${key}`);
    packageByKey.set(key, item);
  }
  const packages = [...packageByKey.values()].map(item => {
    const key = `${item.name}@${item.version}`;
    const source = sourceByPackage.get(key);
    if (!source || source.license !== item.license) throw new Error(`Missing or mismatched bundled notice: ${key}`);
    sourceByPackage.delete(key);
    return { ...item, licenseSourceBlob: source.blobSha, detectedLicense: source.detectedLicense };
  });
  if (sourceByPackage.size) throw new Error('License sources must describe exactly the bundled package versions');
  const inventory = { schemaVersion: 2, bundles: bundles.map(({ file, outputSha256 }) => ({
    file, outputSha256,
  })), packages };
  let notice = 'Third-party notices\n===================\n\n' +
    'The following package versions are embedded in the benchmark scorer and adapter bundles.\n' +
    'Their original copyright and license terms are reproduced below. Microsoft\n' +
    'source headers do not replace these third-party licenses.\n\n';
  for (const source of [...sources].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'))) {
    notice += `${source.name}@${source.version} (package-declared license: ${source.license})\n` +
      `Source: ${source.url}\nLicense blob: ${source.blobSha}\n\n${source.text.trimEnd()}\n\n` +
      '------------------------------------------------------------------------\n\n';
  }
  notice = notice.replace(/[ \t]+$/gm, '').trimEnd() + '\n';
  return { inventory: JSON.stringify(inventory, null, 2) + '\n', notice };
}

if (require.main === module) {
  const mode = process.argv.slice(2);
  if (mode.length !== 1 || !['--check', '--write'].includes(mode[0])) {
    throw new Error('Usage: node tools/dependency-licenses.cjs --check|--write');
  }
  const root = path.resolve(__dirname, '..');
  const output = generate(root);
  for (const [file, text] of [
    ['docs/dependency-license-inventory.json', output.inventory], ['NOTICE', output.notice],
  ]) {
    if (mode[0] === '--write') fs.writeFileSync(path.join(root, file), text);
    else if (!fs.existsSync(path.join(root, file)) || fs.readFileSync(path.join(root, file), 'utf8') !== text) {
      throw new Error(`Stale license artifact: ${file}; regenerate with --write`);
    }
  }
  console.log('PASS: bundled dependency metadata and notices are consistent.');
}

module.exports = { generate };
