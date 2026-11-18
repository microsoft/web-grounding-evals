// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: node clean-smoke.cjs [--evidence-dir <new-directory>]');
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== '--evidence-dir')) {
  console.error('Usage: node clean-smoke.cjs [--evidence-dir <new-directory>]');
  process.exit(1);
}
// Dynamic import keeps ESM loading off require(), which is experimental before Node 22.12.
import('./runtime.mjs').then(({ assertRuntimeSupport }) => {
  assertRuntimeSupport();
  runCleanSmoke();
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
function runCleanSmoke() {
  const evidenceDirectory = args.length ? path.resolve(args[1]) : null;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freshsearch-clean-smoke-'));
  const bundle = path.join(directory, 'benchmark');
  function run(args, timeout = 60000) {
    const result = cp.spawnSync(process.execPath, args, {
      cwd: bundle, encoding: 'utf8', timeout,
      env: { ...process.env, NODE_PATH: '', TMPDIR: directory, TMP: directory, TEMP: directory },
    });
    if (result.error) {
      throw new Error(`Clean smoke command failed: ${args.join(' ')}\n${result.error.message}\n${result.stdout}\n${result.stderr}`,
        { cause: result.error });
    }
    if (result.status !== 0) throw new Error(`Clean smoke command failed: ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  }
  let primaryFailure;
  try {
    if (args.length) fs.mkdirSync(evidenceDirectory);
    fs.mkdirSync(bundle);
    for (const name of fs.readdirSync(__dirname)) {
      if (/^(node_modules|local-runs|\.clean-smoke-.*)$/.test(name)) continue;
      fs.cpSync(path.join(__dirname, name), path.join(bundle, name), {
        recursive: true,
        filter: filename => !/(^|[\\/])(node_modules|local-runs)([\\/]|$)/.test(filename),
      });
    }
    const installArgs = ['ci', '--ignore-scripts', '--no-audit', '--no-fund'];
    let installCommand = 'npm';
    if (process.platform === 'win32') {
      const npmCli = process.env.npm_execpath
        || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!fs.existsSync(npmCli)) throw new Error('Cannot locate npm CLI; invoke clean smoke through npm run smoke:clean.');
      installCommand = process.execPath;
      installArgs.unshift(npmCli);
    }
    const install = cp.spawnSync(installCommand, installArgs, {
      cwd: bundle, encoding: 'utf8', timeout: 600000,
    });
    if (install.error) throw install.error;
    if (install.status !== 0) throw new Error(`Clean install failed: ${install.stderr}`);
    const testCommand = ['--test', '--test-concurrency=1', '--test-reporter=tap', 'runner.test.mjs', 'providers/providers.test.mjs', 'report.test.mjs', 'trace.test.mjs', 'ef.test.mjs', 'ef-clock.test.mjs', 'evaluate.test.mjs', 'fcd-parity.test.mjs'];
    const testOutput = run(testCommand, 600000);
    const passed = testOutput.match(/^# pass (\d+)$/m);
    if (!passed) throw new Error('Clean smoke test runner did not report its passing test count');
    for (const panel of ['ef', 'fcd']) {
      run(['run.mjs', '--panel', panel, '--input', `examples/${panel}.json`, '--out', `local-runs/${panel}`]);
      const report = JSON.parse(fs.readFileSync(path.join(bundle, 'local-runs', panel, 'results.json'), 'utf8'));
      const expected = panel === 'ef' ? 62.5 : 100 * 51 / 93;
      if (Math.abs(report.summary[0].score - expected) > 1e-12) throw new Error(`${panel} score mismatch`);
      const example = {
        version: report.version, panel, kind: report.kind,
        source: report.source,
        policy: report.policy, summary: report.summary, cases: report.cases,
      };
      assert.deepEqual(example, JSON.parse(fs.readFileSync(
        path.join(bundle, 'examples', `${panel}-results.json`), 'utf8',
      )), `${panel} fixture report changed`);
      run(['run.mjs', '--panel', panel, '--input', `local-runs/${panel}/capture.json`,
        '--out', `local-runs/${panel}-replay`]);
      for (const name of ['capture.json', 'results.json', 'cases.csv', 'issues.csv']) {
        const original = fs.readFileSync(path.join(bundle, 'local-runs', panel, name));
        const replay = fs.readFileSync(path.join(bundle, 'local-runs', `${panel}-replay`, name));
        assert.ok(original.length > 0, `${panel} ${name} missing`);
        assert.deepEqual(replay, original, `${panel} replay ${name} changed`);
      }
      if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, `${panel}-results.json`), JSON.stringify(example, null, 2) + '\n');
    }
    run(['report.mjs', '--run', 'local-runs/fcd', '--run', 'local-runs/ef', '--out', 'local-runs/report.html']);
    if (!fs.readFileSync(path.join(bundle, 'local-runs/report.html'), 'utf8').includes('freshsearch-viewer-v1')) {
      throw new Error('Offline viewer was not generated');
    }
    if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, 'validation-results.json'), JSON.stringify({
      verifiedAt: new Date().toISOString(),
      scorerSha256: require('./build-manifest.json').outputSha256,
      cleanEnvironment: 'Temporary standalone copy with no node_modules or NODE_PATH',
      cleanInstallCommand: 'npm ci --ignore-scripts --no-audit --no-fund',
      testCommand: `node ${testCommand.join(' ')}`,
      testsPassed: Number(passed[1]),
      efScore: 62.5, fcdEarnedPoints: 51, fcdPossiblePoints: 93,
      fcdScore: 100 * 51 / 93,
      exactOutputs: ['capture.json', 'results.json', 'cases.csv', 'issues.csv'],
      fixtureReportsUnchanged: true, byteIdenticalReplay: true,
      viewerOutput: 'local-runs/report.html',
      liveProviderCalls: 0, liveJudgeCalls: 0, publisherRequests: 0,
    }, null, 2) + '\n');
    console.log(`PASS: ${passed[1]} offline tests; dependency-free clean-copy EF/FCD smoke, unchanged fixture reports, byte-identical replay and offline viewer.`);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      if (!primaryFailure) throw error;
      console.error(`Clean smoke cleanup also failed for ${directory}: ${error.message}`);
    }
  }
}
