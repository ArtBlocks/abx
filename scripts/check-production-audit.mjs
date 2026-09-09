#!/usr/bin/env node
import {spawnSync} from 'node:child_process';

const accepted = new Map([
  [
    'GHSA-3gc7-fjrx-p6mg',
    {
      module: 'bigint-buffer',
      severity: 'high',
      path:
        'packages__storage-arweave>@ardrive/turbo-sdk>@solana/spl-token>@solana/buffer-layout-utils>bigint-buffer',
      reason:
        'no upstream fix; the affected toBigIntLE path belongs to Turbo\'s Solana support, while ABX restricts Turbo tokens to arweave or ethereum',
    },
  ],
  [
    'GHSA-848j-6mx2-7j84',
    {
      module: 'elliptic',
      severity: 'low',
      path:
        'packages__storage-arweave>@ardrive/turbo-sdk>@cosmjs/proto-signing>@cosmjs/crypto>elliptic',
      reason:
        'no upstream fix; ABX does not use Turbo\'s Cosmos/Kyve signing path',
    },
  ],
]);

/**
 * `pnpm audit` talks to npm's advisory endpoint, which does go down (observed 2026-09-04: the
 * endpoint socket-timed-out from both GitHub Actions and a dev machine for hours while plain
 * registry GETs answered in ~2s and npm's status page still read "All Systems Operational"). A
 * single attempt therefore turned every upstream blip into a red build on an otherwise clean tree.
 *
 * So: retry, but STILL FAIL CLOSED. Exhausting the retries exits non-zero, because "we could not
 * determine whether this tree has known vulnerabilities" is not the same claim as "this tree is
 * clean" and must never be reported as if it were. The retry only buys back the transient case.
 */
const ATTEMPT_BACKOFF_MS = [5_000, 20_000]; // tries: immediate, +5s, +20s

/** Sleep without going async — this script is spawnSync top to bottom, and Atomics.wait is the
 *  portable synchronous sleep (no shelling out to `sleep`, which isn't portable). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** One `pnpm audit --prod --json` attempt. Returns either a parsed report, or a `retryable`
 *  reason — every failure mode here (no stdout, unparseable output, an `error` field in place of
 *  advisories) is the shape an endpoint problem takes, none of them mean "vulnerability found". */
function attemptAudit() {
  const run = spawnSync('pnpm', ['audit', '--prod', '--json'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const raw = run.stdout?.trim();
  if (!raw) {
    return {reason: `no JSON output${run.stderr ? `: ${run.stderr.trim().slice(0, 500)}` : '.'}`};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {reason: `invalid JSON: ${raw.slice(0, 500)}`};
  }
  if (parsed.error || !parsed.advisories || typeof parsed.advisories !== 'object') {
    return {reason: parsed.error?.summary ?? parsed.error?.detail ?? parsed.error?.message ?? raw.slice(0, 500)};
  }
  return {report: parsed};
}

let report;
let lastReason;
for (let attempt = 0; attempt <= ATTEMPT_BACKOFF_MS.length; attempt++) {
  if (attempt > 0) {
    const wait = ATTEMPT_BACKOFF_MS[attempt - 1];
    console.error(`  advisory endpoint unavailable (${lastReason}) — retrying in ${wait / 1000}s (attempt ${attempt + 1}/${ATTEMPT_BACKOFF_MS.length + 1})`);
    sleepSync(wait);
  }
  const outcome = attemptAudit();
  if (outcome.report) {
    report = outcome.report;
    break;
  }
  lastReason = outcome.reason;
}

if (!report) {
  console.error('Production audit could not obtain a valid advisory report.');
  console.error(`Last failure after ${ATTEMPT_BACKOFF_MS.length + 1} attempts: ${lastReason}`);
  console.error(
    '\nThis is NOT a report of a known vulnerability — it means the advisory data could not be\n' +
      'fetched at all, so this tree is UNVERIFIED rather than clean. Failing closed on purpose.\n' +
      'If npm\'s advisory endpoint is down (check https://status.npmjs.org, and note it has read\n' +
      '"operational" during a real outage), re-run once it recovers rather than skipping the gate.',
  );
  process.exit(1);
}

const unexpected = [];
const seen = new Set();
for (const advisory of Object.values(report.advisories)) {
  const id = advisory.github_advisory_id;
  const rule = accepted.get(id);
  const paths = advisory.findings?.flatMap((finding) => finding.paths ?? []) ?? [];
  if (
    !rule ||
    advisory.module_name !== rule.module ||
    advisory.severity !== rule.severity ||
    paths.length !== 1 ||
    paths[0] !== rule.path
  ) {
    unexpected.push({
      id: id ?? String(advisory.id),
      module: advisory.module_name,
      severity: advisory.severity,
      paths,
      url: advisory.url,
    });
    continue;
  }
  seen.add(id);
  console.log(`  accepted ${id} (${rule.severity}, ${rule.module}) — ${rule.reason}`);
}

if (unexpected.length) {
  console.error('\n✗ unreviewed production dependency advisories:');
  for (const advisory of unexpected) {
    console.error(
      `- ${advisory.id} ${advisory.severity} ${advisory.module}` +
        `${advisory.url ? ` — ${advisory.url}` : ''}\n  ${advisory.paths.join('\n  ')}`,
    );
  }
  process.exit(1);
}

for (const id of accepted.keys()) {
  if (!seen.has(id)) console.log(`  clear ${id} — no longer present`);
}

console.log(
  `\n✓ production dependency audit clean (${seen.size} exact, documented no-fix acceptance${seen.size === 1 ? '' : 's'})`,
);
