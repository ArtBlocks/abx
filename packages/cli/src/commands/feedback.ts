import {readFileSync} from 'node:fs';
import {
  ABX_FEEDBACK_AREAS,
  AbxServiceClient,
  FEEDBACK_KINDS,
  FEEDBACK_SEVERITIES,
  SERVICE_FEEDBACK_INTERFACE,
  type FeedbackContext,
  type FeedbackKind,
  type FeedbackReport,
  type FeedbackSeverity,
} from '@artblocks/abx-sdk';
import {type Flags} from '../flags.js';
import {bold, dim, info, ok} from '../output.js';
import {
  ABX_SERVICES_URL,
  requireRemoteToken,
  resolveRemote,
  serviceClient,
  type RemoteTarget,
} from '../remote.js';
import {readCliVersion} from '../update-check.js';

interface FeedbackTarget {
  kind: 'abx' | 'service';
  label: string;
  endpoint: string;
  remote: RemoteTarget;
  client: AbxServiceClient;
}

function value(flags: Flags, key: string): string | undefined {
  const raw = flags[key];
  return typeof raw === 'string' && raw !== 'true' ? raw : undefined;
}

function oneOf<T extends string>(raw: string | undefined, choices: readonly T[], flag: string): T | undefined {
  if (raw === undefined) return undefined;
  if (choices.includes(raw as T)) return raw as T;
  throw new Error(`${flag} must be one of: ${choices.join(', ')}`);
}

function jsonObject(text: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${source} must contain valid JSON`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${source} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function fileOrFlag(flags: Flags, flag: string, fileFlag: string): string | undefined {
  const direct = value(flags, flag);
  const path = value(flags, fileFlag);
  if (direct && path) throw new Error(`use --${flag} or --${fileFlag}, not both`);
  return path ? readFileSync(path, 'utf8') : direct;
}

/** Pure report construction: validate locally so a preview is the exact body that --yes sends. */
export function buildFeedbackReport(flags: Flags, target: 'abx' | 'service'): FeedbackReport | null {
  const summary = value(flags, 'summary');
  if (!summary) return null;
  const kind = oneOf(value(flags, 'kind'), FEEDBACK_KINDS, '--kind');
  if (!kind) throw new Error(`--kind is required with --summary (${FEEDBACK_KINDS.join(', ')})`);
  const severity = oneOf(value(flags, 'severity'), FEEDBACK_SEVERITIES, '--severity');
  const via = oneOf(value(flags, 'via'), ['agent', 'human'] as const, '--via');
  const detail = fileOrFlag(flags, 'detail', 'detail-file');
  const contextRaw = fileOrFlag(flags, 'context', 'context-file');
  const context: FeedbackContext = {
    ...(contextRaw ? jsonObject(contextRaw, value(flags, 'context-file') ? '--context-file' : '--context') : {}),
    cliVersion: readCliVersion(),
  };
  const shared = {kind: kind as FeedbackKind, summary, detail, severity: severity as FeedbackSeverity | undefined, via, context};

  if (target === 'abx') {
    if (value(flags, 'component')) throw new Error('--component is for --remote provider feedback; use --area for core ABX');
    const area = oneOf(value(flags, 'area'), ABX_FEEDBACK_AREAS, '--area');
    if (!area) throw new Error(`--area is required for core ABX feedback (${ABX_FEEDBACK_AREAS.join(', ')})`);
    return {area, ...shared};
  }
  if (value(flags, 'area')) throw new Error('--area is for core ABX feedback; use --component with --remote');
  return {component: value(flags, 'component'), ...shared};
}

async function targetFor(flags: Flags, env: NodeJS.ProcessEnv = process.env): Promise<FeedbackTarget> {
  const tokenFlag = value(flags, 'remote-token');
  if (flags.remote === undefined) {
    const remote = resolveRemote('abx', tokenFlag, env)!;
    return {
      kind: 'abx',
      label: 'core ABX',
      endpoint: `${ABX_SERVICES_URL}/abx/feedback`,
      remote,
      // The generic SDK feedback paths become /abx/feedback and /abx/feedback/mine.
      client: new AbxServiceClient({baseUrl: `${ABX_SERVICES_URL}/abx`, token: remote.token}),
    };
  }

  const remote = resolveRemote(String(flags.remote), tokenFlag, env);
  if (!remote) throw new Error('--remote needs a provider name or URL');
  const client = serviceClient(remote);
  const descriptor = await client.descriptor();
  if (!descriptor.interfaces?.includes(SERVICE_FEEDBACK_INTERFACE)) {
    throw new Error(
      `${remote.url} does not declare ${SERVICE_FEEDBACK_INTERFACE}; provider feedback is not supported there. ` +
        `Core ABX feedback is the default: run abx feedback without --remote.`,
    );
  }
  return {kind: 'service', label: `provider ${remote.name?.toLowerCase() ?? remote.url}`, endpoint: `${remote.url}/feedback`, remote, client};
}

/** Core ABX by default; `--remote <provider>` switches to that provider's standard feedback path. */
export async function cmdFeedback(flags: Flags): Promise<void> {
  const target = await targetFor(flags);
  const report = buildFeedbackReport(flags, target.kind);
  const mine = flags.mine !== undefined;
  const json = flags.json !== undefined;

  if (mine && report) throw new Error('--mine cannot be combined with --summary');
  if (mine) {
    requireRemoteToken(target.remote);
    const limitRaw = value(flags, 'limit');
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error('--limit must be a positive integer');
    const rows = await target.client.listFeedback({
      area: target.kind === 'abx' ? value(flags, 'area') : undefined,
      component: target.kind === 'service' ? value(flags, 'component') : undefined,
      kind: oneOf(value(flags, 'kind'), FEEDBACK_KINDS, '--kind'),
      limit,
    });
    if (json) console.log(JSON.stringify({target: target.kind, feedback: rows}, null, 2));
    else {
      console.log(`\n  ${bold(`${target.label} feedback`)}  ${dim(`${rows.length} report(s)`)}`);
      for (const row of rows) console.log(`    ${row.id}  ${row.kind}  ${row.summary}`);
      console.log('');
    }
    return;
  }

  if (!report) {
    const instructions = await target.client.feedbackInstructions();
    if (json) console.log(JSON.stringify(instructions, null, 2));
    else console.log(`\n${JSON.stringify(instructions, null, 2)}\n`);
    return;
  }

  if (flags.yes === undefined) {
    const preview = {submitted: false, target: target.kind, endpoint: target.endpoint, report};
    if (json) console.log(JSON.stringify(preview, null, 2));
    else {
      console.log(`\n  ${bold('feedback preview')}  ${dim(`→ ${target.endpoint}`)}`);
      console.log(JSON.stringify(report, null, 2));
      info('Report content not sent. Review/redact it, obtain human approval, then re-run with --yes.');
      console.log('');
    }
    return;
  }

  requireRemoteToken(target.remote);
  const result = await target.client.submitFeedback(report);
  if (json) console.log(JSON.stringify({submitted: true, target: target.kind, ...result}, null, 2));
  else ok(`${target.label} feedback recorded (${result.id})`);
}
