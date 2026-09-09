import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { randomBytes } from 'node:crypto'
import { parseEnvContent } from '@artblocks/abx-sdk/node'
import { type Flags, positionalArgs } from '../flags.js'
import {
  ABX_SERVICES_API_KEY_VAR,
  resolveRemote,
  type RemoteTarget
} from '../remote.js'
import { bold, dim, g, info, ok } from '../output.js'

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const DEVICE_CLIENT_ID = 'abx-cli'

interface OAuthMetadata {
  issuer: string
  device_authorization_endpoint?: string
  token_endpoint?: string
  revocation_endpoint?: string
  grant_types_supported?: string[]
}

interface DeviceAuthorizationResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval?: number
}

export interface DeviceLoginDeps {
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  openBrowser?: (url: string) => boolean
  line?: (message: string) => void
  warning?: (message: string) => void
}

export interface DeviceLoginOptions {
  baseUrl: string
  envVar: string
  envPath: string
  force?: boolean
  noOpen?: boolean
}

export interface OAuthLogoutOptions {
  baseUrl: string
  envVar: string
  envPath: string
  token?: string
}

export interface OAuthLogoutDeps {
  fetchImpl?: typeof fetch
}

export type OAuthLogoutResult =
  | { status: 'absent' }
  | { status: 'revoked'; local: 'removed' | 'external' | 'different' }

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

function safeDescription(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').slice(0, 240) : ''
}

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => null)) as unknown
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

function oauthFailure(
  prefix: string,
  response: Response,
  body: Record<string, unknown>,
  sensitiveValues: string[] = []
): Error {
  const code = safeDescription(body.error) || `HTTP ${response.status}`
  let detail = safeDescription(body.error_description)
  for (const value of sensitiveValues) if (value) detail = detail.replaceAll(value, '[redacted]')
  return new Error(`${prefix}: ${code}${detail ? ` — ${detail}` : ''}`)
}

function assertUrl(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`OAuth discovery omitted ${field}`)
  const parsed = new URL(value)
  if (parsed.username || parsed.password) throw new Error(`OAuth discovery returned credentials in ${field}`)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname))) {
    throw new Error(`OAuth discovery returned an insecure ${field}; HTTPS is required outside localhost`)
  }
  return parsed.toString()
}

function discoverUrl(baseUrl: string): string {
  const parsed = new URL(cleanBaseUrl(baseUrl))
  const issuerPath = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = `/.well-known/oauth-authorization-server${issuerPath}`
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

async function discoverOAuthMetadata(baseUrl: string, fetchImpl: typeof fetch): Promise<OAuthMetadata> {
  const expectedIssuer = cleanBaseUrl(assertUrl(baseUrl, 'provider base URL'))
  const response = await fetchImpl(discoverUrl(expectedIssuer), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000)
  })
  const body = await jsonObject(response)
  if (!response.ok) throw oauthFailure('OAuth discovery failed', response, body)
  const metadata = body as unknown as OAuthMetadata
  assertUrl(metadata.issuer, 'issuer')
  if (metadata.issuer !== expectedIssuer) {
    throw new Error(`OAuth issuer mismatch: expected ${expectedIssuer}, received ${safeDescription(metadata.issuer)}`)
  }
  return metadata
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Best-effort only: the complete verification link is always printed, so headless and sandboxed
 * agents still have a correct handoff when the OS refuses to launch a browser. */
function defaultOpenBrowser(url: string): boolean {
  if (process.env.CI) return false
  try {
    const command =
      process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : process.platform === 'win32'
          ? { file: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
          : { file: 'xdg-open', args: [url] }
    const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

function activeEnvLine(source: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=`, 'm').test(source)
}

function gitCheck(cwd: string, args: string[]): boolean | null {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' })
    return true
  } catch (error) {
    const status = (error as { status?: number }).status
    return status === 1 || status === 128 ? false : null
  }
}

/** Refuse the two silent secret-exposure modes: replacing a tracked file, or creating an unignored
 * .env inside a Git worktree. A non-Git directory is fine. */
export function assertPrivateEnvPath(envPath: string): void {
  const cwd = dirname(envPath)
  if (existsSync(envPath) && lstatSync(envPath).isSymbolicLink()) {
    throw new Error(`refusing to store an API key through symbolic-link ${basename(envPath)}`)
  }
  if (!gitCheck(cwd, ['rev-parse', '--is-inside-work-tree'])) return
  if (gitCheck(cwd, ['ls-files', '--error-unmatch', '--', basename(envPath)])) {
    throw new Error(`refusing to store an API key in tracked ${basename(envPath)} — remove it from Git history first`)
  }
  if (!gitCheck(cwd, ['check-ignore', '--quiet', '--', basename(envPath)])) {
    throw new Error(
      `${basename(envPath)} is not Git-ignored. Add '${basename(envPath)}' to .gitignore, then run login again.`
    )
  }
}

/** Bearer-token grammar (RFC 6750) — the default value shape {@link saveEnvSecret} accepts. Exported
 *  so a caller writing something differently-shaped (a URL, say) can pass its own `valuePattern`
 *  instead of fighting this one. */
export const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+={0,}$/

export function saveEnvSecret(envPath: string, key: string, value: string, valuePattern: RegExp = BEARER_TOKEN_PATTERN): void {
  saveEnvSecrets(envPath, [{key, value, valuePattern}])
}

/** Validate and replace several env values with one atomic rename. A credential pair must never
 * land half-updated because the process stopped between two individually-atomic writes. */
export function saveEnvSecrets(
  envPath: string,
  entries: Array<{key: string; value: string; valuePattern?: RegExp}>
): void {
  if (!entries.length) return
  const values = new Map<string, string>()
  for (const {key, value, valuePattern = BEARER_TOKEN_PATTERN} of entries) {
  // Safe to round-trip through the CLI's minimal .env parser. Reject anything broader instead of
  // quoting a provider-controlled value incorrectly — this is a plain `KEY=value` writer, no shell
  // quoting, so a value that could ever contain a newline (or otherwise break the line grammar) is
  // the actual risk `valuePattern` guards against, not "this specific value doesn't look like X".
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !valuePattern.test(value) || values.has(key)) {
      throw new Error('the provided values cannot be stored safely in an environment file')
    }
    values.set(key, value)
  }
  const source = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source ? source.split(/\r?\n/) : []
  const next: string[] = []
  const replaced = new Set<string>()
  for (const line of lines) {
    const found = [...values.keys()].find((key) => {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=`).test(line)
    })
    if (!found) {
      next.push(line)
      continue
    }
    if (!replaced.has(found)) next.push(`${found}=${values.get(found)}`)
    replaced.add(found)
  }
  let appended = false
  for (const [key, value] of values) {
    if (replaced.has(key)) continue
    if (!appended && next.length && next[next.length - 1] !== '') next.push('')
    next.push(`${key}=${value}`)
    appended = true
  }
  while (next[next.length - 1] === '') next.pop()
  const output = `${next.join(eol)}${eol}`
  const temp = resolvePath(dirname(envPath), `.${basename(envPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temp, output, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, envPath)
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp)
    throw error
  }
}

function envFileValue(envPath: string, key: string): string | undefined {
  if (!existsSync(envPath)) return undefined
  return parseEnvContent(readFileSync(envPath, 'utf8')).entries.find(([entryKey]) => entryKey === key)?.[1]
}

function envAssignmentKey(line: string): string | undefined {
  let candidate = line.trim()
  if (!candidate || candidate.startsWith('#')) return undefined
  candidate = candidate.replace(/^export\s+/, '')
  const equals = candidate.indexOf('=')
  return equals === -1 ? undefined : candidate.slice(0, equals).trim()
}

/** Remove every active assignment for one key. If conflicting duplicates existed, leaving a hidden
 * assignment behind would silently log the next process back in, so logout removes the whole set. */
function removeEnvSecret(envPath: string, key: string, expectedValue: string): boolean {
  if (!existsSync(envPath)) return false
  if (lstatSync(envPath).isSymbolicLink()) {
    throw new Error(`API key was revoked at the provider, but refusing to modify symbolic-link ${basename(envPath)}`)
  }
  const source = readFileSync(envPath, 'utf8')
  if (!activeEnvLine(source, key) || envFileValue(envPath, key) !== expectedValue) return false
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const output = source
    .split(/\r?\n/)
    .filter((line) => envAssignmentKey(line) !== key)
    .join(eol)
  const temp = resolvePath(dirname(envPath), `.${basename(envPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temp, output, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, envPath)
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp)
    const detail = error instanceof Error ? safeDescription(error.message) : ''
    throw new Error(
      `API key was revoked at the provider, but ${key} could not be removed from ${basename(envPath)}: ${detail || 'filesystem error'}`
    )
  }
  return true
}

function assertLoginDestination(options: DeviceLoginOptions): void {
  assertPrivateEnvPath(options.envPath)
  const source = existsSync(options.envPath) ? readFileSync(options.envPath, 'utf8') : ''
  const fileValue = parseEnvContent(source).entries.find(([key]) => key === options.envVar)?.[1]
  if (activeEnvLine(source, options.envVar) && !options.force) {
    throw new Error(
      `${options.envVar} already exists in ${basename(options.envPath)}; run \`abx auth logout\` before login to revoke it, ` +
        'or pass --force to replace only the local value without revoking the old key'
    )
  }
  if (process.env[options.envVar] !== undefined && process.env[options.envVar] !== fileValue) {
    throw new Error(
      `${options.envVar} is already set outside ${basename(options.envPath)}. Unset it before login so it cannot shadow the newly issued key.`
    )
  }
}

/** Standards-only core, dependency-injected for a no-secret-output regression test. */
export async function deviceLogin(options: DeviceLoginOptions, deps: DeviceLoginDeps = {}): Promise<void> {
  assertLoginDestination(options)
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser
  const line = deps.line ?? console.log
  const warning = deps.warning ?? console.warn

  const metadata = await discoverOAuthMetadata(options.baseUrl, fetchImpl)
  if (!metadata.grant_types_supported?.includes(DEVICE_GRANT_TYPE)) {
    throw new Error('the provider does not advertise the OAuth device authorization grant')
  }
  const deviceEndpoint = assertUrl(metadata.device_authorization_endpoint, 'device_authorization_endpoint')
  const tokenEndpoint = assertUrl(metadata.token_endpoint, 'token_endpoint')

  const startResponse = await fetchImpl(deviceEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: DEVICE_CLIENT_ID }),
    signal: AbortSignal.timeout(15_000)
  })
  const startBody = await jsonObject(startResponse)
  if (!startResponse.ok) throw oauthFailure('device authorization failed', startResponse, startBody)
  const grant = startBody as unknown as DeviceAuthorizationResponse
  if (
    typeof grant.device_code !== 'string' ||
    typeof grant.user_code !== 'string' ||
    typeof grant.expires_in !== 'number' ||
    !Number.isFinite(grant.expires_in) ||
    grant.expires_in <= 0
  ) {
    throw new Error('the provider returned an invalid device authorization response')
  }
  const verificationUrl = assertUrl(grant.verification_uri_complete ?? grant.verification_uri, 'verification_uri')
  let pollSeconds =
    typeof grant.interval === 'number' && Number.isFinite(grant.interval) && grant.interval >= 1
      ? grant.interval
      : 5
  const deadline = now() + grant.expires_in * 1000

  line(`Browser approval: ${verificationUrl}`)
  line(`Confirm code: ${grant.user_code}`)
  if (!options.noOpen && !openBrowser(verificationUrl)) {
    warning('Could not open a browser automatically; open the approval URL above.')
  }
  line('Waiting for human approval…')

  while (now() < deadline) {
    await sleep(pollSeconds * 1000)
    // Re-check before polling so a destination changed during the human approval wait normally
    // aborts before the provider consumes a one-time grant and issues an orphaned credential.
    assertLoginDestination(options)
    let response: Response
    try {
      response = await fetchImpl(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT_TYPE,
          client_id: DEVICE_CLIENT_ID,
          device_code: grant.device_code
        }),
        signal: AbortSignal.timeout(15_000)
      })
    } catch {
      pollSeconds = Math.min(Math.max(pollSeconds * 2, 5), 30)
      warning(`The provider is temporarily unreachable; retrying in ${pollSeconds}s.`)
      continue
    }
    const body = await jsonObject(response)
    if (response.ok) {
      const accessToken = body.access_token
      if (typeof accessToken !== 'string' || !accessToken || /[\r\n]/.test(accessToken)) {
        throw new Error('the provider returned an invalid OAuth access token')
      }
      if (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer') {
        throw new Error('the provider returned an unsupported OAuth token type')
      }
      // Re-check after the human wait: another process must not have tracked, unignored, symlinked,
      // or newly populated the destination while this command was polling.
      assertLoginDestination(options)
      saveEnvSecret(options.envPath, options.envVar, accessToken)
      return
    }

    const code = safeDescription(body.error)
    if (code === 'authorization_pending') continue
    if (code === 'slow_down') {
      pollSeconds += 5
      continue
    }
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after'))
      pollSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Math.min(pollSeconds * 2, 30)
      warning(`The provider asked the CLI to wait; retrying in ${pollSeconds}s.`)
      continue
    }
    if (code === 'access_denied') throw new Error('device authorization was denied')
    if (code === 'expired_token') throw new Error('device authorization expired; run login again')
    throw oauthFailure('OAuth token exchange failed', response, body, [grant.device_code])
  }
  throw new Error('device authorization expired; run login again')
}

/** RFC 7009 logout: revoke remotely first, then remove the matching local assignment. Keeping the
 * credential when discovery or revocation fails preserves the user's ability to retry safely. */
export async function oauthLogout(
  options: OAuthLogoutOptions,
  deps: OAuthLogoutDeps = {}
): Promise<OAuthLogoutResult> {
  const fileValue = envFileValue(options.envPath, options.envVar)
  const token = options.token || fileValue
  if (!token) return { status: 'absent' }

  const fetchImpl = deps.fetchImpl ?? fetch
  const metadata = await discoverOAuthMetadata(options.baseUrl, fetchImpl)
  const revocationEndpoint = assertUrl(metadata.revocation_endpoint, 'revocation_endpoint')
  const response = await fetchImpl(revocationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: DEVICE_CLIENT_ID,
      token,
      token_type_hint: 'access_token'
    }),
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) {
    const body = await jsonObject(response)
    throw oauthFailure('OAuth token revocation failed', response, body, [token])
  }

  const currentFileValue = envFileValue(options.envPath, options.envVar)
  const local =
    currentFileValue === token && removeEnvSecret(options.envPath, options.envVar, token)
      ? 'removed'
      : currentFileValue === undefined
        ? 'external'
        : 'different'
  if (process.env[options.envVar] === token) delete process.env[options.envVar]
  return { status: 'revoked', local }
}

function targetForAuth(spec: string, action: 'login' | 'logout'): RemoteTarget {
  const target = resolveRemote(spec)
  if (!target) throw new Error(`auth ${action} needs a remote`)
  if (target.source === 'url' || target.source === 'default') {
    throw new Error(
      `auth ${action} needs a named remote so the credential has an unambiguous env var. Configure ABX_REMOTE_<NAME>_URL, then run \`abx auth ${action} <name>\`.`
    )
  }
  return target
}

export async function cmdAuth(args: string[], flags: Flags): Promise<void> {
  const positions = positionalArgs(args)
  const subcommand = positions[0]
  if ((subcommand !== 'login' && subcommand !== 'logout') || positions.length > 2) {
    throw new Error('usage: abx auth <login|logout> [<remote-name>]')
  }
  if (flags.remote === 'true') throw new Error('--remote needs a named remote, for example `--remote abx`')
  const positionalTarget = positions[1]
  const flagTarget = typeof flags.remote === 'string' && flags.remote !== 'true' ? flags.remote : undefined
  if (positionalTarget && flagTarget) throw new Error('choose a positional remote name or --remote, not both')
  const spec = positionalTarget ?? flagTarget ?? 'abx'
  const target = targetForAuth(spec, subcommand)
  const envPath = resolvePath(process.cwd(), '.env')

  if (subcommand === 'logout') {
    console.log(`\n  ${bold('ABX logout')} ${dim(`→ ${target.url}`)}`)
    const result = await oauthLogout({
      baseUrl: target.url,
      envVar: target.tokenVar,
      envPath,
      token: target.token
    })
    if (result.status === 'absent') {
      info(`no ${target.tokenVar} credential is active; already logged out locally`)
      return
    }
    ok('revoked the current API key at the provider')
    if (result.local === 'removed') ok(`removed ${target.tokenVar} from ${basename(envPath)}`)
    else if (result.local === 'external') {
      info(`${target.tokenVar} came from your shell or another environment source; unset it there (the value is now revoked).`)
    } else {
      info(
        `${basename(envPath)} contains a different ${target.tokenVar}; it is still active and was left unchanged. ` +
          `Unset the shadowing environment value, then run logout again to revoke the file credential too.`
      )
    }
    return
  }

  console.log(`\n  ${bold('ABX device login')} ${dim(`→ ${target.url}`)}`)
  info('Email and the one-time code stay in your browser. The CLI receives the API key after approval and never prints it.')
  await deviceLogin({
    baseUrl: target.url,
    envVar: target.tokenVar,
    envPath,
    force: flags.force !== undefined,
    noOpen: flags['no-open'] !== undefined
  })
  ok(`authorized and saved ${target.tokenVar} in your private .env (the key was not printed)`)
  info(`verify it with ${g(`abx remote ${target.name?.toLowerCase() ?? spec}`)}`)
}

export const AUTH_HELP = `
  ${bold('abx auth login')} [<remote-name>] ${dim('— authorize this CLI with OAuth 2.0 Device Authorization Grant')}
    ${g('abx auth login')}             first-party ABX Services (default)
    ${g('abx auth login <name>')}      another named remote configured by ABX_REMOTE_<NAME>_URL
    ${g('--remote <name>')}            equivalent target spelling for agent workflows
    ${g('--no-open')}                  print the browser URL and code without trying to open it
    ${g('--force')}                    recovery only: replace the local value without revoking the displaced key
    ${dim(`The browser owns email + OTP approval. Only the waiting CLI receives the key, stores it as ${ABX_SERVICES_API_KEY_VAR}`)}
    ${dim('(or the named remote\'s token variable), and never prints it. .env must be Git-ignored and must not be tracked.')}
    ${dim('The stored key remains valid until revoked; reuse it across normal tasks and agent sessions.')}

  ${bold('abx auth logout')} [<remote-name>] ${dim('— revoke the current API key, then remove its matching .env entry')}
    ${g('abx auth logout')}            first-party ABX Services (default)
    ${g('abx auth logout <name>')}     another named remote with OAuth revocation discovery
    ${g('--remote <name>')}            equivalent target spelling for agent workflows
    ${dim('Use for teardown, compromise, rotation, or cleanup—not after each task. Remote revocation happens before local removal.')}`
