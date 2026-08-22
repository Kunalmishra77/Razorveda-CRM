import { readFileSync, writeFileSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';

/**
 * DOES THIS TEST ACTUALLY CATCH ANYTHING?
 *
 *   node scripts/mutation-check.mjs
 *
 * Two of this project's most serious defects were sitting behind tests that
 * passed:
 *
 *   The 50-row cap was never implemented. Its test ran
 *   `SELECT lead_id FROM lead LIMIT 51` and asserted the result was under 50 —
 *   true of the fixture, true forever, and true while a rep could pull 14,381
 *   phone numbers in one request.
 *
 *   A rep could mark her own order delivered and pay herself. Twenty-eight
 *   adversarial tests all asked "can rep A reach rep B's data?" and none asked
 *   whether she may do something illegitimate to her own.
 *
 * Adding more tests under the same conditions would not have found either. The
 * only way to know a test can fail is to make it fail: break the protection,
 * confirm the test goes red, put it back.
 *
 * A mutation that survives is not a passing test. It is a test that was never
 * testing anything, and it is worth more to know that than to have the green tick.
 *
 * KNOWN LIMITATION. The two API-dependent mutations report INCONCLUSIVE: this
 * script cannot reliably kill and restart the dev server from inside Node on
 * Windows, and a result taken against a server still running the OLD code proves
 * nothing. Both were verified by hand — edit the file, restart the API, run
 * `npm run test:rls -- adversarial`, and both mutations are CAUGHT. Fixing the
 * restart properly is worth doing; reporting an unverified pass is not.
 */

const MUTATIONS = [
  {
    name: 'remove the 50-row worklist cap',
    file: 'apps/api/src/worklist/worklist.controller.ts',
    from: '            LIMIT $1',
    to: '            LIMIT 100000',
    suite: 'rls',
    grep: 'adversarial',
    guards: 'a rep cannot exceed the 50-row cap',
    restartApi: true,
  },
  {
    name: 'let a rep make any status transition',
    file: 'apps/api/src/orders/status-machine.ts',
    from: '  if (to === \'CANCELLED\') return true;\n  return from === \'PENDING\' && to === \'CONFIRMED\';',
    to: '  return true;',
    suite: 'rls',
    grep: 'adversarial',
    guards: 'a rep cannot pay herself',
    restartApi: true,
  },
  {
    name: 'count VIEW events toward the copy-velocity lock',
    file: 'apps/api/src/security/velocity.ts',
    from: "e.action === 'COPY' &&",
    to: '',
    suite: 'unit',
    grep: 'velocity',
    guards: 'a VIEW never counts',
  },
  {
    name: 'let a clawback be recomputed rather than negated',
    file: 'apps/api/src/orders/status-machine.ts',
    from: "  if (from === 'DELIVERED' && (to === 'RTO' || to === 'RETURNED')) return 'CLAWBACK';",
    to: "  if (to === 'RTO' || to === 'RETURNED') return 'CLAWBACK';",
    suite: 'unit',
    grep: 'ledger-invariants',
    guards: 'a straight-to-RTO order writes no clawback',
  },
  {
    name: 'drop the incentive slab-gap check',
    file: 'apps/api/src/master/slab-rules.ts',
    from: '    if (Number(upper) !== Number(sorted[i + 1]!.minValue)) {',
    to: '    if (false) {',
    suite: 'unit',
    grep: 'slab-rules',
    file2: 'apps/api/src/master/slab-rules.ts',
    guards: 'the gap check — the rule the mutation check found untested',
  },
  {
    name: 'round money twice instead of once',
    file: 'apps/api/src/incentive/incentive.ts',
    from: "  const beforeBonus = scaleMoney(base, [effectivePercent, '0.01', multiplier]);",
    to: "  const beforeBonus = scaleMoney(scaleMoney(base, [effectivePercent, '0.01']), [multiplier]);",
    suite: 'unit',
    grep: 'incentive',
    guards: 'catches a double round inside the engine itself',
  },
];

const API = 'http://localhost:3001';

// No `shell: true`. Passing a bash -c invocation THROUGH another shell mangles
// the quoting, and the first version of this harness reported all six mutations
// as surviving — including two I knew were covered. An audit tool that cannot
// fail honestly is the exact thing it was written to find.
const run = (cmd, args, cwd) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy() {
  try {
    return (await fetch(`${API}/health`, { signal: AbortSignal.timeout(1200) })).ok;
  } catch {
    return false;
  }
}

/**
 * Wait for the port to go QUIET before waiting for it to come back.
 *
 * The first version only waited for /health to answer — and the old process was
 * still holding the port, so it answered immediately with UNMUTATED code. Every
 * API-dependent mutation was then reported as SURVIVED: "this protection has no
 * test", about tests that catch it perfectly well when run by hand.
 *
 * A false "you have no coverage" is the more dangerous direction. It invites
 * someone to write a redundant test, or to stop trusting a good one.
 */
async function apiRestarted() {
  for (let i = 0; i < 40 && (await healthy()); i += 1) await sleep(250);
  if (await healthy()) return false;      // the old process never died
  for (let i = 0; i < 60; i += 1) {
    if (await healthy()) return true;
    await sleep(700);
  }
  return false;
}

function restartApi() {
  try {
    const out = execSync('netstat -ano | grep ":3001" | grep LISTENING', { encoding: 'utf8', shell: 'bash' });
    for (const pid of new Set(out.trim().split('\n').map((l) => l.trim().split(/\s+/).pop()))) {
      try { execSync(`taskkill //F //PID ${pid}`, { stdio: 'ignore' }); } catch { /* gone */ }
    }
  } catch { /* nothing listening */ }
  spawnSync('bash', ['-c',
    'cd apps/api && DATABASE_URL_APP="postgresql://razorveda_app:localdev@127.0.0.1:5433/razorveda" ' +
    'JWT_SECRET="a-very-long-development-only-jwt-secret-value-32plus" RATE_LIMIT_DISABLED=1 ' +
    'nohup node ../../node_modules/tsx/dist/cli.mjs src/main.ts > /tmp/mutation-api.log 2>&1 &'],
    { stdio: 'ignore' });
}

function testsPass(mutation) {
  const args = mutation.suite === 'rls'
    ? ['../../node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.rls.config.ts', mutation.grep]
    : ['../../node_modules/vitest/vitest.mjs', 'run', mutation.grep];
  const env = mutation.suite === 'rls'
    ? 'DATABASE_URL="postgresql://razorveda_migrator:localdev@127.0.0.1:5433/razorveda" '
    : '';
  const result = run('bash', ['-c', `cd apps/api && ${env}node ${args.join(' ')}`], process.cwd());

  // The EXIT CODE, not the output. Vitest exits non-zero when a test fails and
  // when no test file matches — and "no file matched" must count as a failure to
  // notice, not as a pass, or a typo in the grep silently clears every mutation.
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (/No test files found/i.test(output)) {
    throw new Error(`no test file matched "${mutation.grep}" — the mutation was never exercised`);
  }
  return result.status === 0;
}

async function main() {
  console.log('mutation check — break the protection, confirm the test notices\n');
  const results = [];

  for (const mutation of MUTATIONS) {
    const original = readFileSync(mutation.file, 'utf8');
    if (!original.includes(mutation.from)) {
      console.log(`  SKIP     ${mutation.name}\n           anchor not found — the source has moved on\n`);
      results.push({ ...mutation, verdict: 'SKIP' });
      continue;
    }

    try {
      writeFileSync(mutation.file, original.replace(mutation.from, mutation.to), 'utf8');
      let inconclusive = false;
      if (mutation.restartApi) {
        restartApi();
        // If the restart cannot be confirmed the result means nothing, and saying
        // so is the only honest option. INCONCLUSIVE, never SURVIVED.
        if (!(await apiRestarted())) inconclusive = true;
      }

      const survived = inconclusive ? false : testsPass(mutation);
      const verdict = inconclusive ? 'INCONCLUSIVE' : survived ? 'SURVIVED' : 'CAUGHT';
      console.log(`  ${verdict.padEnd(12)} ${mutation.name}`);
      console.log(`           guarded by: ${mutation.guards}`);
      if (verdict === 'SURVIVED') {
        console.log('           ^ nothing failed. That protection is not covered by a test.');
      }
      if (verdict === 'INCONCLUSIVE') {
        console.log('           ^ the API could not be confirmed restarted, so this proves nothing.');
      }
      console.log();
      results.push({ ...mutation, verdict });
    } finally {
      // Always, including on a thrown error. A mutation left in the tree is a
      // deliberately introduced bug, which is a considerably worse outcome than
      // an unfinished audit.
      writeFileSync(mutation.file, original, 'utf8');
    }
  }

  if (MUTATIONS.some((m) => m.restartApi)) {
    restartApi();
    await apiRestarted();
  }

  const survived = results.filter((r) => r.verdict === 'SURVIVED');
  console.log(
    `${results.filter((r) => r.verdict === 'CAUGHT').length} caught, ${survived.length} survived, ` +
    `${results.filter((r) => r.verdict === 'INCONCLUSIVE').length} inconclusive, ` +
    `${results.filter((r) => r.verdict === 'SKIP').length} skipped`,
  );

  // Verify the tree is clean, because the whole exercise edits source files.
  const dirty = run('git', ['status', '--porcelain', '--', ...MUTATIONS.map((m) => m.file)], process.cwd());
  console.log(dirty.stdout?.trim()
    ? `\nWARNING — files still modified:\n${dirty.stdout}`
    : '\nAll mutated files restored to their committed state.');
}

main().catch((e) => {
  console.error(`\nmutation check failed: ${e.message}`);
  console.error('Run `git status` and restore any modified source file before continuing.');
  process.exitCode = 1;
});
