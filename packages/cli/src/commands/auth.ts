import { basename, resolve as resolvePath } from 'node:path'
import { ACCOUNT_API_INTERFACE } from '@artblocks/abx-sdk'
import { creatorAccountPath, deviceLogin, oauthLogout, provisionCreatorWallet, sponsoredOperationStatus } from '@artblocks/abx-creator-wallet'
import { type Flags, positionalArgs } from '../flags.js'
import {
  ABX_SERVICES_API_KEY_VAR,
  requireRemoteToken,
  resolveRemote,
  serviceInterfaceClient,
  type RemoteTarget
} from '../remote.js'
import { bold, dim, g, info, ok } from '../output.js'
import { CHAIN } from '../config.js'

function targetForAuth(spec: string, action: 'login' | 'logout' | 'keys' | 'revoke-key' | 'wallet'): RemoteTarget {
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
  if (!['login', 'logout', 'keys', 'revoke-key', 'wallet', 'operation'].includes(subcommand ?? '')) {
    throw new Error('usage: abx auth <login|logout|keys|revoke-key|wallet|operation> ...')
  }
  if (subcommand === 'operation') {
    if (positions.length !== 2) throw new Error('usage: abx auth operation <operation-id>')
    if (flags.remote !== undefined) throw new Error('`abx auth operation` currently reads the first-party ABX creator service only.')
    const operation = await sponsoredOperationStatus(CHAIN, positions[1])
    console.log(`\n  ${bold('Creator-wallet operation')} ${operation.operationId}`)
    info(`state          ${operation.state}`)
    info(`gas payer      ${operation.paymentMode === 'self-paid' ? 'creator wallet' : 'ABX sponsorship'}`)
    info(`chain          ${operation.chainId}`)
    info(`transaction    ${operation.transactionHash ?? dim('not assigned')}`)
    info(`user operation ${operation.userOperationHash ?? dim('not assigned')}`)
    if (operation.errorCode) info(`error           ${operation.errorCode}`)
    return
  }
  if (subcommand === 'revoke-key' && (positions.length < 2 || positions.length > 3)) {
    throw new Error('usage: abx auth revoke-key <key-id> [<remote-name>]')
  }
  if (subcommand !== 'revoke-key' && positions.length > 2) {
    throw new Error('usage: abx auth <login|logout|keys|wallet> [<remote-name>]')
  }
  if (flags.remote === 'true') throw new Error('--remote needs a named remote, for example `--remote abx`')
  const keyId = subcommand === 'revoke-key' ? positions[1] : undefined
  const positionalTarget = subcommand === 'revoke-key' ? positions[2] : positions[1]
  const flagTarget = typeof flags.remote === 'string' && flags.remote !== 'true' ? flags.remote : undefined
  if (positionalTarget && flagTarget) throw new Error('choose a positional remote name or --remote, not both')
  const spec = positionalTarget ?? flagTarget ?? 'abx'
  const target = targetForAuth(spec, subcommand as 'login' | 'logout' | 'keys' | 'revoke-key' | 'wallet')
  const sharedAccount = target.name?.toUpperCase() === 'ABX' && !process.env[ABX_SERVICES_API_KEY_VAR]
  const envPath = sharedAccount
    ? creatorAccountPath(subcommand === 'login')
    : resolvePath(process.cwd(), '.env')

  if (subcommand === 'keys' || subcommand === 'revoke-key') {
    requireRemoteToken(target)
    const account = await serviceInterfaceClient(target, ACCOUNT_API_INTERFACE)
    if (subcommand === 'revoke-key') {
      const result = await account.revokeApiKey(keyId!)
      ok(`revoked API key ${result.keyId}`)
      return
    }
    const result = await account.listApiKeys()
    console.log(`\n  ${bold('ABX API keys')} ${dim(`→ ${target.url}`)}`)
    for (const key of result.keys) {
      const current = key.current ? ` ${g('(current)')}` : ''
      console.log(`  ${key.id}${current}  ${dim(`${key.label ?? 'unlabeled'} · ${key.createdAt}`)}`)
    }
    info(`${result.keys.length} of ${result.limit} active keys`)
    return
  }

  if (subcommand === 'wallet') {
    if (target.name?.toUpperCase() !== 'ABX') {
      throw new Error('`abx auth wallet` currently provisions the first-party ABX creator wallet only.')
    }
    requireRemoteToken(target)
    const wallet = await provisionCreatorWallet()
    ok(`${wallet.created ? 'created' : 'reusing'} creator wallet ${wallet.address}`)
    return
  }

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

  if (target.token && flags.force === undefined) {
    if (flags.json !== undefined) {
      console.log(JSON.stringify({status: 'completed', reused: true}))
      return
    }
    ok(`reusing the existing ${target.tokenVar} credential`)
    info(`verify it with ${g(`abx remote ${target.name?.toLowerCase() ?? spec}`)}`)
    return
  }

  const structured = flags.json !== undefined
  if (!structured) {
    console.log(`\n  ${bold('ABX device login')} ${dim(`→ ${target.url}`)}`)
    info('Email and the one-time code stay in your browser. The CLI receives the API key after approval and never prints it.')
  }
  const result = await deviceLogin({
    baseUrl: target.url,
    envVar: target.tokenVar,
    envPath,
    force: flags.force !== undefined,
    noOpen: flags['no-open'] !== undefined,
    noWait: flags['no-wait'] !== undefined,
    resume: flags.resume !== undefined,
    structured
  }, structured ? {line: () => {}, warning: (message) => process.stderr.write(`${message}\n`)} : {})
  if (structured) console.log(JSON.stringify(result))
  if (result.status === 'pending') {
    if (!structured) info(`Approval is pending. Resume with abx auth login ${positionalTarget ?? ''} --resume${flagTarget ? ` --remote ${flagTarget}` : ''}`)
    return
  }
  if (result.status !== 'completed') {
    if (!structured) info(`Device login ${result.status}; run login again to start a new approval.`)
    process.exitCode = 1
    return
  }
  if (structured) return
  ok(`authorized and saved ${target.tokenVar} in ${sharedAccount ? 'your private creator account credentials' : 'your private .env'}`)
  info(`verify it with ${g(`abx remote ${target.name?.toLowerCase() ?? spec}`)}`)
}

export const AUTH_HELP = `
  ${bold('abx auth login')} [<remote-name>] ${dim('— authorize this CLI with OAuth 2.0 Device Authorization Grant')}
    ${g('abx auth login')}             first-party ABX Services (default)
    ${g('abx auth login <name>')}      another named remote configured by ABX_REMOTE_<NAME>_URL
    ${g('--remote <name>')}            equivalent target spelling for agent workflows
    ${g('--no-open')}                  print the browser URL and code without trying to open it
    ${g('--no-wait --json')}           return approval details; keep the pending grant in the private .env
    ${g('--resume [--no-wait] --json')} resume waiting, or poll once when the provider interval allows
    ${g('--force')}                    recovery only: replace the local value without revoking the displaced key
    ${dim(`The browser owns email + OTP approval. The waiting CLI saves ${ABX_SERVICES_API_KEY_VAR} in private creator account credentials`)}
    ${dim('(or the named remote\'s token variable), and never prints it. .env must be Git-ignored and must not be tracked.')}
    ${dim('The stored key remains valid until revoked; reuse it across normal tasks and agent sessions.')}

  ${bold('abx auth logout')} [<remote-name>] ${dim('— revoke the current API key, then remove its matching .env entry')}
    ${g('abx auth logout')}            first-party ABX Services (default)
    ${g('abx auth logout <name>')}     another named remote with OAuth revocation discovery
    ${g('--remote <name>')}            equivalent target spelling for agent workflows
    ${dim('Use for teardown, compromise, rotation, or cleanup—not after each task. Remote revocation happens before local removal.')}

  ${bold('abx auth keys')} [<remote-name>] ${dim('— list active key metadata for this account')}
    ${g('abx auth keys')}              show key ids, labels, creation times, and the current key

  ${bold('abx auth revoke-key')} <key-id> [<remote-name>] ${dim('— revoke another active key')}
    ${g('abx auth revoke-key <id>')}   free an unused key slot; use ${g('abx auth logout')} for the current key

  ${bold('abx auth wallet')} ${dim('— provision or show the stable creator wallet for this ABX Services account')}
    ${g('abx auth wallet')}            safe setup for sponsored dry runs; reuses the same wallet every time

  ${bold('abx auth operation')} <operation-id> ${dim('— read durable status after an uncertain local RPC result')}
    ${g('abx auth operation op_…')}    read-only; never submits or retries the transaction`
