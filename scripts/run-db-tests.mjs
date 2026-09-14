#!/usr/bin/env node
// Runs the persistent SQL regression suite in supabase/tests/ against the
// local Supabase Postgres instance (see docs/db-testing.md). Invoked via
// `npm run test:db`. Does NOT reset the database itself -- run
// `npm run db:reset:test` (or `npx supabase db reset`) first so the suite
// runs against the current migrations, not stale state.
//
// Each *.sql file in supabase/tests/ (excluding the "_"-prefixed shared
// _harness.sql/_fixtures.sql/_epilogue.sql) is one independently-runnable
// test group: harness + fixtures + that file + epilogue are concatenated
// into a single psql script, executed inside one BEGIN/ROLLBACK, so
// nothing a group does ever persists -- pass or fail. Groups run in their
// own transaction each, so a bug in one group's fixtures can't cascade
// into "transaction aborted" noise for every other group.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.join(__dirname, '..', 'supabase', 'tests');

function findDbContainer() {
  let out;
  try {
    out = execFileSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' });
  } catch (err) {
    console.error('Could not run `docker ps` -- is Docker running?');
    console.error(err.message);
    process.exit(1);
  }
  const name = out.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  if (!name) {
    console.error('No running local Supabase database container found (looked for a container named "*supabase_db*").');
    console.error('Start it first, e.g.: npm run db:reset:test   (or: npx supabase start)');
    process.exit(1);
  }
  return name;
}

function readGroupFiles() {
  return readdirSync(testsDir)
    .filter((f) => f.endsWith('.sql') && !f.startsWith('_'))
    .sort();
}

function runFile(container, harness, fixtures, epilogue, fileName) {
  const body = readFileSync(path.join(testsDir, fileName), 'utf8');
  const script = [harness, fixtures, body, epilogue].join('\n');

  let stdout = '';
  let ranCleanly = true;
  try {
    stdout = execFileSync(
      'docker',
      ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-q'],
      { input: script, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
  } catch (err) {
    ranCleanly = false;
    stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }

  const lines = stdout.split('\n');
  const summaryLine = lines.find((l) => l.startsWith('__DBTEST_SUMMARY__'));
  const failLines = lines.filter((l) => l.startsWith('__DBTEST_FAIL__'));

  if (!ranCleanly || !summaryLine) {
    return { fileName, hardError: true, passed: 0, failed: 0, total: 0, failLines: [], tail: lines.filter(Boolean).slice(-25) };
  }

  const parts = summaryLine.replace('__DBTEST_SUMMARY__ ', '').trim().split(/\s+/).map(Number);
  const [passed, failed, total] = parts;
  return {
    fileName,
    hardError: false,
    passed,
    failed,
    total,
    failLines: failLines.map((l) => l.replace('__DBTEST_FAIL__ ', '')),
    tail: [],
  };
}

function main() {
  const container = findDbContainer();
  const harness = readFileSync(path.join(testsDir, '_harness.sql'), 'utf8');
  const fixtures = readFileSync(path.join(testsDir, '_fixtures.sql'), 'utf8');
  const epilogue = readFileSync(path.join(testsDir, '_epilogue.sql'), 'utf8');
  const groupFiles = readGroupFiles();

  if (groupFiles.length === 0) {
    console.error(`No test-group files found in ${testsDir}`);
    process.exit(1);
  }

  console.log(`Running ${groupFiles.length} DB regression test group(s) against container "${container}"...\n`);

  let totalPassed = 0;
  let totalFailed = 0;
  let anyHardError = false;

  for (const fileName of groupFiles) {
    const result = runFile(container, harness, fixtures, epilogue, fileName);

    if (result.hardError) {
      anyHardError = true;
      console.log(`✗ ${fileName}: FAILED TO RUN (a statement errored outside an expect_error/expect_true wrapper)`);
      console.log(result.tail.map((l) => `    ${l}`).join('\n'));
      continue;
    }

    totalPassed += result.passed;
    totalFailed += result.failed;
    const icon = result.failed === 0 ? '✓' : '✗';
    console.log(`${icon} ${fileName}: ${result.passed}/${result.total} passed`);
    for (const line of result.failLines) {
      console.log(`    FAIL: ${line}`);
    }
  }

  const grandTotal = totalPassed + totalFailed;
  console.log(`\nTOTAL: ${totalPassed} passed, ${totalFailed} failed, ${grandTotal} assertion(s) across ${groupFiles.length} file(s).`);

  if (anyHardError || totalFailed > 0) {
    process.exit(1);
  }
}

main();
