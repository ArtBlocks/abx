import { execFileSync, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { ABX_SERVICES_API_KEY_VAR } from './service.js'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { randomBytes } from 'node:crypto'
import { parseEnvContent } from '@artblocks/abx-sdk/node'
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
  noWait?: boolean
  resume?: boolean
  structured?: boolean
  loginCommand?: string
}

export type DeviceLoginResult = {
  status: 'pending' | 'completed' | 'denied' | 'expired'
  verificationUrl?: string
  userCode?: string
  expiresAt?: string
  interval?: number
}

interface PendingDeviceLogin {
  issuer: string
  grant: DeviceAuthorizationResponse
  deadline: number
  nextPollAt: number
  pollSeconds: number
}

function pendingLogin(options: DeviceLoginOptions): {key: string; raw?: string; value?: PendingDeviceLogin} {
  const key = `${options.envVar}_PENDING_LOGIN`
  const raw = envFileValue(options.envPath, key)
  if (!raw) return {key}
  let value: PendingDeviceLogin
  try {
    if (raw.length > 32_768) throw new Error()
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as PendingDeviceLogin
    if (value.issuer !== cleanBaseUrl(options.baseUrl) ||
        typeof value.grant?.device_code !== 'string' || !value.grant.device_code ||
        typeof value.grant.user_code !== 'string' ||
        !Number.isFinite(value.deadline) || !Number.isFinite(value.nextPollAt) ||
        !Number.isFinite(value.pollSeconds) || value.pollSeconds < 1) throw new Error()
    assertUrl(value.grant.verification_uri_complete ?? value.grant.verification_uri, 'verification_uri')
  } catch {
    throw new Error('invalid pending login or provider mismatch; remove the pending login entry from your private .env before starting again')
  }
  return {key, raw, value}
}

/** Shared first-party account credential for Node tools. The wallet grant itself stays in the OS keyring. */
export function creatorAccountPath(createDirectory = false): string {
  const path = resolvePath(homedir(), '.config', 'abx', 'creator-account.env')
  if (createDirectory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  return path
}

export function readCreatorProjectToken(path: string): string | undefined {
  return envFileValue(path, ABX_SERVICES_API_KEY_VAR)
}

export function readCreatorAccountToken(
  env: NodeJS.ProcessEnv = process.env,
  projectEnvPath?: string
): string | undefined {
  if (env[ABX_SERVICES_API_KEY_VAR] !== undefined) return env[ABX_SERVICES_API_KEY_VAR]
  if (projectEnvPath) {
    const local = readCreatorProjectToken(projectEnvPath)
    if (local) return local
  }
  const path = creatorAccountPath()
  if (!existsSync(path)) return undefined
  const file = lstatSync(path)
  if (!file.isFile() || (process.platform !== 'win32' && (file.mode & 0o077) !== 0)) {
    throw new Error('ABX creator account credentials must be stored in a private regular file.')
  }
  return envFileValue(path, ABX_SERVICES_API_KEY_VAR)
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
  let code = safeDescription(body.error) || `HTTP ${response.status}`
  let detail = safeDescription(body.error_description)
  for (const value of sensitiveValues) if (value) {
    detail = detail.replaceAll(value, '[redacted]')
    code = code.replaceAll(value, '[redacted]')
  }
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
export async function deviceLogin(options: DeviceLoginOptions, deps: DeviceLoginDeps = {}): Promise<DeviceLoginResult> {
  assertLoginDestination(options)
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser
  const line = deps.line ?? console.log
  const warning = deps.warning ?? console.warn
  const persistent = !!(options.noWait || options.resume)
  const pending = pendingLogin(options)
  const loginCommand = options.loginCommand ?? 'abx auth login'
  if (options.resume && !pending?.value) throw new Error(`no pending login; run \`${loginCommand} --no-wait\` first`)
  if (!options.resume && pending?.value && pending.value.deadline > now()) {
    throw new Error(`a login is already pending; run \`${loginCommand} --resume\` instead of starting another approval`)
  }
  if (!options.resume && pending.raw) removeEnvSecret(options.envPath, pending.key, pending.raw)

  const metadata = await discoverOAuthMetadata(options.baseUrl, fetchImpl)
  if (!metadata.grant_types_supported?.includes(DEVICE_GRANT_TYPE)) {
    throw new Error('the provider does not advertise the OAuth device authorization grant')
  }
  const deviceEndpoint = assertUrl(metadata.device_authorization_endpoint, 'device_authorization_endpoint')
  const tokenEndpoint = assertUrl(metadata.token_endpoint, 'token_endpoint')

  const startResponse = options.resume ? undefined : await fetchImpl(deviceEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: DEVICE_CLIENT_ID }),
    signal: AbortSignal.timeout(15_000)
  })
  const startBody = startResponse ? await jsonObject(startResponse) : undefined
  if (startResponse && !startResponse.ok) throw oauthFailure('device authorization failed', startResponse, startBody!)
  const grant = pending?.value && options.resume ? pending.value.grant : startBody as unknown as DeviceAuthorizationResponse
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
  if (verificationUrl.includes(grant.device_code)) throw new Error('provider verification URL contains the private device secret')
  let pollSeconds = pending?.value && options.resume ? pending.value.pollSeconds :
    typeof grant.interval === 'number' && Number.isFinite(grant.interval) && grant.interval >= 1
      ? grant.interval
      : 5
  const deadline = pending?.value && options.resume ? pending.value.deadline : now() + grant.expires_in * 1000
  let nextPollAt = pending?.value && options.resume ? pending.value.nextPollAt : now() + pollSeconds * 1000
  let storedRaw = pending?.raw
  const persist = () => {
    if (!persistent) return
    assertLoginDestination(options)
    storedRaw = Buffer.from(JSON.stringify({issuer: cleanBaseUrl(options.baseUrl), grant, deadline, nextPollAt, pollSeconds})).toString('base64url')
    saveEnvSecret(options.envPath, pending!.key, storedRaw)
  }
  const clearPending = () => {
    if (storedRaw) removeEnvSecret(options.envPath, pending.key, storedRaw)
  }
  const finish = (status: DeviceLoginResult['status']): DeviceLoginResult => {
    clearPending()
    return {status}
  }
  const result = (): DeviceLoginResult => ({status: 'pending', verificationUrl, userCode: grant.user_code,
    expiresAt: new Date(deadline).toISOString(), interval: pollSeconds})

  if (persistent && !options.resume) persist()
  if (now() >= deadline) return finish('expired')

  line(`Browser approval: ${verificationUrl}`)
  line(`Confirm code: ${grant.user_code}`)
  if (!options.resume && !options.noOpen && !openBrowser(verificationUrl)) {
    warning('Could not open a browser automatically; open the approval URL above.')
  }
  line('Waiting for human approval…')
  if (options.noWait && (!options.resume || now() < nextPollAt)) return result()

  while (now() < deadline) {
    await sleep(Math.max(0, Math.min(nextPollAt, deadline) - now()))
    if (now() >= deadline) break
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
      nextPollAt = now() + pollSeconds * 1000
      persist()
      if (options.noWait) return result()
      continue
    }
    const body = await jsonObject(response)
    if (response.ok) {
      try {
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
      } catch (error) {
        clearPending()
        throw error
      }
      return finish('completed')
    }

    const code = safeDescription(body.error)
    nextPollAt = now() + pollSeconds * 1000
    if (code === 'authorization_pending') {
      persist()
      if (options.noWait) return result()
      continue
    }
    if (code === 'slow_down') {
      pollSeconds += 5
      nextPollAt = now() + pollSeconds * 1000
      persist()
      if (options.noWait) return result()
      continue
    }
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after'))
      pollSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Math.min(pollSeconds * 2, 30)
      warning(`The provider asked the CLI to wait; retrying in ${pollSeconds}s.`)
      nextPollAt = now() + pollSeconds * 1000
      persist()
      if (options.noWait) return result()
      continue
    }
    if (code === 'access_denied') {
      finish('denied')
      if (persistent || options.structured) return {status: 'denied'}
      throw oauthFailure('device authorization failed', response, body, [grant.device_code])
    }
    if (code === 'expired_token') {
      finish('expired')
      if (persistent || options.structured) return {status: 'expired'}
      throw new Error('device authorization expired; run login again')
    }
    clearPending()
    throw oauthFailure('OAuth token exchange failed', response, body, [grant.device_code])
  }
  finish('expired')
  if (persistent || options.structured) return {status: 'expired'}
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

