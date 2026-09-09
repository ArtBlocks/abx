#!/usr/bin/env node
/**
 * abx — the ABX Self-Host Toolkit's reference CLI (Layer 3), the agentic UX surface.
 *
 * The published binary runs compiled JS on plain Node (this shebang). In dev the CLI is
 * always invoked through tsx (`pnpm abx`, the sandbox wrapper), which ignores the shebang
 * and runs this TypeScript source directly — so the dev loop never needs a build.
 *
 * The primary way to take a project from intent to live and self-hosted: deploy
 * a project, index it from chain, and serve its token API + image, end to end,
 * with no hosted service in the loop. It wraps the public SDK — anyone could run
 * a different implementation and the protocol would work identically.
 *
 *   abx demo                 deploy a 1/1 to Sepolia, index it, and serve it
 *   abx deploy [--image ..]  deploy + index a 1/1 (--image to custody your own bytes; --no-mint to defer)
 *                            --copies <n|open> routes to the ERC-1155 edition twin instead — copies of the
 *                            SAME work (an open edition, with --copies open, is the flagship edition product)
 *   abx deploy-series        a multi-token image Series from a folder of media; --copies <n|open> makes it
 *                            an edition (N ids from the folder × copies each) — see `abx help deploy-series`
 *   abx predict [--salt ..]  pre-compute a deploy address (reserve / vanity it before signing); --copies-aware
 *   abx preview              run a code project on localhost while it's still being made (no chain)
 *   abx deploy-code          deploy a code project (SeriesCode): --script <file> (on-chain template)
 *                            or --code-dir <dir> (build directory → ipfs/arweave `code` field)
 *                            --resume <addr>: finish one whose setup tx failed (sends only what's missing)
 *                            --copies <n|open> makes it an EditionCode (a generative drop, minted as copies)
 *   abx add <address>        register + index a project (--remote <name|url>: on a remote resolver, not this machine)
 *   abx auth login|logout    authorize in a browser, or revoke and remove the current API key
 *   abx remote [<name|url>]  inspect a remote service (descriptor · chains · managed rendering · your projects there)
 *   abx index [<address>]    re-index a project from chain (replay; --remote to nudge a remote resolver)
 *   abx verify <address>     re-hash served bytes vs the on-chain commitment (no server)
 *   abx tokenuri <address>   read tokenURI(id) (or, on an edition, uri(id)) from the contract + decode
 *                            · contracturi: the ERC-7572 collection JSON (the contract holds the URL —
 *                            never hand-build a resolver path)
 *   abx tokens <address>     every token's owner + seed + params, from chain alone (--json for the machine
 *                            path); on an edition, supply/maxSupply per id instead of an owner
 *   abx artifacts <address>  one token's `artifacts` manifest directly (entries + current/stale effect rows);
 *                            --remote reads what a HOSTED resolver actually reports (the surface that owns it)
   *   abx configure-param <addr> <id> <key> <value>  set a governed PostParam (typed encode; any lane)
   *   abx submit-app <collection>  list a deployed ABX collection in the App Store (optional, after deploy)
 *   abx set-param-hooks <addr>  wire/clear a code project's configure/augment/transfer param hooks
 *   abx render <addr> [id…]  effect-runner repair lane: render missing stills/traits
 *                            (enqueues via ABX_EFFECTS_URL when a runner is up, else inline)
 *   abx serve                serve the token API + dashboard
 *   abx mint <addr>          issue token #0 (deferred mint / primary sale); on an edition, --token-id
 *                            (required unless a 1/1-edition) + --amount (copies of that id, default 1)
 *   abx set-max-supply <addr>  edition-only: lower ONE id's ERC-1155 supply cap (the per-id twin of
 *                            set-max-invocations) — --token-id <n> --cap <n> (never "open"; caps only decrease)
 *   abx ping-uri <addr>      edition-only, owner-only: re-emit the native URI event for --token-ids
 *                            <csv|range> after a re-point, so URI-only indexers/marketplaces re-index
 *   abx refresh <addr>       ask marketplaces to (re)index a token's metadata
 *   abx transfer <addr>      sell/transfer a token  ·  set-admin: hand over contract ownership
 *                            on an edition: --amount <n> copies + --from 0x.. (many holders ⇒ no single owner)
 *   abx migrate <addr>       move a contract's off-chain state to another resolver (--from/--to)
 *   abx set-token-uri <addr> · set-contract-uri · set-royalty · set-field · lock-field · set-gateway
 *   abx storage show         show byte custody (fs | cloud | ipfs | arweave); stateless — choose per command with flags
 *   abx storage status <loc>  is a locator RETRIEVABLE yet, not just accepted? (Arweave propagation is minutes)
 *   abx storage balance|topup  Turbo (arweave) upload credits — view / buy by card (credits attach to the signing identity)
 *   abx storage backup-key   copy the managed Turbo/Arweave key (holds credits) to a safe path
 *   abx status               list indexed projects + node info
 *   abx feedback             preview/file core ABX feedback; --remote routes provider feedback
 *   abx doctor               check environment (key, RPC, balance, factory, storage)
 *   abx skill install        install the version-locked abx agent skill into your agent(s)
 *                            (default: Claude Code + the neutral .agents/skills; --agent/--global)
 *
 * Every write picks a signing lane: default hot (env key signs), `--sign` (a human
 * approves in their own wallet via a one-shot localhost page), `--unsigned` (print
 * the tx for a multisig / offline signer). The agent picks the lane; the CLI signs.
 *
 * Command bodies live in `commands/*.ts`, grouped by domain (deploy / project / reads / storage /
 * service / scaffold) — see `.claude/skills` and `contracts/README.md` conventions aside, this file
 * itself keeps only: startup (env, update check), flag parsing, the dispatch table, and help text.
 */
import {loadDotEnv} from '@artblocks/abx-sdk/node';
import {type Address, DEFAULT_CHAIN_KEY, KNOWN_CHAIN_KEYS, redactRpcUrlsInText, resolveRpcUrls} from '@artblocks/abx-sdk';
import {DEFAULT_PORT} from '@artblocks/abx-token-api';
import {
  cmdAdd,
  cmdForget,
  cmdIndex,
  cmdPredict,
  cmdState,
  cmdStatus,
  cmdVerify,
} from './commands/project.js';
import {cmdDeploy, cmdDeployCode, cmdDeploySeries} from './commands/deploy.js';
import {
  cmdArtifacts,
  cmdContractUri,
  cmdInspect,
  cmdPreview,
  cmdRender,
  cmdTokenUri,
  cmdTokens,
} from './commands/reads.js';
import {cmdStorage} from './commands/storage.js';
import {
  cmdDeployEffects,
  cmdDeployResolver,
  cmdEffects,
  cmdMigrate,
  cmdRemote,
  cmdRemoteSet,
  cmdServe,
} from './commands/service.js';
import {cmdDoctor, cmdMintPage, cmdScaffoldRenderer, cmdScaffoldSolidity, cmdSkill} from './commands/scaffold.js';
import {cmdSubmitApp} from './commands/submit-app.js';
import {cmdVacuum, VACUUM_HELP} from './commands/maintenance.js';
import {cmdFeedback} from './commands/feedback.js';
import {AUTH_HELP, cmdAuth} from './commands/auth.js';
import {ABX_CAPABILITIES, cmdCapabilities} from './capabilities.js';
import {CHAIN} from './config.js';
import {CliError} from './errors.js';
import {allowlistFor} from './flag-allowlists.js';
import {type Flags, parseFlags, positionalArgs, warnStrayFlags} from './flags.js';
import {bold, c, dim, ensureRenderer, g, ok} from './output.js';
import {
  cmdAttach,
  cmdConfigureParam,
  cmdLockDependencies,
  cmdLockParamHooks,
  cmdLockScript,
  cmdLockField,
  cmdLockUri,
  cmdMint,
  cmdMinterBuy,
  cmdMinterConfigure,
  cmdMinterShow,
  cmdPause,
  cmdPingUri,
  cmdRefresh,
  cmdRemoveLastDependency,
  cmdReplaceScript,
  cmdRetireParam,
  cmdSetAdmin,
  cmdSetContractUri,
  cmdSetDependency,
  cmdSetDependencyRegistry,
  cmdSetField,
  cmdSetGateway,
  cmdSetMaxInvocations,
  cmdSetMaxSupply,
  cmdSetMinter,
  cmdSetParamHooks,
  cmdSetPrimaryPayee,
  cmdSetRenderer,
  cmdSetRoyalty,
  cmdSetRoyaltyCap,
  cmdSetSchema,
  cmdSetTokenUri,
  cmdSetTransferValidator,
  cmdSetSeedSource,
  cmdTransfer,
  cmdUnpause,
} from './ownerops.js';
import {DEFAULT_PREVIEW_PORT} from './preview.js';
import {checkForCliUpdate, compareVersions, installedLegacySkillCopies, installedSkillCopies, readCliVersion, skillRefreshCommands} from './update-check.js';


/**
 * Validate `ABX_CHAIN` at module load, BEFORE anything derives from it.
 *
 * This has to run here, not inside `main()`. Chain-derived constants are evaluated during module
 * evaluation (several in the token-api package the CLI imports — see config.ts's `explorerBase`
 * for why the CLI-side equivalent stays a lazy getter, not a top-level const), so an unknown value
 * threw before `main()` ever ran. The result was a raw Node stack trace quoting an internal source path,
 * for every command, including `doctor`. A typo should get an answer, not a crash.
 */
function assertKnownChainEnv(): void {
  const key = process.env.ABX_CHAIN;
  if (!key || KNOWN_CHAIN_KEYS.includes(key)) return;
  const mainnetish = /^(mainnet|ethereum|homestead|base|eth|1|8453)$/i.test(key.trim());
  process.stderr.write(
    `\n\u001b[31m\u2717\u001b[0m ABX_CHAIN="${key}" is not a chain this toolkit ships. Known: ${KNOWN_CHAIN_KEYS.join(', ')}.\n` +
      (mainnetish
        ? `  Mainnet is not supported yet \u2014 ABX is testnet-only today. Use base-sepolia (the default) or sepolia;\n` +
          `  a testnet launch exercises the real thing end to end, just without real money.\n\n`
        : `  Unset it to use the default (${DEFAULT_CHAIN_KEY}), or set one of the above.\n\n`),
  );
  process.exit(1);
}
assertKnownChainEnv();



/**
 * Notify-only update nudge. Prints an upgrade one-liner to STDERR (never stdout — an agent may be
 * parsing that) when a newer @artblocks/abx-cli is published, plus a nudge when a locally-installed
 * skill has drifted behind the running CLI. Fully suppressed by CI / ABX_NO_UPDATE_CHECK /
 * --no-update-check, and wrapped so it can NEVER break a command (all failures are swallowed).
 */
async function maybeNotifyUpdate(flags: Flags): Promise<void> {
  try {
    if (flags['no-update-check'] !== undefined || process.env.ABX_NO_UPDATE_CHECK || process.env.CI) return;
    const current = readCliVersion();
    const legacyCopies = installedLegacySkillCopies();
    if (legacyCopies.length) {
      const where = legacyCopies.length > 1 ? `${legacyCopies.length} legacy copies are` : `the ${legacyCopies[0].scope} legacy copy (${legacyCopies[0].path}) is`;
      console.error(
        `    ${c.orange}⚠${c.reset}  ${where} still active as ${bold('abx-self-host')} — run ${g('abx doctor')} for paths; migrate to ${bold('abx')}: ${skillRefreshCommands(legacyCopies).map((command) => g(command)).join(' && ')}`,
      );
    }
    // Skill drift (cheap, offline): the skill and CLI are co-versioned, but a separately-installed
    // skill copy doesn't move when the CLI upgrades. Nudge a reinstall when the CLI is ahead.
    // Name WHICH copy is stale and print the command that actually refreshes THAT one: a bare
    // `abx skill install` never touches the global copy, so pointing at it for a stale global copy
    // left agents re-running a fix that could not work (see `installedSkillCopies`).
    const staleCopies = installedSkillCopies().filter((copy) => compareVersions(current, copy.version) > 0);
    if (staleCopies.length) {
      const worst = staleCopies[0];
      const where = staleCopies.length > 1 ? `${staleCopies.length} installed copies are` : `the ${worst.scope} skill copy (${worst.path}) is`;
      console.error(
        `    ${c.orange}⚠${c.reset}  ${where} v${worst.version} but the CLI is v${current} — refresh: ${skillRefreshCommands(staleCopies).map((cmd) => g(cmd)).join(' && ')}`,
      );
    }
    const latest = await checkForCliUpdate(current);
    if (latest) {
      // The notes pointer must RESOLVE. This printed github.com/ArtBlocks/abx/releases, which 404s
      // for everyone outside the org (the repo is private) — so a tester reconstructed the diff by
      // running the same dry run on both versions, which is how they discovered the canonical
      // singletons had moved and then had no way to tell whether that needed them to act. The
      // packaged CHANGELOG.md ships with every install (see package.json `files`) and carries the
      // real per-release notes, so it's readable offline and always matches the version you have.
      console.error(
        `\n    ${c.orange}⚠${c.reset}  update available: ${bold('abx')} ${dim(current)} → ${g(latest)}\n` +
          `       upgrade: ${g('npm i -g @artblocks/abx-cli@latest')} ${dim('· or invoke:')} ${g('npx @artblocks/abx-cli@latest <command>')}\n` +
          `       release notes: ${g('CHANGELOG.md')} ${dim('(ships with the CLI) · all versions: https://www.npmjs.com/package/@artblocks/abx-cli?activeTab=versions')}\n` +
          `       ${dim('silence: ABX_NO_UPDATE_CHECK=1')}\n`,
      );
    }
  } catch {
    /* an update check must never break a command */
  }
}



async function main() {
  loadDotEnv();

  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  // `--chain` is the flag people reach for, and it does not exist: chain selection is the ABX_CHAIN
  // env var. It used to be swallowed by the generic stray-flag WARNING and the command then acted on
  // the DEFAULT chain — `abx deploy-code … --chain sepolia` deployed to base-sepolia. On a dry run
  // that costs a confused minute; on a funded send it is a wrong-chain deploy with real artifacts at
  // the wrong address. Prose that was ignored once will be ignored again, so this refuses instead,
  // on EVERY command (a read-only command that quietly ignored it would still teach the wrong model).
  if (flags.chain !== undefined) {
    const asked = typeof flags.chain === 'string' && flags.chain !== 'true' ? flags.chain : '';
    process.stderr.write(
      `\n${c.red}✗${c.reset} there is no ${bold('--chain')} flag — the chain is chosen by the ${bold('ABX_CHAIN')} environment variable.\n` +
        `  active now: ${bold(CHAIN)}${asked && asked !== CHAIN ? `  ${dim(`(you asked for '${asked}')`)}` : ''}\n` +
        `  known chains: ${KNOWN_CHAIN_KEYS.join(', ')}\n\n` +
        `  run it on ${asked && KNOWN_CHAIN_KEYS.includes(asked) ? asked : '<chain>'} like this:\n` +
        `      ${bold(`ABX_CHAIN=${asked && KNOWN_CHAIN_KEYS.includes(asked) ? asked : '<chain>'} abx ${cmd ?? '<command>'} …`)}\n` +
        `  ${dim('(the CLI is deliberately stateless — every run resolves its chain from the environment, so nothing a previous command set can leak into this one.)')}\n\n`,
    );
    process.exitCode = 1;
    return;
  }

  // `version` / --version / -v is a crisp query — print and exit, no update nag around it.
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log(readCliVersion());
    return;
  }

  // Notify-only "you're behind" nudge (cached, opt-out, stderr — see update-check.ts). Awaited so
  // the notice lands before command output, but it hits the network at most once every 6h and never
  // throws, so it can't break or meaningfully slow a command. Skipped for the pure help path below.
  await maybeNotifyUpdate(flags);

  // SAFETY: --help / -h on ANY command is read-only — print usage, never execute.
  // (A write command must never deploy/mint/spend just because someone asked for help.)
  if (cmd && cmd !== 'help' && (flags.help !== undefined || rest.includes('-h'))) {
    return printCommandHelp(cmd, positionalArgs(rest)[0]);
  }

  // One unknown-flag notice for every listed command. Centralized here rather than added to ~45
  // command bodies: one call site can't drift out of sync with itself, and a command absent from
  // COMMAND_FLAGS keeps its previous behavior instead of gaining a half-right allowlist.
  //
  // WARN, not refuse. `unknownFlags`' own contract says so, and the owner's scriptability line backs it:
  // an allowlist here could be incomplete, and a false refusal on a valid flag would break someone's
  // working script — strictly worse than the silence this replaces. `deploy*` still refuses via its own
  // exhaustive sets. The warning names the flag and points at the command's help, so the fix is local.
  if (cmd) {
    const allowed = allowlistFor(cmd, positionalArgs(rest)[0]);
    if (allowed) warnStrayFlags(flags, allowed, cmd);
  }

  switch (cmd) {
    case 'demo': return cmdDeploy(flags, true);
    case 'deploy': return cmdDeploy(flags, false);
    case 'deploy-series': return cmdDeploySeries(flags);
    case 'deploy-code': return cmdDeployCode(flags);
    case 'capabilities': return cmdCapabilities(flags);
    case 'inspect': return cmdInspect(rest[0], flags);
    case 'preview': return cmdPreview(flags);
    case 'scaffold-renderer': return cmdScaffoldRenderer(rest, flags);
    case 'scaffold':
      if (positionalArgs(rest)[0] === 'solidity') return cmdScaffoldSolidity(positionalArgs(rest).slice(1), flags);
      throw new Error('usage: abx scaffold solidity [<dir>] [--force]');
    case 'predict': return cmdPredict(flags);
    case 'add': return cmdAdd(rest[0] as Address | undefined, flags);
    case 'index': return cmdIndex(rest[0] as Address | undefined, flags);
    case 'verify': return cmdVerify(rest[0] as Address | undefined, flags);
    case 'render': return cmdRender(rest[0] as Address | undefined, rest.slice(1), flags);
    case 'effects': return cmdEffects(flags);
    case 'tokenuri': return cmdTokenUri(rest[0] as Address | undefined, flags, rest.slice(1));
    case 'artifacts': return cmdArtifacts(rest[0] as Address | undefined, flags);
    case 'tokens': return cmdTokens(rest[0] as Address | undefined, flags);
    case 'contracturi': return cmdContractUri(rest[0] as Address | undefined, flags);
    case 'serve': return cmdServe(flags);
    // owner operations — write + sign (hot/wallet/cold lane), then re-index
    case 'mint': return cmdMint(rest[0], flags);
    case 'submit-app': return cmdSubmitApp(rest[0], flags);
    case 'set-minter': return cmdSetMinter(rest[0], flags);
    case 'set-max-invocations': return cmdSetMaxInvocations(rest[0], flags);
    case 'set-max-supply': return cmdSetMaxSupply(rest[0], flags);
    case 'ping-uri': return cmdPingUri(rest[0], flags);
    case 'configure-param': return cmdConfigureParam(rest[0], rest.slice(1), flags);
    case 'set-schema': return cmdSetSchema(rest[0], flags);
    case 'retire-param': return cmdRetireParam(rest[0], rest.slice(1), flags);
    case 'set-param-hooks': return cmdSetParamHooks(rest[0], flags);
    case 'set-dependency': return cmdSetDependency(rest[0], rest.slice(1), flags);
    case 'remove-last-dependency': return cmdRemoveLastDependency(rest[0], flags);
    case 'set-dependency-registry': return cmdSetDependencyRegistry(rest[0], rest.slice(1), flags);
    case 'lock-dependencies': return cmdLockDependencies(rest[0], flags);
    case 'lock-script': return cmdLockScript(rest[0], flags);
    case 'replace-script': return cmdReplaceScript(rest[0], flags);
    case 'lock-param-hooks': return cmdLockParamHooks(rest[0], flags);
    case 'set-primary-payee': return cmdSetPrimaryPayee(rest[0], flags);
    case 'minter': return cmdMinter(rest);
    case 'pause': return cmdPause(rest[0], flags);
    case 'unpause': return cmdUnpause(rest[0], flags);
    case 'refresh': return cmdRefresh(rest[0], flags);
    case 'transfer': return cmdTransfer(rest[0], flags);
    case 'set-token-uri': return cmdSetTokenUri(rest[0], flags);
    case 'set-contract-uri': return cmdSetContractUri(rest[0], flags);
    case 'deploy-resolver': return cmdDeployResolver(flags);
    case 'deploy-effects': return cmdDeployEffects(flags);
    case 'mint-page': return cmdMintPage(rest[0], flags);
    case 'set-royalty': return cmdSetRoyalty(rest[0], flags);
    case 'set-royalty-cap': return cmdSetRoyaltyCap(rest[0], flags);
    case 'set-transfer-validator': return cmdSetTransferValidator(rest[0], rest.slice(1), flags);
    case 'set-seed-source': return cmdSetSeedSource(rest[0], rest.slice(1), flags);
    case 'set-field': return cmdSetField(rest[0], flags);
    case 'set-gateway': return cmdSetGateway(rest[0], flags);
    case 'attach': return cmdAttach(rest, flags);
    case 'lock-field': return cmdLockField(rest[0], flags);
    case 'set-renderer': return cmdSetRendererCli(rest[0] as Address | undefined, flags);
    case 'lock-uri': return cmdLockUri(rest[0], flags);
    case 'set-admin': return cmdSetAdmin(rest[0], flags);
    case 'forget': return cmdForget(rest[0] as Address | undefined, flags);
    case 'migrate': return cmdMigrate(rest[0] as Address | undefined, flags);
    case 'remote': return rest[0] === 'set' ? cmdRemoteSet(rest[1], flags) : cmdRemote(rest[0], flags);
    case 'feedback': return cmdFeedback(flags);
    case 'auth': return cmdAuth(rest, flags);
    case 'storage': return cmdStorage(rest);
    case 'vacuum': return cmdVacuum(rest, flags);
    case 'status': return cmdStatus(rest[0] as Address | undefined, flags);
    case 'state': return cmdState(rest[0] as Address | undefined, flags);
    case 'doctor': return cmdDoctor(flags);
    case 'skill': return cmdSkill(rest, flags);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return printCommandHelp(rest[0], rest[1]);
    default:
      console.error(`Unknown command: ${cmd}\n`);
      help();
      process.exitCode = 1;
      return;
  }
}



/** `abx set-renderer <addr>` — resolve which renderer to point at, then delegate to the
 *  signing harness. `--off` clears it (back to off-chain); `--renderer 0x..` uses an
 *  explicit one; otherwise default to the chain's canonical renderer (deploying it if
 *  needed, via the env key). */
async function cmdSetRendererCli(address: Address | undefined, flags: Flags): Promise<void> {
  if (!flags.off && !flags.renderer) flags.renderer = await ensureRenderer();
  return cmdSetRenderer(address, flags);
}


// `abx minter <configure|show|buy> <token> [flags]` — the shared fixed-price minter (Minter spine).
// configure defers to the token owner; buy is public. See site/content/docs/protocol/minting.mdx.
async function cmdMinter(rest: string[]) {
  const [sub, ...args] = rest;
  const flags = parseFlags(args);
  const token = args.find((a) => !a.startsWith('--')); // positional <token>
  switch (sub) {
    case 'configure': return cmdMinterConfigure(token, flags);
    case 'show': return cmdMinterShow(token, flags);
    case 'buy': return cmdMinterBuy(token, flags);
    default:
      console.error(
        'usage: abx minter <configure|show|buy> <token> [flags]\n' +
          '  configure <token> (--price <eth> | --price-raw <units>) --allocation <n> [--erc20 0x…] [--token-id <n> (editions)]\n' +
          '  show <token> [--token-id <n> (editions)]\n' +
          '  buy <token> [--to 0x…] [--token-id <n> --quantity <n> (editions)] [--sign|--unsigned]\n' +
          '  (--token-id is REQUIRED on an edition — OneOfOneEdition/EditionImage/EditionCode; refused on a 721 target)\n',
      );
      process.exitCode = 1;
      return;
  }
}



// ── per-command usage (printed by `<cmd> --help` / `abx help <cmd>`; read-only) ──
const COMMAND_HELP: Record<string, string> = {
  auth: AUTH_HELP,
  capabilities: `
  ${bold('abx capabilities')} ${dim('— stable product boundaries for agents and automation; read-only')}
    ${g('abx capabilities')}          concise human summary
    ${g('abx capabilities --json')}   machine-readable deployment lanes, extension seams, irreversible choices, and unsupported cases
    ${dim('Use command help for syntax and a deploy command with --dry-run --json for a concrete transaction plan.')}`,
  skill: `
  ${bold('abx skill')} ${dim('— install the version-locked abx agent skill so your coding agent can drive abx')}
    ${g('abx skill install')}     copy the bundled skill (version-locked to this CLI) into your agent(s)
                          ${dim('default: both')} ${bold('.claude/skills')} ${dim('(Claude Code) and')} ${bold('.agents/skills')} ${dim('(Cursor · Codex · Gemini · Copilot)')}
                          ${g('--agent <name>')}    only one agent: ${dim('claude | cursor | codex | gemini | copilot')}
                          ${g('--global')}          install into your home dir (~) instead of the current project
                          ${g('--target <dir>')}    install under <dir>; archives a recognized <dir>/abx-self-host first, then writes <dir>/abx
    ${g('abx skill path')}        print the absolute path to the bundled skill (for ${g('npx skills add <path>')} or manual copy)
    ${dim('Restart your agent after installing so it picks up the skill. The git-based cross-agent')}
    ${dim('installer also works (not version-locked):')} ${g('npx skills add ArtBlocks/abx --skill abx')}`,
  deploy: `
  ${bold('abx deploy')} ${dim('— deploy + index a 1/1 (no server). Sends a tx in the chosen lane.')}
    --image <path>        custody your own image (png · jpg · gif · svg · webp); else generative demo content
    --name <s> --symbol <s>   ERC-721 identity
    --description "<s>"   the creator's words, served in token metadata   --external-url <url>
    --description-onchain   store the description ON-CHAIN (durable, reconstructable from chain alone)
    --creator "<s>" · --license "<s>"   authorship + rights, ON-CHAIN collection fields served in contractURI (also --display-notes, --creator-links)
    --traits "K=V; K2=V2"   real OpenSea traits (the marketplace trait array)   --attributes <file.json>   (array or {name: value} map)
    --traits-onchain        store traits ON-CHAIN (inline JSON, lockable); else off-chain operator metadata (editable via ${g('abx add --traits')})
    ${g('--onchain-uri')}         resolve tokenURI/contractURI FULLY ON-CHAIN (renderer assembles JSON from fields;
                            image inlined as SVG, description on-chain) — the token self-resolves, no server needed
    ${g('--onchain-image')}       stage ${g('--image')} bytes on-chain (chunk store) and bake a reader field INTO the deploy —
                            content with NO post-deploy tx (implies --onchain-uri)
                            ${dim('WRITE is chunked (~200 gas/byte, no block-limit issue at any size). READ is one eth_call, and its')}
                            ${dim('cost is what varies: tokenURI reassembles the whole document per call at ~360-405k gas/KB, climbing')}
                            ${dim('with size. NO SIZE IS REFUSED. Under ~50M gas (~117KB) every endpoint measured serves it; above that')}
                            ${dim('abx probes YOUR rpc and reports its real cap (sepolia.base.org allows 600M ~= 729KB; publicnode/drpc')}
                            ${dim('allow 50M), and warns that providers capped at 50M will show a revert instead of your token.')}
    ${g('--compress')} none|fastlz|gzip   for --onchain-image (default none): ${g('fastlz')} = on-chain decode (stays renderable);
                            ${g('gzip')} = smaller but off-chain decode only
    --royalty-bps <0-10000>   default 500 (5%). Must be <= --royalty-cap
    --royalty-cap <0-10000>   the ceiling this collection can EVER charge (default 10%, auto-raised to fit a higher --royalty-bps). Owner-set
                            at deploy, reduce-only after — a monotonic-down "royalty can never exceed X" promise
    ${g('--burnable')}               opt in to burning (default off): holders may burn their token. Fixed at deploy
    ${g('--721c')} [recommended|0x..]   opt-in ERC-721C: enroll at deploy, PERMANENTLY, with that transfer validator
                            (${g('recommended')} = OpenSea's validator for creator-fee enforcement — only owner-initiated
                            transfers + authorized sales move the token). Absent = plain ERC-721, forever (the default).
                            Manage later with ${g('abx set-transfer-validator')} (re-point or suspend; never un-enroll).
                            ${dim('A validator must be a deployed contract that REFUSES calls it does not implement — a Safe or a bare')}
                            ${dim('proxy is refused before any gas, since it would enforce nothing while every read said enforcement was ON.')}
    ${g('--no-mint')}             deploy without minting (warm the resolver, then ${g('abx mint')})
    --salt 0x..<64hex>    deploy to a reserved / vanity address (see ${g('abx predict')})
    --public-base-url <url>   bake a public resolver URL on-chain (off-chain custody REQUIRES a public URL; localhost is refused)
    --backend … (storage override) · --port <n>
    ${g('--ipfs-gateway')} <prefix> / ${g('--arweave-gateway')} <prefix>   where an ipfs/arweave image is SERVED from — written on-chain as
                            a collection preference, repointable later with ${g('abx set-gateway')} (one tx, no re-upload).
                            ${dim('Unset = the public floors')} ${bold('https://ipfs.io/ipfs/')} ${dim('and')} ${bold('https://arweave.net/')}${dim('. Plain')} ${g('--gateway')} ${dim('is the UPLOAD/probe')}
                            ${dim('gateway and seeds the serving one for the backend in use, so passing only it still does what you meant.')}
    ${g('--storage-signer')} arweave|eth   who signs+pays Turbo (arweave) uploads: the CLI-managed key (default) or your ${g('.env')} EVM key
                            ${dim('(eth reuses credits you funded on that wallet; with --sign your browser wallet pays instead)')}
    signing: ${g('--send')} hot/env key ${dim('(default — a bare deploy signs + sends)')} · ${g('--sign')} wallet page · ${g('--unsigned')} print tx
    ${dim('No key in .env? Deploy from your own wallet: ')}${g('--sign --for <your-addr>')}${dim(' (you approve in the browser; nothing is pasted).')}
    ${g('--dry-run')}             preview (commitment · URIs · mint plan · approvals) WITHOUT sending or storing
                            ${dim('(needs a deployer to compute anything address-dependent — pass --for 0x.. if no signing key is set)')}
                            ${dim('address only prints WITH --salt (it is the only thing that pins it) — without --salt this shows the salt + how to pin it, or use `abx predict`.')}
    ${g('--confirm')}             interactive y/N gate before the real send (opt-in; --yes or non-TTY proceeds)
    ${bold(g('--copies <n|open>'))}     ${dim('routes to the ERC-1155 edition twin (OneOfOneEdition) — copies of the SAME work, not a unique token.')}
                            ${g('open')} = an uncapped OPEN EDITION (the flagship edition product) · a number = that many copies max.
                            ${g('--copies 1')} is legal (a single-copy edition) but almost never what you want — drop --copies for the plain 721 lane instead.
                            Adds: ${g('--mint-amount <n>')} (copies of #0 to premint at deploy; default 1, 0 ≡ --no-mint) ·
                            ${g('--minter 0x..')} · ${g('--primary-payee 0x..')} · ${g('--unpaused')} ${dim('(the sale stack — OPTIONAL, and available only on an edition. Omit them and the')}
                            ${dim('edition deploys paused with no sale, which is the common case: price + allocation are set AFTER deploy with')} ${g('abx minter configure')}${dim(' either way.)')}
                            ${g('--721c')} enrolls ERC-1155C instead of 721C — same flag, same UX, same validator grammar.
                            ${dim('--onchain-image works on the hot AND wallet (--sign) lanes; the cold lane (--unsigned) is refused everywhere,')}
                            ${dim('721 and edition alike — each chunk tx feeds the next, so staging cannot be signed offline in one run.')}`,
  'deploy-series': `
  ${bold('abx deploy-series')} --dir <folder> ${dim('— deploy a MULTI-TOKEN collection (one contract, N tokens) from a folder of media. Sends a tx.')}
    --dir <folder>        media directory; files sort → token ids 0,1,2,… (metadata = token id)
    --count <n>           deploy fewer than the folder holds (default: all files)
    --name <s> --symbol <s>   identity   --royalty-bps <0-10000> (default 500)   --royalty-cap <0-10000> (default 10%, reduce-only)   ${g('--burnable')} (opt-in)
    mint timing: ${g('--mint-all')} (mint every token at deploy) · ${g('--mint-count')} N (first N) · ${g('--no-mint')} (defer)
    ${bold('image custody')} — how the work is stored + resolved:
      ${g('--onchain-image')} [--compress fastlz]   bytes ON-CHAIN (chunk store) — small content (~200 gas/byte to write, and
                            ${dim('~360-405k gas/KB per tokenURI to READ, climbing with size. No size is refused: under ~117KB every endpoint')}
                            ${dim('serves the read, above it abx measures your RPC and says who else can. Per token — a big collection of small files reads fine.)')}
      ${g('--onchain-uri --backend arweave|ipfs|cloud')}   image OFF-CHAIN, JSON on-chain via the renderer — ${bold('NO server')};
                            same-extension folders upload as ONE directory/manifest → a single collection url-template (O(1)).
                            ${dim('cloud/S3 also needs --public-base <bucket-or-cdn-url>')}
      --public-base-url <url>   hosted resolver (off-chain custody; you run a node) — for mutable metadata
    --description "<s>" · --external-url <url>   collection identity, served in the metadata (set them or the description is boilerplate)
    --creator "<s>" · --license "<s>"   authorship + rights, ON-CHAIN collection fields served in contractURI (also --display-notes, --creator-links)
    ${g('--attributes <file.json>')}   ${bold('per-token marketplace traits')} (written ON-CHAIN): a JSON ARRAY indexed by token id, OR an OBJECT
                          keyed by filename / token id — each value an attributes array or a ${dim('{name: value}')} map. Small/medium series;
                          a huge collection should set traits post-deploy via ${g('abx set-field')} under a gas budget.
    --minter 0x..         authorize a single minting contract   --primary-payee 0x..   primary-sale payout
    --unpaused            open the mint at deploy (default: paused ⇒ owner-only until ${g('abx unpause')})
    ${g('--721c')} [recommended|0x..]   opt-in ERC-721C: enroll at deploy, PERMANENTLY, with that transfer validator (absent = plain
                          ERC-721 forever). ${g('recommended')} = OpenSea's creator-fee-enforcement validator. Manage: ${g('abx set-transfer-validator')}
    --salt 0x.. · --backend … (storage override) · ${g('--storage-signer')} arweave|eth (who pays Turbo uploads) · signing: ${g('--send')} · ${g('--sign')} · ${g('--unsigned')}
    ${g('--ipfs-gateway')} <prefix> / ${g('--arweave-gateway')} <prefix>   where an ipfs/arweave image is SERVED from — written on-chain as
                            a collection preference, repointable later with ${g('abx set-gateway')} (one tx, no re-upload).
                            ${dim('Unset = the public floors')} ${bold('https://ipfs.io/ipfs/')} ${dim('and')} ${bold('https://arweave.net/')}${dim('. Plain')} ${g('--gateway')} ${dim('is the UPLOAD/probe')}
                            ${dim('gateway and seeds the serving one for the backend in use, so passing only it still does what you meant.')}
    ${g('--dry-run')}             preview (per-token plan · custody · mint plan · approvals) WITHOUT sending or storing
                            ${dim('(needs a deployer to compute anything address-dependent — pass --for 0x.. if no signing key is set)')}
                            ${dim('address only prints WITH --salt — without it this shows the salt + how to pin it, or use `abx predict --dir <folder>`.')}
    ${g('--confirm')}             interactive y/N gate before the real send (opt-in; --yes or non-TTY proceeds)
    ${bold('Common patterns')} ${dim('(append --dry-run to preview; add --sign --for <your-addr> to sign in your wallet when no key is in .env):')}
      ${dim('# a folder of photos → permanent images on Arweave, JSON on-chain, NO server (the usual choice):')}
      ${g('abx deploy-series')} --dir ./photos --name "My Series" --symbol MS --onchain-uri --backend arweave --mint-all --sign
      ${dim('# decentralized images on IPFS instead (needs a pinning service + dedicated gateway):')}
      ${g('abx deploy-series')} --dir ./photos --name "My Series" --symbol MS --onchain-uri --backend ipfs --mint-all --sign
      ${dim('# tiny SVGs → fully on-chain (no storage at all):')}
      ${g('abx deploy-series')} --dir ./svgs --name "My Series" --symbol MS --onchain-image --compress fastlz --mint-all --sign
    ${bold(g('--copies <n|open>'))}     ${dim('routes to EditionImage — N ids from the folder, each × --copies copies (open = uncapped per id).')}
                          --mint-all/--mint-count keep their meaning (how many DISTINCT ids premint); new ${g('--mint-amount <n>')}
                          sets copies of EACH premint id (default 1). --721c enrolls ERC-1155C instead of 721C.
                          ${dim(ABX_CAPABILITIES.deploymentCommands.deploySeries.edition.summary + '. --onchain-image uses hot or wallet signing; --unsigned is refused.')}`,
  preview: `
  ${bold('abx preview')} (--script <file.js> | --code-dir <dir>) ${dim('— run the program on localhost, live. No chain, no key, no deploy.')}
    ${g('--schema key:Type:Auth')}[,…]  declare PostParams so the studio gives you real inputs for them (e.g. palette:HexColor:TokenOwner)
    ${g('--dep <name@version>')}[,…]    load a library the way the resolver would (built-in CDN map; on-chain refs can't be fetched offline)
    ${g('--port')} <n>                  studio port (default ${DEFAULT_PREVIEW_PORT}; the resolver's ${DEFAULT_PORT} stays free)
    ${g('--shoot')} <dir>               render headlessly to PNGs + traits.json and EXIT ${dim('(for an agent that has no browser)')}
    ${g('--count')} <n>                 seeds to shoot / show in the grid (default 9)   ${g('--width')} <px>   ${g('--timeout-ms')} <n>
    Serves the ${bold('same document the generator serves')} — real ${g('abx.js')}, real tokenData shape, real dep tags — with a synthetic
    seed, so what you iterate on is what deploys. Routes: ${g('/')} studio (seed + params + live traits) · ${g('/grid')} N seeds at once,
    all live · ${g('/view')} the bare document. The program is re-read from disk per render, so ${bold('edit and refresh')} — no watcher.
    Unlike a still-image sweep this shows ${bold('animation')}, which is most of what a screenshot throws away.
    ${dim('Still do both after the work settles:')} ${g('abx inspect')} ${dim('(is it wired right?) and a testnet deploy (the faithful end-to-end).')}
      ${g('abx preview')} --script art.js --schema palette:HexColor:TokenOwner
      ${g('abx preview')} --script art.js --shoot ./frames --count 12`,
  inspect: `
  ${bold('abx inspect')} <script.js> ${dim('— static analysis of a generative script + a lane recommendation. Read-only; the script is never executed.')}
    ${g('--dep <name@version>[,…]')}   the on-chain deps you plan to declare, so the assembled-document size estimate is realistic (e.g. --dep p5@1.0.0)
    Reports: script size → on-chain chunks; detected libraries; the traits the script reports AND whether they can be
    reproduced ON-CHAIN (seeded p5 LCG + integer/threshold traits → exact; Math.random / float-boundary → not); the
    estimated assembled document size → whether a single ${g('tokenURI')} eth_call fits (template/fully-on-chain viability).
    Ends with a recommended lane (fully-on-chain / resolver / directory). Run it BEFORE ${g('abx deploy-code')} to derive the
    lane instead of guessing. Deep dive: docs.abx.io/docs/protocol/renderers`,
  'scaffold-renderer': `
  ${bold('abx scaffold-renderer')} [<dir>] ${dim('— compatibility alias for `abx scaffold solidity`; new automation should use the nested command.')}
    Writes the same role-separated Foundry workspace. [--force write into a non-empty dir]`,
  scaffold: `
  ${bold('abx scaffold solidity')} [<dir>] ${dim('— one buildable Foundry workspace for ABX Solidity extension roles (default: ./my-abx-solidity). No tx.')}
    Separate deployable contracts cover image/traits rendering and configure/transfer/augment hooks. Canonical 721/1155
    minters and every interface come from the exact-pinned ${g('abx-contracts')} Soldeer package; no vendored copies and no
    invented "minter hook" role. Use only the roles your project needs. [--force write into a non-empty dir]`,
  'deploy-code': `
  ${bold('abx deploy-code')} (--script <file> | --code-dir <dir> | --image-renderer 0x.. [--attributes-renderer 0x..]) ${dim('— deploy a generative / code project (SeriesCode). Sends tx(s). Needs a hosted resolver OR --onchain-uri.')}
    ${g('--script <file>')}      template mode: the program stored ON-CHAIN in chunks (auto-split ~22KB); zero-dependency vanilla JS is cleanest
    ${g('--code-dir <dir>')}     directory mode: a build folder (must contain ${bold('index.html')} + your own ${g('abx.js')} copy that reads
                          ${g('abx.tokenData')} and calls ${g('abx.traits({…})')}) uploaded to storage; its root becomes the on-chain ${g('code')} field.
                          The live view 302s to the gateway, so the gateway ${bold('MUST serve HTML')} (a dedicated Pinata gateway or Arweave — never the shared public one)
    --name <s> --symbol <s>   ERC-721 identity   --royalty-bps <0-10000> (default 500)   --royalty-cap <0-10000> (default 1000, reduce-only)   ${g('--burnable')}
    ${bold('--public-base-url <url>')}   the resolver you run (${bold('REQUIRED')} unless --onchain-uri — a code project resolves live on-chain state; localhost/missing is refused)
    ${g('--resume')} <address>    ${bold('FINISH an existing contract whose setup transaction failed')} — deploys nothing. A code deploy is TWO
                          txns (create the clone, then one atomic setup multicall); when the second fails you own a
                          live-but-unusable contract AND the salt for its address is spent, so the pinned-salt re-run can
                          never work. Pass the SAME content flags the original deploy used: it reads what is already
                          on-chain and sends only what is missing, in one transaction. Chunks compare by CONTENT (so a
                          hand repair is respected), schemas are left alone if present (re-writing one is an upsert that
                          can strand values), and mints are a SHORTFALL against current supply — never a re-send, since a
                          token cannot be un-minted. Nothing missing ⇒ it sends nothing and says so.
                          ${dim('Refuses --salt / --721c / --bootstrap-factory / --mint-all / --copies: those describe how a contract is CREATED.')}
                          ${dim('EditionCode targets work too (pass the SAME --copies-lane content flags, minus --copies itself): the four')}
                          ${dim('non-mint legs diff identically; mints are a per-id shortfall against that id\'s own totalSupply(id), one')}
                          ${dim('mint(to,id,amount) call per short id — pass --mint-count/--mint-amount to name the intended premint plan.')}
    ${g('--onchain-uri')}         the CHAIN-COMPLETE lane: tokenURI/contractURI resolve ON-CHAIN via the canonical metadata renderer, and
                          animation_url is COMPUTED on-chain by the canonical ${bold('AbxGenerator')} (template: the full HTML document;
                          directory: a parameterized gateway URL — 8KB URL budget, gateway liveness applies). No resolver base is baked
                          (no --public-base-url needed); the param surface is enumerated ON-CHAIN, so there is nothing to declare or
                          keep in sync. The marketplace still is rendered off-chain by the effect runner ${bold('for a JS program')} (--script/--code-dir) — but with ${g('--image-renderer')} the image is computed ON-CHAIN too (nothing to render). Verify with ${g('abx verify <addr>')}.
                          (--generator 0x.. / --renderer 0x.. override the canonical singletons; ABX_GENERATOR / ABX_RENDERER via env.)
    --schema key:Type:Auth,…   governed PostParams (e.g. ${g('palette:HexColor:TokenOwner')}) — set values later with ${g('abx configure-param')},
                          change the SCHEMA later with ${g('abx set-schema')}. Mint-time snapshot / veto / live derivation are hooks, not schema flags — wire them after deploy with ${g('abx set-param-hooks')}. An Address leg names its writer inline —
                          ${g('key:Type:Address(0x…)')} (a CONTRACT may hold it: the controller pattern for open participation).
                          Append ${g(':lock=<when>')} (ISO date, unix seconds, or ${g('now')}) to freeze the value after that time.
                          ${dim('repeatable OR comma-separable (like --dep): ')}${g('--schema a --schema b')}${dim(' ≡ ')}${g('--schema a,b')}
                          Type ∈ Bool·Select·Uint256Range·Int256Range·DecimalRange·HexColor·Timestamp·String·Bytes; Auth ∈ Creator·TokenOwner·Address (+ Or-combos).
                          ${bold('a Select declares its options')}: ${g("'mood:Select[Calm|Wild|Chaotic]:TokenOwner'")} ${dim('(quote the whole value — zsh glob-expands the brackets otherwise)')}; ${bold('a Range takes bounds')}: ${g("'density:Uint256Range[0..100]:TokenOwner'")} (Int/Decimal/Timestamp too; bounds optional)
    --description "<s>" · --external-url <url>   collection identity, written as ON-CHAIN collection fields in the deploy tx
    --creator "<s>" · --license "<s>"   authorship + rights, ON-CHAIN collection fields served in contractURI (also --display-notes, --creator-links)
    ${g('--image-renderer 0x..')}   THE in-chain-renderer lane: bake the on-chain ${g('image')} to a Solidity IAbxFieldRenderer → the SVG is COMPUTED
                          on-chain from the token's seed + params (fork ${g('SeedSvgRenderer.sol')}). No ${g('--script')} needed; no bucket, no runner, no
                          resolver — the marketplace still lives in ${g('tokenURI')} itself. Mutually exclusive with ${g('--image-base')} (both set ${g('image')}).
    ${g('--image-base <url>')}    bake the on-chain ${g('image')} as a url-template (${g('{base}/{id}.png')}) — the marketplace thumbnail lives OFF-CHAIN at a
                          ${bold('deterministic per-token URL')} the chain names; the effect runner overwrites each key on mint/update (no metadata resolver,
                          no chain rewrite on re-render). Use a mutable host (S3/R2/CDN) + ${g('ABX_S3_PUBLIC_BASE')}; NOT ipfs/arweave (content-addressed).
    ${g('--attributes-renderer 0x..')}   bake the on-chain ${g('attributes')} to an IAbxFieldRenderer → traits COMPUTED on-chain in tokenURI (fully on-chain
                          traits, no resolver; fork ${g('SeedTraitsRenderer.sol')}). See ${g('abx inspect')} for whether a JS script's traits reproduce on-chain.
    ${g('--dep <ref>')}          declare a code dependency (template mode) — repeatable AND comma-separable; ${bold('ORDERED: the first --dep is index 0 = the runtime')}, by convention.
                          ref auto-detects: ${g('name@version')} (e.g. ${g('p5@1.0.0')} — AB registry naming; resolves through the registry pointer)
                          or ${g('0x…')} (an on-chain data contract, read directly). Legs ride the one setup multicall.
    --dep-registry 0x..   the soft registry pointer for name@version refs (default: the chain's ${bold('AB Dependency Registry')};
                          none known → warned + skipped — never blocks). Registry deps are existence-checked before deploy (best-effort;
                          a CDN-served record is the normal production path, on-chain bytes are the durability floor).
    --max N               supply cap (default 16)   mint timing: ${g('--mint-all')} · ${g('--mint-count')} N · (default: defer, then ${g('abx mint')})
    --no-seed             opt out of a mint-time seed entirely (seeds settle once assigned; curated pre-set seeds win)
    ${g('--seed-source 0x..')}    WHERE the mint seed comes from. Default (omit it) = the canonical ${bold('AbxSeedSource')} we deploy;
                          ${g('canonical')} says that out loud. Pass an address for ${bold('your own IAbxSeedSource')} — commit-reveal, a VRF
                          oracle, a curated queue. ${bold('Probed before any gas')}: it must answer ${g('seed(uint256,address)')} with 32 bytes,
                          else the deploy is refused (a bad source is silent until the first buyer, then every mint reverts).
                          ${dim('the canonical seed is PSEUDORANDOM — replayable after the mint, and computable DURING it (a buyer can decline an')}
                          ${dim('outcome; on an edition, where the BUYER names the id and the id feeds the seed, they can also shop the unminted')}
                          ${dim('ids): right for diversifying output, NOT strong enough for a raffle or prize draw. Need that? that is what')}
                          ${dim('--seed-source is for. Change it later with ')}${g('abx set-seed-source')}${dim(' (future mints only).')}
    ${g('--721c')} [recommended|0x..]   opt-in ERC-721C: enroll at deploy, PERMANENTLY, with that transfer validator (absent = plain
                          ERC-721 forever). ${g('recommended')} = OpenSea's creator-fee-enforcement validator. Manage: ${g('abx set-transfer-validator')}
    --backend ipfs|arweave   directory-mode custody for the build upload   ${g('--unpaused')} · --minter 0x.. · --primary-payee 0x..
    ${g('--ipfs-gateway')} <prefix> / ${g('--arweave-gateway')} <prefix>   where an ipfs/arweave image is SERVED from — written on-chain as
                            a collection preference, repointable later with ${g('abx set-gateway')} (one tx, no re-upload).
                            ${dim('Unset = the public floors')} ${bold('https://ipfs.io/ipfs/')} ${dim('and')} ${bold('https://arweave.net/')}${dim('. Plain')} ${g('--gateway')} ${dim('is the UPLOAD/probe')}
                            ${dim('gateway and seeds the serving one for the backend in use, so passing only it still does what you meant.')}
    ${dim('a fixed-price PRIMARY SALE is set up AFTER deploy, not by these flags: ')}${g('abx minter configure <addr> --price <eth>')}${dim(' → ')}${g('set-minter')}${dim(' → ')}${g('set-primary-payee')}${dim(' → ')}${g('unpause')}${dim(' (see `abx minter --help`). --minter/--primary-payee here only pre-authorize an already-known minter.')}
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} ${dim('(needs --for 0x..)')}   ${g('--bootstrap-factory')} ${dim('(private chains/sandboxes only)')}
    ${g('--yes')}                 accept inferred --name/--symbol defaults (the real send otherwise REFUSES to bake placeholders)
    ${g('--dry-run')}             preview (resolver base · schema · mint plan · tx count · approvals · render/storage combo) — nothing sent
                            ${dim('address only prints WITH --salt — without it this shows the salt + how to pin it, or use `abx predict --script/--code-dir ..`.')}
    ${g('--confirm')}             interactive y/N gate before the real send
    ${bold('After deploy — render the marketplace still')} ${dim('(JS lanes only — --script/--code-dir; with --image-renderer the image is on-chain, nothing to render)')}:
      continuous: ${g('abx deploy-effects --resolver-url <resolver>')}  ·  one-shot: ${g('abx render <addr> --remote <resolver>')}  ·  check it landed: ${g('abx verify <addr>')}
    ${bold(g('--copies <n|open>'))}     ${dim('routes to EditionCode — a generative drop minted as copies (N ids × --copies copies each, open = uncapped).')}
                          --mint-count/--mint-all keep their meaning; new ${g('--mint-amount <n>')} sets copies of EACH premint id (default 1).
                          --721c enrolls ERC-1155C instead of 721C. ${g('--dep')}/${g('--dep-registry')} ${dim('WORK here (on-chain deps resolve on Sepolia,')}
                          ${dim('where the registry lives — on Base Sepolia the pointer leg is skipped with a warning and the drop is NOT chain-complete).')}
                          ${bold('--image-renderer')}/${bold('--attributes-renderer')} ${dim('WORK here')} — with ${g('--onchain-uri')} that is a TRUE ERC-1155
                          ${dim('edition whose image + traits are computed in Solidity: open supply, minted over time, no server, no still to')}
                          ${dim('render. --script is then optional (a renderer-only edition stores no program and has no animation_url).')}
                          ${bold('--code-dir')} and ${bold('--image-base')} ${dim('WORK here too')} — a directory build serves the same
                          ${dim('parameterized live view, and --image-base bakes a per-id url-template that resolves for EVERY id in the')}
                          ${dim('space (an id with no live copies is simply excluded from the RENDER sweep, not given a placeholder).')}
                          ${dim('Still refused in code (not silently ignored): --no-delegation — EditionCode has no TokenOwner-leg')}
                          ${dim('delegation to opt out of.')}
                          ${dim('`--resume <address>` (see its own entry above) IS wired for EditionCode targets — pass the same content flags')}
                          ${dim('minus --copies; mints diff as a per-id shortfall.')}`,
  render: `
  ${bold('abx render')} <address> [tokenId…] ${dim('— render missing stills + traits for a code project (the effect runner repair lane). Read-only on-chain (no tx).')}
    Renders each ${bold('minted')} token whose still is missing at the CURRENT inputsHash (a param change re-addresses it → a plain render fills it in).
    No tokenId → sweeps all minted tokens; pass ids (${g('0 1 2')}) to target specific tokens.
    ${g('--force')}               RE-RENDER even when the still already exists — the fix for a bad / blank / timed-out capture
                          (the render is otherwise deterministic, so a plain render idempotent-skips an existing still). Overwrites it (+ republishes on --remote).
    ${g('--remote [name|url]')}   register each render with a REMOTE resolver: the bytes go to ${bold('ABX_STORAGE_BACKEND')} (YOU hold them), and
                          POST /v1/effect-artifacts hands the resolver the URL — it redirects there and never proxies. Traits are the
                          exception: they stitch into the token JSON, so their content (≤64KB) goes to the resolver itself.
                          ${bold('Requires a backend that can name a public URL')} — ${g('--backend cloud')} (S3/R2 + public base), ${g('ipfs')}, or ${g('arweave')};
                          equal options, pick on cost/ops. The default ${g('fs')} is refused up front rather than after the render.
                          Idempotent; a re-run re-registers rows on a resolver that lost them. Needs its token (a named remote's
                          ${g('ABX_REMOTE_<NAME>_TOKEN')}, else ${g('ABX_REMOTE_SELF_TOKEN')}).
    --effects-url <url>   enqueue on a running effect-runner service instead of rendering inline (else ${g('ABX_EFFECTS_URL')})
    ${dim('Inline (no --remote) renders on THIS machine (needs `npx playwright install chromium` once), pointing Chromium at the live')}
    ${dim(`view of ${g('ABX_RESOLVER_URL')} (else your configured base / local ${g('abx serve')}), and stores to the resolved backend.`)}
    ${dim('A hosted resolver reads its OWN store, so a local fs render does NOT reach it — use --remote (publishes) or a shared/public backend.')}
    ${dim(`For CONTINUOUS auto-render (every new mint + param change), run ${g('abx effects')} beside your resolver instead of re-running this.`)}`,
  effects: `
  ${bold('abx effects')} ${dim('— run the reference effect runner LOCALLY, in-process (the local counterpart to `abx deploy-effects`). BLOCKS — background it.')}
    The resolver's ${bold('chain watcher')} notifies this runner the moment settled state changes (a mint, a ${g('configure-param')} —
    from ANY tool, not just this CLI) → it renders whatever is missing at the CURRENT settled inputsHash. ${bold('auto-render')},
    no manual ${g('abx render')}. Point the resolver at it: ${g('ABX_EFFECTS_URL=http://localhost:<port>')}. Needs a local Chromium
    (${g('npx playwright install chromium')} once).
    ${g('--once')}                sweep all projects a single time and exit (vs the per-project ${g('abx render <addr>')} repair lane)
    --port <n>            HTTP port (default ${g('ABX_EFFECTS_PORT')} / 8788) — ${g('POST /notify')} enqueues (watcher lane) · ${g('POST /run')} sweeps synchronously (command lane)
    ${g('--resolver-port')} <n>   point co-located mode at a local ${g('abx serve')} on a NON-default port (else ${g('ABX_RESOLVER_URL')}, else 8787).
                          Forces co-located (no token, shared store) even if a stale ${g('ABX_REMOTE_SELF_TOKEN')} is sitting in ${g('.env')} —
                          a bare ${g('abx serve')} never implements the control plane that token would try to authenticate.
    --interval-ms <n>     the SAFETY-FLOOR sweep (default ${g('ABX_EFFECTS_INTERVAL_MS')} / 300000) — catches a missed notify / cold start; the watcher is the trigger
    --concurrency <n>     parallel renders while draining (default ${g('ABX_EFFECTS_CONCURRENCY')} / 1 — Chromium is heavy; raise deliberately)
    ${dim('Co-located with a local `abx serve` (same store) → no tokens needed, any backend works (fs included). Different port? --resolver-port.')}
    ${dim('Against a REMOTE resolver: --remote <name|url> (its token registers renders + reports status), or ABX_RESOLVER_URL +')}
    ${dim('ABX_REMOTE_SELF_TOKEN — and a backend that can name a public URL (cloud/ipfs/arweave), since the resolver takes the')}
    ${dim('URL and refuses the bytes. PUBLIC runner? set ABX_EFFECTS_TOKEN — it gates /run + /notify.')}
    ${dim('To HOST the runner (fly/docker), use `abx deploy-effects`.')}`,
  'set-schema': `
  ${bold('abx set-schema')} <address> ${g('--schema key:Type:Auth[:lock=<when>]')} ${dim('— attach or replace ONE PostParam schema. Owner-only. Sends a tx.')}
    ${bold('SeriesCode/EditionCode only')} — a 1/1 or plain Series/Edition has no params store; this refuses before signing rather than reverting on chain.
    A project's param surface is NOT frozen at deploy: ${g('setParamSchema')} is owner-gated with no deploy-time restriction,
    so you can add a key a piece turned out to need without redeploying (and losing the address, mints, and collectors).
    ${bold('This is a full-row upsert, not a patch.')} Replacing an existing schema rewrites every field — restate anything you
    want to keep, including an existing ${g('lock=')}. The contract does ${bold('not')} re-validate values already stored under the key,
    so narrowing a bound, dropping a Select option, or changing the type strands them; that is refused unless you pass
    ${g('--force')}. A key can never be un-governed — to decommission one use ${g('abx retire-param')}.
    ${g('--force')}             apply a change that could strand already-stored values
    ${g('--dry-run')}           print the exact tx and send nothing`,
  'retire-param': `
  ${bold('abx retire-param')} <address> <key> ${dim('— permanently stop further writes to a PostParam. Owner-only. Sends a tx.')}
    Sets the schema's ${g('lockAfter')} into the past, so every later ${g('configure-param')} reverts ${g('ParamLockExpired')}. This is the
    closest the protocol comes to deleting a parameter, and it is ${bold('irreversible')}.
    Reads the current schema and changes ONLY the lock, so type/auth/bounds/options are carried forward untouched.
    What it does NOT do: remove the key (a governed key stays governed forever) or erase a value already stored — that
    value keeps serving in token data. A value written under a TokenOwner/Address leg came from a collector, and the
    creator deliberately cannot delete it.
    ${g('--dry-run')}           print the exact tx and send nothing`,
  'configure-param': `
  ${bold('abx configure-param')} <address> <tokenId|-> <key> <value> ${dim('— set a PostParam (typed, canonical encode). Sends a tx.')}
    ${bold('SeriesCode/EditionCode only')} — a 1/1 or plain Series/Edition has no params store; this refuses before signing.
    Reads the on-chain schema for <key> and canonically encodes <value> (${g('#rrggbb')} for HexColor, fixed-decimal ranges,
    Select by label, address, bool). Auth is per the schema leg (Creator=owner · TokenOwner — delegate.xyz honored · Address).
    A change ${bold('re-addresses renders')} → the still becomes a placeholder until you re-render (${g('abx render <addr> <id>')} or the runner).
    ${g('<tokenId> "-"')}        CONTRACT scope (owner-only raw setter; schema-less keys only) — the write path of well-known params
                          like ${g('display.animation')}. ≤31 printable-ASCII chars ride as a literal bytes32; longer takes the data path.
                          A contract-scope param applies to every token, and enumerates on-chain like any other.
    --file <path>         read the value from a file (String / Bytes payloads)
    ${dim('PAYLOAD TYPES:')} ${g('String')} ${dim('takes literal text (UTF-8).')} ${g('Bytes')} ${dim('takes')} ${bold('0x-prefixed hex')} ${dim(`or ${g('--file')} — a bare`)}
    ${dim('string is refused, because there is no safe guess between "these characters" and "these bytes".')}
    ${dim(`(The docs' "Bytes becomes base64" describes how your ${bold('program')} receives the value, not how you write it.)`)}
    ${g('--remote [name|url]')}  nudge a REMOTE resolver to re-index IMMEDIATELY after the change (else ABX_PUBLIC_BASE_URL) — it pings
                          the resolver's effect runner, so the thumbnail re-renders without waiting. Usually OPTIONAL now: a
                          resolver running the chain watcher (the ${g('abx serve')} default) sees the change on its next poll (~12s)
                          and auto-re-renders on its own. Keep --remote for a watcher-disabled resolver or when seconds matter.
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')} preview (encodes + shows the tx, sends nothing)`,
  'submit-app': `
  ${bold('abx submit-app')} <collection> ${dim('— list a deployed ABX collection in the App Store. Optional; not part of deploy. Sends txs.')}
    After ${g('abx deploy')} / ${g('deploy-series')} / ${g('deploy-code')} succeeds, offer this. It is an opt-in: factory events can
    find every ABX clone, but only minting into the App Store registry makes it an app entry.
    Does ${bold('not')} reuse the collection's ${g('--name')} / ${g('--description')} — those are NFT metadata. Confirm store copy
    with the creator (what someone can ${bold('do')}), then run this. The connected wallet must own the collection
    (or, on a retry, hold the entry token). ${g('built-on-abx')} is forced; the gated minter checks ${g('isAbxClone')} + owner.
    If the collection is already claimed, skips the mint and only writes params (same as the store's ${g('/update')} page).
    Metadata is split across a few signatures — one multicall of every field exceeds the chain's per-tx gas cap.
    ${g('--name')} <s>            listing title (required; ≤100 chars) — not the collection name unless the creator says so
    ${g('--summary')} "<s>"       one sentence, what someone can do (required; ≤240)
    ${g('--description')} "<s>"   full description (required; ≤2000)
    ${g('--mark')} <s>            icon monogram, ≤3 chars (default ${g('A/')})
    ${g('--tone')} acid|coral|blue|violet|amber|mint   icon color (default ${g('acid')})
    ${g('--category')} Create|Games|"Physical world"|Records|Coordination|Utilities|"Developer tools"   (default ${g('Create')})
    ${g('--stage')} Live|Prototype|Concept   (default ${g('Prototype')})
    ${g('--url')} https://…       launch URL (optional)
    ${g('--url-label')} "<s>"     launch button label (optional)
    ${g('--image')} https://…     custom icon URL (optional; otherwise the on-chain SVG from mark/tone)
    ${g('--tags')} a,b,c          up to 12 tags
    ${g('--registry')} 0x…        App Store registry (default: shipped address for this chain, or ${g('ABX_APP_STORE_REGISTRY')})
    ${g('--minter')} 0x…          gated minter (default: shipped address for this chain, or ${g('ABX_APP_STORE_MINTER')})
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')} preview (encodes + shows the txs, sends nothing)`,
  'set-param-hooks': `
  ${bold('abx set-param-hooks')} <address> ${dim('— wire/clear the three code-project param-lifecycle hooks (owner-only). Sends a tx.')}
    The three optional hook addresses a PostParams project may wire (${bold('SeriesCode/EditionCode only')} — static kinds have none):
    ${g('--configure 0x…')}     write-time veto/validator — a governed ${g('configure-param')} reverts if this hook reverts
    ${g('--augment 0x…')}       read-time derivation folded into tokenData — the opt-in to LIVE data (view reads chain per view)
    ${g('--transfer 0x…')}      ownership-change lifecycle, a ${bold('VETO')} — a revert here FAILS the transfer, and mints too (mint = transfer from 0x0)
    The contract has ${bold('no per-hook setter')} — it writes all three at once — so this READS the current trio and re-sends
    it with your change applied: ${bold('omit a role to keep it')}, pass an address to set it, or ${g('none')} to clear it. ${g('--clear')} clears all three.
    Run with ${bold('no flags')} to print the current hooks (mutates nothing).
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')} preview (encodes + shows the tx, sends nothing)`,
  'set-dependency': `
  ${bold('abx set-dependency')} <address> <index> <ref> ${dim('— declare/replace a code dependency at an index (owner-only). Sends a tx.')}
    <index>               ordered + dense (index ≤ dependencyCount) — ${bold('index 0 = the runtime')}, by convention
    <ref>                 ${g('name@version')} (e.g. ${g('p5@1.0.0')} — resolves through the soft registry pointer; AB naming convention)
                          or ${g('0x…')} (an on-chain data contract — read directly, no registry)
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')}`,
  'remove-last-dependency': `
  ${bold('abx remove-last-dependency')} <address> ${dim('— pop the LAST dependency (the list stays dense; order is load-bearing). Sends a tx.')}
    ${dim('to replace one in place, use')} ${g('abx set-dependency <address> <index> <ref>')} ${dim('instead.')}
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')}`,
  'set-dependency-registry': `
  ${bold('abx set-dependency-registry')} <address> <0x…|none> ${dim('— point the SOFT registry the name@version refs resolve through. Sends a tx.')}
    ${dim('soft + non-validating: it disambiguates resolution, never gates it — the declared refs stay either way.')}
    ${dim(`the usual value is the chain's AB Dependency Registry (deploy-code defaults it when --dep is used); 'none' clears.`)}
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')}`,
  'lock-dependencies': `
  ${bold('abx lock-dependencies')} <address> ${dim('— freeze the dependency set (list + registry pointer) FOREVER (irreversible). Sends a tx.')}
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')}`,
  'lock-script': `
  ${bold('abx lock-script')} <address> ${dim('— freeze the on-chain program (script chunks) FOREVER (irreversible). Sends a tx.')}
    ${dim('This is the lock that freezes the WORK of a code project — after it, setScriptChunk/removeLastScriptChunk revert.')}
    ${dim('lock-field/lock-uri only freeze metadata; the full set for a code drop is lock-script + lock-dependencies + lock-field/lock-uri.')}
    ${dim('That freezes what THIS contract stores — not necessarily what the token renders: params stay writable, and a')}
    ${dim('Registry dependency fetches its bytes live from a contract the registry owner can change. Say "locked metadata", not "immutable output".')}
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')}`,
  'replace-script': `
  ${bold('abx replace-script')} <address> ${dim('— safely replace an UNLOCKED code project\'s on-chain program. Sends a tx.')}
    ${g('--script')} <path>        the replacement program (same file shape as ${g('deploy-code --script')})
    ${g('--chunk-size')} <bytes>   override the default SSTORE2 split size (rarely needed)
    Refuses outright (never warns-and-proceeds) on a ${bold('locked')} script or a target that isn't SeriesCode/EditionCode.
    Diffs by CONTENT against what's on-chain now — an index that already matches is never re-sent (200 gas/byte).
    Fewer chunks than what's on-chain ⇒ the tail is popped with ${g('removeLastScriptChunk')} (no "remove N"; N queued calls).
    Every write + remove rides in ONE ${g('multicall')} — all-or-nothing, so a revert can never leave a HALF-APPLIED script.
    Reads the completed script back and verifies it reassembles EXACTLY to the file ${bold('before')} reporting success.
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')} preview (encodes + shows the tx, sends nothing)`,
  'lock-param-hooks': `
  ${bold('abx lock-param-hooks')} <address> ${dim('— freeze the three param-lifecycle hook addresses FOREVER (irreversible). Sends a tx.')}
    ${dim('The lock aimed at a BUYER, not at metadata: the transfer hook is a VETO (its revert fails a transfer, and a mint too),')}
    ${dim('so until this is sent the owner holds a standing power over whether a collector can sell. After it, set-param-hooks reverts.')}
    ${dim('You give up: arming a transfer veto, arming a configure veto, and re-pointing/clearing the augment hook. There is no way back.')}
    ${dim('With no transfer hook set, this is how you PROVE you can never add one. A hook already set stays live — freezing the SET is not disarming it.')}
    ${dim('Prints the exact three addresses it will freeze before it sends. SeriesCode/EditionCode only. Read it back with `abx state`.')}
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')} preview (encodes + shows the tx, sends nothing)`,
  state: `
  ${bold('abx state')} <address> ${dim('— read-only, on-chain operational snapshot (no tx, no local index).')}
    Shows owner · supply (minted / max, nextTokenId) · paused · minter · primary payee · royalty · renderer
    (+ the 721C transfer validator, for a collection that enrolled at deploy — plain ERC-721s show nothing new).
    Series-only fields are shown for a Series; a 1/1 shows just supply + royalty + renderer.
    ${dim('On an edition (OneOfOneEdition/EditionImage/EditionCode) the readout is per-id: id space (for the multi-id')}
    ${dim('twins), #0 copies/cap, paused/minter/payee/royalty/renderer — no whole-contract "supply" (there is none).')}
    ${dim('Full per-id breakdown: `abx tokens <addr>`. Enrolled editions show their 1155C validator (same rule as 721C).')}
    Handy before/after owner ops (mint · pause/unpause · set-minter · set-primary-payee).
    ${g('--json')}               the same facts as data (uncoloured, untruncated) — the machine path; narration moves to stderr.
    ${dim('state = what the CHAIN says. For who is SERVING it and how fresh that is, see `abx status`.')}`,
  predict: `
  ${bold('abx predict')} ${dim('— pre-compute a deploy address (read-only).')}
    --salt 0x..<64hex>    a fixed / vanity salt   --for 0x..   reserve to a deployer   --factory 0x..
    ${g('--copies <n|open>')}    ${dim('same flag as the deploy commands — predicts against the EDITION factory instead (OneOfOneEditionFactory /')}
                          ${dim('EditionImageFactory / EditionCodeFactory, chosen by --dir/--script exactly like the 721 lane picks Series/SeriesCode).')}`,
  mint: `
  ${bold('abx mint')} <address> ${dim('— mint the NEXT token (a 1/1\'s #0, or a Series\' next-in-order). Owner-only. Sends a tx.')}
    --to 0x..             recipient (default: the owner — pre-mint; a buyer = primary sale)
    ${g('--count')} <n>           mint N tokens in order in ONE tx (Series) — e.g. reserves/airdrops (do them BEFORE you unpause the sale)
    ${g('--json')}               ${g('{tokenIds, txHash, blockNumber, sent}')} on stdout — the TOKEN ID as data, read from the mint's own
                          Transfer logs (not by re-reading nextTokenId, which a concurrent mint would make wrong).
    ${dim('minting is sequential (by token id); repeat with different --to for an airdrop to N wallets.')}
    ${bold('editions')} ${dim('(OneOfOneEdition/EditionImage/EditionCode) mint COPIES of one id instead — --count is refused there:')}
    ${g('--token-id <n>')}       which id to mint copies of. Defaults to 0 on a 1/1-edition (its only id); REQUIRED on
                          EditionImage/EditionCode (ids are caller-named works — see \`abx tokens <addr>\` for existing ones)
    ${g('--amount <n>')}         copies to mint (default 1)
    ${dim('--token-id/--amount are refused on a 721 target; --count is refused on an edition — pointed either way.')}
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')} preview`,
  refresh: `
  ${bold('abx refresh')} <address> ${dim('— ask marketplaces to (re)index a token (read-only / external).')}
    --token <id>          default 0. Uses OPENSEA_API_KEY if set, else prints the marketplace links.`,
  transfer: `
  ${bold('abx transfer')} <address> ${dim('— move a token to a new holder (settle a sale/gift). Sends a tx.')}
    --to 0x.. (required)  --token <id> ${dim('(default 0; ')}${g('--token-id')}${dim(' is accepted as an alias — every other id-taking command spells it that way)')}
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')} preview
    ${bold('editions')} move COPIES of an id, not the whole token: ${g('--amount <n>')} (default 1) + ${g('--from 0x..')} ${dim('(REQUIRED — an')}
    ${dim('edition id can have many concurrent holders, so there is no single on-chain "the owner" to read the way a 721 ownerOf gives one).')}
    ${dim('--amount is refused on a 721 target (a token transfers as a whole).')}`,
  'set-token-uri': `
  ${bold('abx set-token-uri')} <address> ${dim('— re-point the token metadata. Sends a tx.')}
    --uri <base>          re-point the resolver BASE (contract derives {base}/{chainId}/{address}/{tokenId})
    --override <uri> [--token <id>]   pin ONE token to a fixed locator (e.g. ipfs://); "" clears it`,
  'set-contract-uri': `
  ${bold('abx set-contract-uri')} <address> ${dim('— re-point the collection metadata. Sends a tx.')}
    --uri <base>          re-point the collection BASE (derives {base}/{chainId}/{address})
    --override <uri>      pin the collection to a fixed locator (e.g. ipfs://); "" clears it`,
  'deploy-resolver': `
  ${bold('abx deploy-resolver')} --provider <fly|render|vps> ${dim('— scaffold a hosted, read-only resolver (the default off-chain path). No tx.')}
    --domain <host>       a domain YOU control to bake on-chain (re-point DNS, not chain, to move hosts)
    --app <name>          app/service name (default: from domain, else abx-resolver)
    --dir <path>          where to write the artifact (default: deploy/<provider>/)
    ${g('--from-source')}         DEV: build the image from vendored workspace source (no npm publish needed);
                          default is the self-contained npm image. (Sandbox sets ABX_RESOLVER_SOURCE=1.)
    writes a SELF-CONTAINED artifact (its own Dockerfile + config) + prints the next steps, the DNS record, and the bake reminder.`,
  'deploy-effects': `
  ${bold('abx deploy-effects')} --resolver-url <https://resolver> ${dim('— scaffold the effect runner (Playwright) as a HOSTED service (fly). No tx. For a LOCAL runner, use `abx effects`.')}
    --resolver-url <url>  the resolver to render for (reads token state + publishes renders back). Default: ABX_RESOLVER_URL / ABX_PUBLIC_BASE_URL
    --app <name>          fly app name (default: <resolver>-effects)
    --dir <path>          where to write the artifact (default: deploy/effects/)
    --interval-ms <n>     the SAFETY-FLOOR sweep (default: 300000) — the resolver's chain watcher notifies for immediacy
    generates + wires ${g('ABX_EFFECTS_TOKEN')} (gates the public runner's /run + /notify; the resolver's watcher sends it) and
    reminds you to point the RESOLVER's ${g('ABX_EFFECTS_URL')} here. The runner uploads each render to your ${bold('ABX_STORAGE_BACKEND')}
    home (ipfs/arweave/s3 — NOT fs for a hosted pair) and publishes a durable locator — or bytes — to the resolver.`,
  'mint-page': `
  ${bold('abx mint-page')} <token> ${dim('— scaffold a self-contained Next.js mint site for a collection (fixed-price minter). No tx.')}
    --dir <path>          where to write it (default: mint-page/)
    --name "<s>"          collection display name (default: the token's on-chain name)
    --rpc <url>           PUBLIC, keyless read RPC to embed (default: a public endpoint for the chain)
    --minter-contract 0x..   override the shared minter (else ABX_FIXED_PRICE_MINTER → manifest)
    Reads sale state + each token's image straight from chain (no backend); connect + mint via the
    injected browser wallet (no API keys). ETH sales in V1. Writes a runnable app + README (customize +
    deploy to Vercel). ${dim('Offer this after a sale is live (configure → set-minter → set-primary-payee → unpause).')}
    ${dim('Sells a Series or any edition (an edition page is an id + quantity purchase card via the 1155 minter).')}
    ${dim('Refuses the 721 1/1 only (no minter lane); deploy a one-token collection instead: abx deploy-series --dir <folder> --count 1')}`,
  'set-royalty': `
  ${bold('abx set-royalty')} <address> --bps <0-10000> [--receiver 0x..] ${dim('— change the royalty rate (stays <= the collection royalty cap). Sends a tx.')}`,
  'set-royalty-cap': `
  ${bold('abx set-royalty-cap')} <address> --cap <0-10000> ${dim('— LOWER the royalty ceiling (owner-only, reduce-only). Sends a tx.')}
    ${dim('The cap was fixed at deploy (default 10%, or the royalty rate if higher) and can only ever come DOWN, so buyers can trust a stated maximum.')}
    ${dim('Refused before signing if it would not decrease, or would drop below the live royalty rate. Emits MaxRoyaltyBpsUpdated. There is no way to raise it.')}`,
  'set-transfer-validator': `
  ${bold('abx set-transfer-validator')} <address> <0x..|none|recommended> ${dim('— manage an ERC-721C/1155C collection\'s transfer validator. Owner-only (one exception below). Sends a tx.')}
    <0x..>                re-point enforcement at that validator. ${dim('Must be a DEPLOYED contract AND must refuse a call it')}
                          ${dim('does not implement — probed before any gas, so a Safe / bare proxy / 7702-delegated EOA is refused:')}
                          ${dim('validateTransfer returns nothing, so such an address would enforce NOTHING while every read said ON.')}
    ${g('none')}                  suspend enforcement (validator → address(0); the collection STAYS enrolled)
    ${g('recommended')}           the chain's recommended validator (OpenSea's, for creator-fee enforcement)
    ${dim('Only for a collection that enrolled AT DEPLOY (--721c on the deploy commands) — a plain ERC-721 is refused')}
    ${dim('up front: enrollment is a deploy-time decision and can never be added (or fully removed) later.')}
    ${dim('Owner-only WHILE THERE IS AN OWNER: on a renounced collection (owner() == 0x0) ANYONE may send `none` to')}
    ${dim('suspend, and NOBODY may arm a validator again — the release valve for a stuck, abandoned collection.')}
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')} preview (encodes + shows the tx, sends nothing)`,
  'set-seed-source': `
  ${bold('abx set-seed-source')} <address> <0x..|canonical|none> ${dim('— re-point where a CODE project draws its mint seeds. Owner-only. Sends a tx.')}
    <0x..>                your own ${bold('IAbxSeedSource')} — commit-reveal, a VRF oracle, a curated queue. ${bold('Probed before any gas')}:
                          it must answer ${g('seed(uint256,address)')} with 32 bytes, or every mint would revert. Refused if it can't.
    ${g('canonical')}             the shared ${bold('AbxSeedSource')} ABX deploys — pseudorandom, and the default at deploy
    ${g('none')}                  stop drawing seeds (future mints get none; a generative program expecting one renders blank)
    ${dim('FUTURE MINTS ONLY — a seed settles the instant it is assigned, so nothing already minted changes. On a part-sold')}
    ${dim('drop that means the collection spans two sources; the change is public (SeedSourceSet), but early buyers are not told.')}
    ${dim('Code projects only (`abx deploy-code`) — an image 1/1 or Series has no seed source, and one cannot be added.')}
    ${dim('Set it at birth instead with')} ${g('abx deploy-code --seed-source 0x..')}${dim('.')}
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')} preview (encodes + shows the tx, sends nothing)`,
  attach: `
  ${bold('abx attach')} <address> <key> <uri> [<key> <uri> …] ${dim('— attach named file(s) to a token. Sends ONE tx.')}
    ${dim('The data-plane verb: each file joins the token\'s served')} ${bold('artifacts')} ${dim('manifest as {key, mimeType, uri}.')}
    <key>                 any name YOU choose (print · certificate · stems · readme · source) — how it appears in the manifest
    <uri>                 the file's locator; representation is ${bold('auto-detected')} from the scheme (ipfs → ipfs, ar → arweave, https → url)
    ${bold('Several pairs in one invocation become ONE transaction')} ${dim('— all-or-nothing, so a revert lands NONE of them. Attaching')}
    ${dim('artifacts one command at a time is what leaves a half-written token on a failure partway through, and a mint')}
    ${dim('cannot be undone. Every pair is validated before anything is sent, and a key repeated in one batch is refused.')}
    ${g('--file')} <path>          instead of a URI: store TINY bytes on-chain (SSTORE2, ≈200 gas/byte) — locators are the norm otherwise.
                          ${bold('Mutually exclusive with URI pairs')} — pass EITHER ${g('<key> <uri> […]')} OR ${g('--file')}, not both.
    --collection          attach to the collection scope · else --token <id> (default 0)
    ${g('--dry-run')}             preview the tx, send nothing   ·   signing: ${g('--send')} (default, needs a hot key) · ${g('--sign')} (browser wallet, no key) · ${g('--unsigned')}
    ${dim('Need the URI first? Upload the file with')} ${g('abx storage upload <path> --backend arweave|ipfs')} ${dim('— it prints the locator to pass here.')}
    ${dim('mimeType is declared from the URL EXTENSION (…/master.tiff → image/tiff) — give the file a real extension.')}
    ${dim('Surfaces in a resolver\'s artifacts listing (/data/<key> fetches it); a bare on-chain tokenURI shows reserved fields only —')}
    ${dim('params are chain STATE, read with')} ${bold('abx tokens')}${dim(' or tokenParamKeys/tokenParam (not projected into tokenURI); ATTACHMENTS need a resolver.')}
    ${dim('The image/animation are just reserved members of the same manifest. `artifacts` itself is COMPUTED — not settable.')}
    ${dim('Every write pings ERC-4906 (')}${g('MetadataUpdate')}${dim('/')}${g('BatchMetadataUpdate')}${dim(') the same way')} ${bold('set-field')} ${dim('does — see there for the token-vs-collection split.')}`,
  'set-field': `
  ${bold('abx set-field')} <address> --field <name> ${dim('— set an on-chain metadata field (the low-level primitive). Sends a tx.')}
    ${dim('To attach an off-chain FILE (the common case), prefer')} ${bold('abx attach')} ${dim('— it auto-picks the representation.')}
    --field <name>        a reserved display field (image · description · animation_url · external_url · attributes ·
                          background_color · …), a collection authorship/rights field with ${g('--collection')}
                          (creator · display_notes · creator_links · license), OR any custom key (which becomes an
                          ${bold('artifacts')} entry). NOT ${g('artifacts')}/${g('abx_params')}/${g('abx_provenance')} (computed).
    --text "<s>"          store literal UTF-8 ON-CHAIN (representation defaults ${g('inline')}) — NOT for an off-chain URL (use ${bold('attach')})
    --file <path>         store a FILE on-chain in SSTORE2 chunks behind the shared reader (multi-chunk)
                          ${dim('~360-405k gas/KB per tokenURI to READ it back (climbing with size). No size is refused: under ~117KB (~50M gas) every')}
                          ${dim('endpoint measured serves it; above that abx probes your RPC and reports its real cap before you spend.')}
    ${g('--compress')} none|fastlz|gzip   for --file (default none): ${g('fastlz')} = on-chain decode, stays renderable, cheaper storage;
                          ${g('gzip')} = smallest but off-chain decode only (sets the ${g('reader-gzip')} representation)
    --value 0x..          store raw bytes / hash (representation defaults keccak256)
    --representation <r>  ${dim('on-chain bytes:')} inline · inline-gzip · reader · reader-gzip · renderer ${dim('(computed at read)')}
                          ${dim('off-chain, verified:')} keccak256 · sha256   ${dim('· locators:')} arweave · ipfs · url · url-template ${dim('({id} → tokenId, so one field addresses a whole directory)')}
    ${g('--dry-run')}             preview the tx, send nothing
    --collection          target collection (ERC-7572) scope · else --token <id> (default 0)
    ${dim('Every write pings ERC-4906 —')} ${g('MetadataUpdate(tokenId)')} ${dim('for a token-scope write,')} ${g('BatchMetadataUpdate')} ${dim('for --collection.')}
    ${dim('4906-aware marketplaces (OpenSea included) self-refresh on it; nudge directly with')} ${g('abx refresh <address>')}${dim(' if one lags.')}`,
  'lock-field': `
  ${bold('abx lock-field')} <address> --field <name> ${dim('— freeze a metadata FIELD forever (irreversible). Sends a tx.')}
    --collection | --token <id>
    --force-field         proceed even if a PostParam shares this name (you mean the field)
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')}
    ${dim('FIELDS AND PARAMS ARE DIFFERENT NAMESPACES and may share a name. This locks the field only —')}
    ${dim(`to weld a PostParam use ${g('abx set-schema <addr> --schema <key>:<Type>:<Auth>:lock=now')}. Passing a`)}
    ${dim('declared param key here is refused, because locking the field leaves the param writable.')}`,
  'set-gateway': `
  ${bold('abx set-gateway')} <address> ${dim('— repoint where this collection\'s IPFS/Arweave content is SERVED from. Sends a tx.')}
    --ipfs <prefix>       e.g. ${g('https://ipfs.io/ipfs/')} or ${g('https://<you>.mypinata.cloud/ipfs/')} ${dim("· 'none' clears it")}
    --arweave <prefix>    e.g. ${g('https://arweave.net/')} ${dim("· 'none' clears it")}
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')}
    ${dim('The CID/txid in your fields is IDENTITY and never moves; this is only the https prefix a')}
    ${dim('marketplace concatenates onto it. So a dead or slow gateway is one tx, not a re-upload and')}
    ${dim('not a rewrite of image — and it works even on fields you have already locked.')}
    ${dim('Two flags, because a project can pay for a dedicated IPFS gateway and leave Arweave public.')}
    ${dim('Unset = the public default. Set it at deploy with')} ${g('--ipfs-gateway')} / ${g('--arweave-gateway')}${dim('.')}`,
  'set-renderer': `
  ${bold('abx set-renderer')} <address> ${dim('— toggle URI resolution between off-chain and on-chain. Sends a tx.')}
    (default)             point at the chain's canonical renderer (deploys it if needed) → resolve ON-CHAIN
    --renderer 0x..       use a specific (e.g. custom/creative) renderer instead
    ${g('--off')}                 clear the renderer → resolve off-chain again (the stored pointer)
    --collection          target the collection (ERC-7572) scope · else the token URI
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')}`,
  'lock-uri': `
  ${bold('abx lock-uri')} <address> ${dim('— freeze the URI config (pointer + renderer) FOREVER. Sends a tx.')}
    --collection          target the collection scope · else the token URI
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')}
    ${dim('with the fields also locked (lock-field), the stored metadata can never change again.')}
    ${dim('Locked metadata is NOT a locked OUTPUT: params have no lock, and a locked dependency POINTER can still resolve')}
    ${dim('to bytes someone else controls. Some tokens live-adapt to chain state on purpose — see')} https://docs.abx.io/docs/protocol/owner-powers/`,
  'set-admin': `
  ${bold('abx set-admin')} <address> --to 0x.. ${dim('— hand over contract ownership. Sends a tx.')}`,
  'set-minter': `
  ${bold('abx set-minter')} <address> --minter 0x..|none ${dim('— authorize the SINGLE minting contract (Series). Sends a tx.')}
    --minter 0x..|none    the minter to grant (replaces any previous); ${g('none')} clears to owner-only
    ${dim('this is a SEPARATE grant from `abx minter configure` — "configured" (on the minter) ≠ "assigned" (on the token).')}
    signing: ${g('--send')} · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')}`,
  'set-primary-payee': `
  ${bold('abx set-primary-payee')} <address> --payee 0x..|none ${dim('— declare where primary-sale proceeds go (Series). Sends a tx.')}
    --payee 0x..|none     the payout destination (a wallet or splitter); ${g('none')} clears
    ${dim('primary sales through the shared minter REVERT with no payee set — set this before you unpause.')}`,
  pause: `
  ${bold('abx pause')} <address> ${dim('— the mint safety switch: paused ⇒ OWNER-ONLY minting (minter + public blocked). Sends a tx.')}
    ${dim('the owner can always mint (reserves/config); `abx unpause` opens minting to the assigned minter / public.')}`,
  unpause: `
  ${bold('abx unpause')} <address> ${dim('— open minting to the assigned minter / public (Series). Sends a tx.')}
    ${dim('the pause is the sale on/off switch — run it LAST, after the minter is assigned + a primary payee is set.')}`,
  'set-max-invocations': `
  ${bold('abx set-max-invocations')} <address> --max <N> ${dim('— LOWER the supply cap (Series). Sends a tx.')}
    --max <N>             the new cap — MONOTONIC: can only DECREASE, and never below what's already minted (else it reverts)
    ${dim('Edition-only twin, one id finer:')} ${g('abx set-max-supply')} ${dim('(a per-id ERC-1155 cap, not the whole id space).')}`,
  'set-max-supply': `
  ${bold('abx set-max-supply')} <address> --token-id <n> --cap <n> ${dim('— edition-only: LOWER one id’s ERC-1155 supply cap. Sends a tx.')}
    ${dim('The per-id twin of')} ${g('abx set-max-invocations')}${dim(' (which caps the whole id space, not one id’s copies).')}
    --token-id <n>        the id to cap
    --cap <n>             the new cap — MONOTONIC: can only DECREASE, and never below that id's live supply (else it reverts)
    ${g('--cap open')}          ${bold('REFUSED')}${dim(': once set, a cap can only decrease — never back to uncapped. An id never')}
                          ${dim('overridden is already open (its --copies default from deploy); there is nothing to set.')}
    ${dim('Refused on a 721 target (use set-max-invocations instead).')}   signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')}`,
  'ping-uri': `
  ${bold('abx ping-uri')} <address> --token-ids <csv|range> ${dim('— edition-only, OWNER-ONLY: re-emit the native URI event. Sends tx(s).')}
    Re-emits ERC-1155's native ${g('URI(string,uint256)')} event for the given ids — the fix for a marketplace/indexer that
    only honors the native event, after a contract-wide re-point (${g('abx set-token-uri')} / ${g('abx set-renderer')}) which
    emits the ERC-4906 range form, not a per-id native event. ${dim('(721 has no equivalent verb — it has no native per-id URI event to re-emit.)')}
    --token-ids <csv|range>   e.g. ${g('0,1,2')} or ${g('0-99')} or mixed ${g('0-9,20,25-30')}
    ${dim('OWNER-ONLY on chain (`Uri1155.pingURI` is `onlyOwner`) — this block used to claim it was permissionless,')}
    ${dim('four lines under its own OWNER-ONLY header; a non-owner following that built a tx that reverted.')}
    ${dim('Chunks large id lists into several transactions (200 ids/tx) — each previews under --dry-run.')}
    ${dim('Refused on a 721 target.')}   signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')}`,
  doctor: `
  ${bold('abx doctor')} ${dim('— preflight readiness: agent skill, signing key/wallet, RPC health, canonical factory (721 + edition), storage.')}
    --for 0x..            also report that address's balance (fund before signing)
    ${g('--fix')}                 ${dim('install/resync the agent skill without asking (the one thing doctor can repair)')}
    ${g('--global')} · ${g('--agent')} <a>  ${dim('where --fix installs the skill (mirrors `abx skill install`)')}
    ${dim('Read-only apart from --fix. Interactively it OFFERS to install a missing/stale skill; a non-TTY')}
    ${dim('run changes nothing and just prints the command, so scripts and CI are never mutated.')}
    ${dim('a missing signing key is NOT fatal — the wallet lane (`--sign`) needs no key in `.env`.')}
    ${dim('Factory check covers the 721 1/1 factory + its edition twins (OneOfOneEditionFactory/EditionFactory/EditionCodeFactory)')}
    ${dim('and the shared fixed-price minters (721 + 1155) — "none yet" is informational, not a failure (the first --copies deploy stands one up).')}`,
  status: `
  ${bold('abx status')} [address] ${dim('— INDEXING status: where a project is in the lifecycle, and how fresh. Read-only.')}
    ${dim('bare')}                  this node: chain · factory · storage · data dir, then one line per project
    ${dim('<address>')}             one project in detail: lifecycle · scan floor · blocks indexed vs head · why, if unhappy
    ${g('--remote')} [name|url]    ask a SERVICE instead (your hosted node, or a managed provider) — same five words
    ${g('--watch')}               poll until everything reaches a terminal state (${g('live')} or ${c.orange}failed${c.reset})
    lifecycle: ${dim('queued')} → ${dim('backfilling')} → ${g('live')}  ·  ${c.orange}stale${c.reset} ${dim('(was live, now lagging — still serving)')}  ·  ${c.orange}failed${c.reset} ${dim('(carries a cause; retried with backoff)')}
    ${dim('status = who is SERVING it and how fresh. For what the CHAIN says (owner, royalty, locks), see `abx state`.')}`,
  vacuum: VACUUM_HELP,
  storage: `
  ${bold('abx storage')} <show|upload|status|balance|topup|backup-key> ${dim('— inspect / operate byte custody. Mostly read-only.')}
    ${g('show')}                  the resolved backend (fs | cloud | ipfs | arweave) + where each value came from   [${g('--check')}]
                          ${g('--check')}: a REAL read/write against the resolved config — cloud PUTs + GETs a tiny object through the
                          public base (catches the R2/S3 endpoint-vs-public-base trap); ipfs/fs reuse gateway/API reachability and
                          dir writability (no upload, no pin); arweave adds an identity+balance READ (no paid upload). Exit: 0 ok, 1 ✗.
    ${g('upload')} <path>         upload ONE file → prints its locator (the URI ${g('abx attach')} wants)   [--backend …] [--dry-run] [${g('--json')}]
    ${g('status')} <locator>      is it ${bold('RETRIEVABLE')} yet, not just accepted?   [${g('--json')}] [--gateway <url>] [--primary-only]
                          An upload service says "accepted" the moment it holds your bytes; a gateway serves them only once
                          they propagate — minutes, on Arweave. Probes YOUR gateway plus two others, because propagation is
                          per-gateway: ${g('ready')} (yours serves it) · ${g('propagating')} (another does, so the data provably exists —
                          ${bold('wait, do NOT re-upload')}) · ${g('unreachable')} (nothing does — still settling, or a bad locator).
                          Exits non-zero unless ready, so ${g('until abx storage status <loc>; do sleep 10; done')} is the whole wait.
    ${g('balance')} · ${g('topup')} --usd <n>   Turbo (arweave) upload credits   ·   ${g('backup-key')} --out <path>   copy the managed key`,
  demo: `
  ${bold('abx demo')} <${dim('no args')}> ${dim('— deploy a throwaway 1/1 to the testnet, index it, and serve it — a guided first run. Sends a tx.')}
    ${g('--sign')}               ${dim('approve in your browser wallet instead of a hot env key (no key needed)')}
    ${g('--for')} <0x…>          ${dim('pin who must connect on --sign (owner + royalty receiver + mint recipient)')}
  ${dim('--unsigned / --dry-run are refused here: both skip the broadcast, and the demo indexes + serves what it deployed.')}`,
  minter: `
  ${bold('abx minter')} <configure|show|buy> <token> ${dim('— sell a Series (or edition) via the shared fixed-price minter (Minter spine).')}
    ${g('configure')} <token> (--price <eth> | --price-raw <units>) --allocation <n> [--erc20 0x..]   ${dim('(token-owner only)')}
                          set the sale: price/token + how many THIS minter may sell. ETH by default; --erc20 prices in a token.
                          resolves (or deploys) the shared minter, then tells you what's still needed to go live.
    ${g('show')} <token>          the sale terms + readiness (assigned on token? primary payee set? paused? supply). Read-only.
    ${g('buy')} <token> [--to 0x..]   buy ONE token (public; any funded signer). ETH sales attach the price.
    ${dim('the full go-live: deploy-series → minter configure → set-minter <token> --minter <printed> → set-primary-payee → unpause')}
    --minter-contract 0x..   override the shared minter address (else ABX_FIXED_PRICE_MINTER → manifest)
    signing: ${g('--send')} (default) · ${g('--sign')} · ${g('--unsigned')} · ${g('--dry-run')} preview (safe — sends nothing)
    ${g('--json')} the deployed ADDRESS as data on stdout (narration → stderr). With ${g('--dry-run')}: the PREDICTED address + saltPinned.
    ${bold('editions')} ${dim('(OneOfOneEdition/EditionImage/EditionCode) route to the 1155 sibling minter, keyed (token, id):')}
    ${g('--token-id <n>')}       REQUIRED on every subcommand for an edition target — refused on a 721 target
    ${g('buy')} ${g('--quantity <n>')}   copies to buy in ONE purchase (default 1) — pays ${bold('price × quantity')} (shown in the dry-run/confirm readout)
    ${dim('--minter-contract here overrides ABX_FIXED_PRICE_MINTER_1155 → manifest (the edition minter), not the 721 one.')}`,
  add: `
  ${bold('abx add')} <address> ${dim('— register + index a project. Also edits off-chain display metadata + traits.')}
    --from-block <n> --factory 0x.. --label "<s>" --description "<s>" --external-url <url> [--full] [--yes]
    --traits "K=V; K2=V2" / --attributes <file.json>   set the off-chain operator traits (on-chain attributes always win)
    ${g('--remote [name|url]')}  target a REMOTE resolver instead of this machine — bridges the image locator (ipfs://…) + traits to it.
                          A ${bold('name')} reads ${g('ABX_REMOTE_<NAME>_URL')} + ${g('ABX_REMOTE_<NAME>_TOKEN')} from .env (a managed provider's API key);
                          a URL (or bare --remote = ${g('ABX_PUBLIC_BASE_URL')}) uses ${g('ABX_REMOTE_SELF_TOKEN')}. Inspect first: ${g('abx remote <name>')}
    --remote-token <t>    override the token for this invocation (--token means a token ID elsewhere, hence the name)
    ${g('--no-wait')}             ${dim('with --remote: return as soon as the service accepts it, instead of waiting out its catch-up.')}
                          ${dim('A service may answer "accepted, still indexing" (202) for a long backfill; by default abx polls')}
                          ${dim('to')} ${g('live')} ${dim('and prints the same summary. The registration is durable either way —')} ${g('abx status <addr> --remote')} ${dim('checks later.')}`,
  index: `
  ${bold('abx index')} [<address>] ${dim('— re-index from chain (read-only). Incremental by default.')}
    ${g('--full')}   force a full replay from the deploy block (the durability proof)   --yes   allow a very large scan
    ${g('--remote [name|url]')}  re-index on a REMOTE resolver (the post-deploy nudge)   ${g('--no-wait')}  don't wait out a deferred catch-up
    ${g('--to-block safe|finalized')}  stop at a REORG-SAFE boundary instead of the head — trades freshness for a block the
                          chain won't take back. Resolved to a concrete number before scanning, so the stored watermark is
                          never a tag. Some RPCs don't serve these tags; you'll get told rather than silently getting the head.`,
  verify: `
  ${bold('abx verify')} <address> ${dim('— re-hash the served bytes against the on-chain commitment (read-only; no resolver in the path).')}
    ${dim('Needs the project registered on THIS node first (`abx add <address>`) — it checks a local projection, so')}
    ${dim('"no resolver needed" is not "no setup needed".')}
    ${g('--remote [name|url]')}  verify what a REMOTE resolver actually serves (else ABX_PUBLIC_BASE_URL) — probes its \`/image\` (302→locator
                          or 200 bytes), so it accounts for a render PUBLISHED to that resolver. ${bold('Use this for a code project whose')}
                          ${bold('renders were published to a hosted resolver')} — a plain \`abx verify\` only checks THIS machine's store and will
                          report a false placeholder for a render that lives on the resolver.
    ${g('--json')}               the findings as data, with ${g('ok')} matching the exit code — so CI can gate on a byte mismatch
                          without parsing prose (a mismatch exits non-zero either way).
    ${dim('On-chain URI lane (a non-zero tokenURIRenderer / a generator-backed animation field): also eth_calls the generator')}
    ${dim(`${g('onChainStatus')} (branch · chain-complete · unresolved refs · URL budget) and decodes ${g('tokenURI')} straight from the contract.`)}`,
  tokenuri: `
  ${bold('abx tokenuri')} <address> [--token <id>] ${dim('— read tokenURI(id) straight from the contract on-chain + decode the JSON (read-only; no server).')}
    ${dim('The proof a fully on-chain token self-resolves: any RPC returns the renderer-assembled metadata. Default token 0.')}
    ${dim('On an edition (OneOfOneEdition/EditionImage/EditionCode) this reads the native')} ${g('uri(id)')} ${dim('instead — auto-detected, same flags.')}
    ${g('--fetch')}              FOLLOW the URL the contract commits to and print ${bold('what is actually served')} — the body a marketplace reads.
                          On a fully on-chain token there is nothing to fetch (the tokenURI IS the document) and it says so.
                          ${dim('This is also how you catch a provider mismatch: it shows what the BAKED base returns, so registering with')}
                          ${dim('one provider while another is baked on-chain shows up as their 404 rather than as a warning that guesses.')}
                          ${dim('A non-2xx exits non-zero under --json. A bad status here is about the SERVICE, never a mistyped path —')}
                          ${dim('the URL came from the chain, so it is right by construction.')}
    ${dim('Collection-level (ERC-7572) counterpart:')} ${g('abx contracturi <address>')}${dim('. Whole-collection counterpart:')} ${g('abx tokens <address>')}`,
  artifacts: `
  ${bold('abx artifacts')} <address> [--token <id>] ${dim('— read one token’s `artifacts` manifest DIRECTLY (read-only), instead of')}
    ${dim('fetching the whole tokenURI document and parsing it out. Default token 0. Reports every entry’s key/mimeType/uri')}
    ${dim('PLUS every registered effect row, current AND stale — a stale row renders it silently unlisted from the served')}
    ${dim('document, but stays visible here, labeled, so a param change that re-addressed a render is diagnosable.')}
    ${dim('None of this is on-chain data itself — every entry is a resolver-published projection (an on-chain-anchored')}
    ${dim('field, or an off-chain effect output); read `abx tokenuri` if you want the on-chain commitment, not a claim')}
    ${dim('about it.')}
    ${g('--remote [name|url]')}  read what a REMOTE resolver actually reports instead of this node's own projection — the
                          TRUTHFUL surface for a hosted drop, whose real artifact set lives there, not in this repo's
                          local store. Mirrors the ${g('abx verify')} / ${g('abx verify --remote')} split exactly.
    ${dim('Neither "not registered here" nor "not registered on that remote" is an error — both print a stable JSON shape')}
    ${dim('(')}${g('{surface, registered, available, reason, entries, effects}')}${dim(') and say what to do next, rather than failing the command.')}`,
  tokens: `
  ${bold('abx tokens')} <address> ${dim('— every token’s owner, seed, and params, read straight from the contract (read-only; no server).')}
    ${g('--json')}              the listing as data: ${g('{chainId, address, contractParams, tokens: [{tokenId, owner, seed, params}]}')} — verbatim,
                          uncoloured, untruncated. The machine path; the human table abbreviates owners only.
    ${g('--from <id>')}         first token id to read (default 0)      ${g('--limit <n>')}  read only n ids from there
    ${dim('For a generative collection the seed list IS the collection — this is the "what did the seeds actually deal?" read,')}
    ${dim('and the input to any distribution check before a real launch. Chain-only: no indexer projection and no running')}
    ${dim('resolver, because the params store enumerates its own keys on-chain and')} ${g('seed')} ${dim('is a reserved param read by name.')}
    ${dim('Traits are NOT here: a trait comes from running the script against the seed —')} ${g('abx render')}${dim(' does that.')}
    ${dim('On an edition (OneOfOneEdition/EditionImage/EditionCode) each row shows')} ${g('supply/maxSupply')} ${dim('instead of an owner')}
    ${dim('(an id can have many concurrent holders — not chain-enumerable outside the event log) — the header names the kind.')}
    ${g('--holder 0x..')}       ${dim('editions only: add a')} ${g('held')} ${dim('column —')} ${g('balanceOf(holder, id)')} ${dim('per id, so you CAN ask what one')}
                          ${dim('address holds (the question supply/cap cannot answer). Refused on a 721, where the owner column already says it.')}`,
  contracturi: `
  ${bold('abx contracturi')} <address> ${dim('— read contractURI() (ERC-7572 collection metadata) from the contract, FOLLOW it, and decode (read-only).')}
    ${dim('The collection-level counterpart of')} ${g('tokenuri')}${dim('. On-chain lane: decodes the data: URI. Off-chain lane: fetches the')}
    ${dim('URL the contract itself commits to and prints the JSON.')}
    ${bold('Never hand-build a resolver URL to check this')} ${dim('— the contract holds the answer, so a URL from here is right by')}
    ${dim('construction. A bad status is then about the SERVICE (unregistered project · wrong chain · down), never a mistyped path.')}`,
  forget: `
  ${bold('abx forget')} <address> ${dim('— drop a project’s local registration + projection. On-chain data is untouched.')}
    ${g('--remote [name|url]')}  deregister on a REMOTE resolver instead (it stops serving the project; re-add any time)`,
  remote: `
  ${bold('abx remote')} [<name|url>] ${dim('— inspect a remote service (read-only; registers nothing).')}
    Bare: list the named remotes in .env (${g('ABX_REMOTE_<NAME>_URL')} / ${g('_TOKEN')} — token shown as set/unset, never printed)
    plus the self-host default (bare --remote = ${g('ABX_PUBLIC_BASE_URL')} + ${g('ABX_REMOTE_SELF_TOKEN')}).
    With a target: fetch its PUBLIC ${g('/.well-known/abx-service')} descriptor — what it serves (interfaces), which chains
    (flags a mismatch with your ${g('ABX_CHAIN')}), whether ${bold('rendering is managed')} behind it (code drops then need no effects
    runner), and any provider-specific manual onboarding/recovery URL (${g('auth.signupUrl')}). The built-in ${g('abx')} remote uses
    ${g('abx auth login')} by default. With a token: lists the projects visible to it —
    ${bold('the one-command "is my provider key valid?" check')} (401 = fix the key · 403 = provider-side scoping, not a typo).

  ${bold('abx remote set')} <name> --url https://<host> ${dim('— install a THIRD-PARTY provider\'s token (the abx remote itself uses')}
    ${dim('`abx auth login` instead — OAuth, no token to paste). Writes')} ${g('ABX_REMOTE_<NAME>_URL')} ${dim('and')} ${g('ABX_REMOTE_<NAME>_TOKEN')}
    ${dim('to .env; the token is read from STDIN, never a command-line argument, and never printed:')}
    ${g('echo "$TOKEN" | abx remote set meridian --url https://meta.provider.xyz')}
    ${dim('(a real TTY prompts and waits for Enter instead — visible as you type, since masking isn\'t worth the added failure')}
    ${dim('surface; pipe it in if that matters to you). Re-running replaces the existing pair. Verify after with')} ${g('abx remote <name>')}.

  ${bold('abx remote')} <name|url> ${g('--conformance')} ${dim('— self-certify the service against remote-services.md; exits non-zero on any failure (CI-gateable).')}
    ${g('--remote-token <t>')}    the ONLY credential this needs — a bare URL + a token works with zero .env setup (third parties, CI)
    ${g('--chain-id <n>')}        + ${g('--address <a>')}: unlocks the full write loop (register → poll-to-live → status → reindex → deregister)
                          on a contract YOU own — needs BOTH together; without them only the read-only tiers run.
    ${g('--from-block <n>')}      scan floor for the register-loop probe (passed through to the service)
    ${dim('One ✓/✗/· line per assertion, then a verdict line. Never touches state beyond the write-loop\'s own throwaway register/deregister.')}
    ${dim('No --json on this command (unlike state/tokens/verify) — this is deliberately human-output-only; --json is silently ignored, with a warning.')}`,
  feedback: `
  ${bold('abx feedback')} ${dim('— discover, preview, submit, or review structured feedback. Core ABX by default.')}
    ${dim('no report flags')}       fetch the live core schema and guidance   ${g('--json')} machine output
    ${g('--area <protocol|contracts|cli|sdk|skills|docs|other>')}   required for core reports
    ${g('--kind <bug|friction|gap|confusion|praise|other>')} ${g('--summary "…"')}   required for every report
    ${g('--severity <blocker|major|minor>')}  ${g('--via <agent|human>')}   optional closed fields; also --detail and --context
    ${g('--remote <name|url>')}     route feedback to that remote-service provider instead; use --component, not --area
    ${g('--mine')}                  list reports visible to your key at this target [--kind] [--area|--component] [--limit]
    ${g('--yes')}                   send the exact preview. Without it, no report content is transmitted.
    ${dim('Files: --detail-file <path> · --context-file <json>. Never include keys, env contents, keyed RPC URLs, or private source.')}
    ${dim('An agent must obtain human approval before transmission. Core uses https://services.abx.io/abx/feedback + ABX_SERVICES_API_KEY;')}
    ${dim('provider feedback requires its descriptor to declare abx-service-feedback/v1.')}`,
  migrate: `
  ${bold('abx migrate')} <address> ${dim('— move a contract\'s OFF-CHAIN state to another resolver (read-only on both; no cutover).')}
    --from <name|url>     the SOURCE resolver (currently serving the contract) — read via its PUBLIC api; no source credential needed
    --to <name|url>       the DESTINATION resolver (its control plane) — the ONE credential migrate needs: a named remote's
                          ${g('ABX_REMOTE_<NAME>_TOKEN')}, else ${g('ABX_REMOTE_SELF_TOKEN')} (your own node's, from ${g('deploy-resolver')}), else --remote-token
    --from-block <n>      chain scan floor for the local read (default: the deploy block, discovered on-chain — never genesis)   --yes   allow a very large scan
    --backend <id>        durable custody for re-pinning source-only images (ipfs · arweave); else config/env
    ${dim('replays on-chain state on the dest from chain, then bridges description / external_url / off-chain')}
    ${dim('traits / image locators read from the source\'s PUBLIC api. Source-only images are re-pinned to your')}
    ${dim('durable backend (fetch → verify vs on-chain hash → bridge), never left pointing at the old host.')}
    ${dim('Verifies parity, then prints the cutover (re-point DNS, or the on-chain base URI). No tx is sent.')}`,
  serve: `
  ${bold('abx serve')} [--port <n>] ${dim('— serve the token API + dashboard. BLOCKS (background it).')}
    Also runs the ${bold('chain watcher')} (default ON): one incremental getLogs poll (~12s) covers EVERY registered project, so
    external mints / param changes (any tool, any wallet) auto-index — and fan out ONE coarse notification per changed
    project to the effects layer (${g('ABX_EFFECTS_URL')} + ${g('ABX_EFFECTS_TOKEN')}) → thumbnails auto-re-render.
    ${g('ABX_WATCH_INTERVAL_MS')} tunes the cadence; ${g('0')} disables (state then updates only on explicit add/index).
    ${dim('Reorg note: no lookback (post-PoS reorgs are rare); the repair is the deterministic full replay — `abx index <addr> --full`.')}`,
};



function printCommandHelp(cmd?: string, sub?: string): void {
  // Try the TWO-WORD topic first, then fall back to the bare command — mirroring
  // `allowlistFor`'s lookup in flag-allowlists.ts so the two agree on what a topic is named.
  // Without the fallback, `abx help scaffold solidity` reported `No help topic "scaffold"` even
  // though the CLI's own `scaffold-renderer` entry tells you the nested form is the one new
  // automation should use — the tool contradicting its own recommendation, which is exactly the
  // kind of thing that makes an agent conclude a command does not exist.
  const topic = (cmd && sub ? COMMAND_HELP[`${cmd} ${sub}`] : undefined) ?? (cmd ? COMMAND_HELP[cmd] : undefined);
  if (topic) {
    console.log(topic + '\n');
    return;
  }
  // A named-but-unknown help topic used to silently dump the full help — reading as "this exists,
  // here's everything" and costing extra round-trips while an agent probed guesses (`abx help attach`
  // before it existed, `abx help add-file`, …). Say so, then show the index.
  if (cmd) console.error(`No help topic "${cmd}". It may not be a command — here's the full list:\n`);
  help();
}

function help() {
  console.log(`
  ${bold('abx')} — the ABX CLI · agentic surface of the Self-Host Toolkit

    active chain: ${g(CHAIN)}   select another supported testnet with ${g('ABX_CHAIN=<chain>')} (there is no --chain flag)

    ${g('abx demo')}                deploy a 1/1 to ${CHAIN}, index it, and serve it
    ${g('abx deploy')} [--image ..] deploy + index a ${bold('single 1/1')} token (no server)
                            flags: --image <path> --name --symbol --royalty-bps --port
                            --description "…" --external-url <url>  (the creator's words, served in metadata)
                            ${g('--onchain-uri')}  resolve tokenURI/contractURI fully on-chain (self-resolving, no server)
                            --public-base-url <url>  bake a public resolver URL on-chain (off-chain custody needs a public URL; localhost refused)
                            ${g('--no-mint')} deploy without minting (warm the resolver, then ${g('abx mint')})
                            ${g('--salt')} 0x..  use a fixed/reserved address (see ${g('abx predict')})
                            storage override (else uses config): --backend --endpoint --bucket --region --gateway --upload-url
                            served-gateway preference (ipfs/arweave images): --ipfs-gateway <prefix> --arweave-gateway <prefix>  (floors: ipfs.io · arweave.net)
                            signing: ${g('--send')} hot/env key (default) · ${g('--sign')} wallet page · ${g('--unsigned')} print tx
                            ${g('--dry-run')}  preview (commitment · URIs · mint plan · approvals) without sending or storing — address only WITH --salt
                            ${bold(g('--copies <n|open>'))}  copies of this SAME work (ERC-1155 edition) instead of a unique token —
                              ${g('open')} = uncapped OPEN EDITION, the flagship edition product. See ${g('abx help deploy')}.
    ${g('abx deploy-series')} --dir <folder>  deploy a ${bold('multi-token collection')} from a folder of media (one contract, N tokens)
                            mint timing: ${g('--mint-all')} | ${g('--mint-count')} N | ${g('--no-mint')}   ·   --count N --name --symbol --royalty-bps
                            image custody: ${g('--onchain-image')} (bytes on-chain, tiny content) ·
                              ${g('--onchain-uri --backend arweave|ipfs|cloud')} (image off-chain, JSON on-chain, ${bold('no server')} — best for most projects) ·
                              --public-base-url <url> (hosted resolver)
                            --minter 0x.. · --primary-payee 0x.. · --unpaused · ${g('--dry-run')}   ·   see ${g('abx help deploy-series')}
                            ${bold(g('--copies <n|open>'))}  N ids from the folder × copies each (EditionImage) instead of N unique tokens
    ${g('abx predict')}             pre-compute a deploy address   flags: [--salt 0x..] [--for 0x..] [--factory 0x..]
    ${g('abx add')} <address>       register + index a project this node didn't deploy
                            flags: --from-block --factory --label   ·   ${g('--remote <name|url>')} registers on a REMOTE resolver instead
    ${g('abx remote')} [<name|url>]  inspect a remote service: its descriptor (chains · managed rendering · where to get a key) + your projects there
                            ${g('--conformance')} self-certifies it against remote-services.md instead (exits non-zero on a failed assertion — see ${g('abx help remote')})
    ${g('abx auth login')}           authorize ABX Services in a browser; saves the key to ignored .env without printing it
    ${g('abx auth logout')}          revoke the current ABX Services key, then remove it from .env
    ${g('abx feedback')}            preview/file core ABX feedback; ${g('--remote <provider>')} switches target (no report sends without --yes)
    ${g('abx index')} [<address>]   re-index from chain (incremental by default; ${g('--full')} forces a replay from deploy)
    ${g('abx verify')} <addr>       re-hash served bytes vs the on-chain commitment (no resolver needed; ${g('abx add')} it locally first)
    ${g('abx tokenuri')} <addr>     read tokenURI(0) on-chain + decode the JSON (proof a self-resolving token works)
    ${g('abx contracturi')} <addr>  read contractURI() (ERC-7572 collection metadata) on-chain, follow it, decode — never hand-build the URL
    ${g('abx tokens')} <addr>       EVERY token's owner + seed + params, from chain  flags: [--json] [--from <id>] [--limit <n>]
    ${g('abx artifacts')} <addr>    one token's \`artifacts\` manifest directly (entries + current/stale effect rows)
                            ${g('--token <id>')} (default 0)  ·  ${g('--remote <name|url>')} reads what a HOSTED resolver actually reports
    ${g('abx state')} <addr>        one-glance on-chain snapshot: owner · supply · paused · minter · payee · royalty · renderer
    ${g('abx serve')} [--port ..]   serve the token API + dashboard — and WATCH the chain: auto-index every registered
                            project + notify the effects layer on change (${g('ABX_WATCH_INTERVAL_MS')}; 0 = off)

  ${bold('code / generative projects')} ${dim('— a program is the content; output is a function of live on-chain state')}
    ${g('abx capabilities')}          stable native lanes, extension seams, irreversible choices, and unsupported cases   [${g('--json')}]
    ${g('abx preview')} (--script <f> | --code-dir <d>)   ${bold('while you are still making it')} — run the program on localhost, live: refresh for new seeds,
                            drive your PostParams, watch it animate. Same document the generator serves. ${g('--shoot <dir>')} for headless frames. No chain.
    ${g('abx inspect')} <script.js>   ${bold('before you pick a lane')} — static analysis (traits + on-chain reproducibility, deps, doc size → RPC viability) + a lane recommendation
    ${g('abx scaffold solidity')} [<dir>]   one buildable Foundry workspace for ${bold('renderers + configure/transfer/augment hooks')} (canonical minters/interfaces via abx-contracts)
    ${g('abx deploy-code')} (--script <file> | --code-dir <dir> | ${g('--image-renderer 0x..')})   deploy a ${bold('generative / code project')} (on-chain script, a build directory, or a Solidity SVG renderer — in-chain rendering)
                            ${bold('--public-base-url <url>')} OR ${bold('--onchain-uri')} · --schema key:Type:Auth · ${g('--dep')} name@version|0x.. (ordered; index 0 = the runtime) ·
                            --dep-registry 0x.. · --description "<s>" · --external-url <url> · ${g('--image-base <url>')} (off-chain thumbnails at a deterministic /{id} URL) ·
                            ${g('--attributes-renderer 0x..')} (traits on-chain) · --max N · ${g('--mint-all')}|${g('--mint-count')} N · --backend ipfs|arweave · ${g('--dry-run')}
                            ${bold(g('--copies <n|open>'))}  ${ABX_CAPABILITIES.deploymentCommands.deployCode.edition.summary}
    ${g('abx configure-param')} <addr> <id> <key> <value>   set a governed PostParam (typed encode; a change re-addresses the render)
    ${g('abx submit-app')} <collection>   list that collection in the ABX App Store (optional, after deploy — mint + catalog copy)
    ${g('abx set-schema')} <addr> --schema key:Type:Auth[:lock=<when>]   attach or replace ONE key's schema, any time after deploy
    ${g('abx retire-param')} <addr> <key>   stop all further writes to a param, permanently (the closest thing to removing one)
    ${g('abx set-dependency')} <addr> <index> <ref>   declare/replace a code dependency (name@version via the registry pointer, or 0x.. on-chain)
    ${g('abx remove-last-dependency')} <addr> · ${g('abx set-dependency-registry')} <addr> <0x..|none> · ${g('abx lock-dependencies')} <addr>   operate/freeze the set
    ${g('abx render')} <addr> [id…]   render the still + traits ONCE (the repair lane)   [${g('--force')} re-render] [${g('--remote')} [url] publish to a hosted resolver]
    ${g('abx effects')}              run the render runner LOCALLY (auto-renders every new mint + param change; blocks)   [${g('--once')}] [--port N] [--interval-ms N]
    ${g('abx deploy-resolver')} --provider fly|render|vps   scaffold the hosted resolver (required — serves tokenURI + the live view)
    ${g('abx deploy-effects')} --resolver-url <url>   scaffold the render runner as a HOSTED service (Playwright)

  ${bold('owner operations')} ${dim('— operate a project after launch')}
    ${g('abx mint')} <addr>         issue token #0   flags: [--to 0x.. (default: owner)]
                            ${dim('edition:')} ${g('--token-id <n>')} (required unless a 1/1-edition) + ${g('--amount <n>')} (copies, default 1) — ${g('--count')} refused
    ${g('abx submit-app')} <collection>  list a deployed collection in the ABX App Store (opt-in; not part of deploy)
                            --name --summary --description   [--mark] [--tone] [--category] [--stage] [--url] [--tags]
    ${g('abx refresh')} <addr>      ask marketplaces to re-index   flags: [--token 0]
    ${g('abx transfer')} <addr>     sell/transfer a token   flags: --to 0x.. [--token 0 | --token-id 0]
                            ${dim('edition:')} ${g('--amount <n>')} copies + ${g('--from 0x..')} (required — many holders, no single on-chain owner)
    ${g('abx set-max-supply')} <addr>  --token-id <n> --cap <n>   edition-only: lower ONE id's ERC-1155 cap (never "open" — caps only decrease)
    ${g('abx ping-uri')} <addr>     --token-ids <csv|range>   edition-only, owner-only: re-emit the native URI event after a re-point
    ${g('abx set-token-uri')} <addr>    re-point a token's metadata URI   --uri <url>
    ${g('abx set-contract-uri')} <addr> re-point the collection URI        --uri <url>
    ${g('abx migrate')} <addr>       move off-chain state to a NEW resolver (verifies parity; no cutover)   --from <old> --to <new>
    ${g('abx set-royalty')} <addr>  change royalty   --bps <0-10000> [--receiver 0x..]
    ${g('abx set-royalty-cap')} <addr>  LOWER the royalty ceiling (reduce-only)   --cap <0-10000>
    ${g('abx set-transfer-validator')} <addr> <0x..|none|recommended>   manage an ERC-721C collection's validator (enrolled-at-deploy only)
    ${g('abx set-seed-source')} <addr> <0x..|canonical|none>   re-point a CODE project's mint-seed source (probed; future mints only)
    ${g('abx attach')} <addr> <key> <ipfs://…|ar://…|https://…>   attach a named file → the token's ${bold('artifacts')} manifest (data plane)
    ${g('abx set-field')} <addr>    set an on-chain metadata field (low-level)   --field <name> (--text "…" | --value 0x..) [--collection]
    ${g('abx lock-field')} <addr>   freeze a field forever   --field <name> [--collection]
    ${g('abx set-gateway')} <addr>  repoint where ipfs/arweave content is SERVED from (the CID never moves)   [--ipfs <prefix>] [--arweave <prefix>]
    ${g('abx set-renderer')} <addr> toggle URI resolution on-chain ↔ off-chain   [--off] [--renderer 0x..] [--collection]
    ${g('abx lock-uri')} <addr>     freeze the URI config (pointer + renderer) forever   [--collection]
    ${g('abx replace-script')} <addr>  --script <file>   safely replace an UNLOCKED code project's on-chain program (diffs, atomic multicall, verifies reassembly)
    ${g('abx lock-script')} <addr>  freeze the on-chain program (script chunks) forever — the lock that freezes a code project's ${bold('work')}
    ${g('abx set-param-hooks')} <addr>  wire/clear a code project's configure/transfer/augment hooks (owner-only)  [--configure|--transfer|--augment 0x|none]
    ${g('abx lock-param-hooks')} <addr>  freeze the three hook addresses forever — the ${bold('transfer hook is a veto')}, so this is the guarantee a buyer reads
    ${g('abx set-admin')} <addr>    hand over contract ownership   --to 0x..
    ${dim('Series-only:')} ${g('abx mint')} <addr> mints the ${dim('next')} token in order (or ${g('--count')} N)
    ${g('abx pause')} / ${g('abx unpause')} <addr>   Series mint gate (paused ⇒ owner-only minting)
    ${g('abx set-minter')} <addr>   --minter 0x..|none   authorize a single minting contract (Series)
    ${g('abx set-primary-payee')} <addr>  --payee 0x..|none   declare primary-sale payout (Series)
    ${g('abx set-max-invocations')} <addr>  --max N   lower the supply cap, monotonic (Series)
    ${g('abx minter')} <configure|show|buy> <token>   sell a Series via the shared fixed-price minter
                            ${dim('edition:')} ${g('--token-id <n>')} required on every subcommand · ${g('buy --quantity <n>')} (pays price × quantity)
    ${g('abx mint-page')} <token>   scaffold a self-contained Next.js mint site (fixed-price minter) — deploy to Vercel
                            ${dim('editions get the token-id + quantity purchase shape (no gallery in this v1 page — see the README)')}
    ${dim('signing lane (all of the above):')} ${g('--send')} hot/env key (default) · ${g('--sign')} wallet page · ${g('--unsigned')} print tx
    ${dim('--sign blocks until you approve in the browser; --sign-url-file <path> writes the sign URL there (for backgrounded/agent runs)')}

    ${g('abx storage')} show        show the resolved byte custody (fs | cloud | ipfs | arweave)   [--check]
                            ${dim('storage is stateless — no config file. Pick a backend PER COMMAND with flags')}
                            ${dim('(--backend ipfs --gateway … · --backend cloud --bucket … --public-base … · --backend arweave), or set defaults in .env.')}
                            ${dim('--check: a REAL read/write against the resolved config (cloud: PUT+GET round trip via the public base · ipfs/fs: reachability/writability · arweave: identity+balance) — no paid upload, no ipfs pin. Exit code: 0 ok, 1 any ✗.')}
    ${g('abx storage')} upload <path>   upload ONE file → prints its locator (the URI ${g('abx attach')} wants)   [--backend ipfs|arweave|cloud] [--dry-run]
    ${g('abx storage')} status <locator>  is that locator RETRIEVABLE yet (not just accepted)? — ready | propagating | unreachable   [--json]
    ${g('abx storage')} balance     show Turbo (arweave) upload credits + the funded address
    ${g('abx storage')} topup       buy Turbo credits by card   --usd <n>   (one-time; <100 KB is always free)
    ${g('abx storage')} backup-key  copy the managed Turbo/Arweave key (holds credits) to a safe path   --out <path>
    ${g('abx forget')} <address>    drop a project's local registration + projection (on-chain untouched)
    ${g('abx status')} [address]     indexing status: lifecycle + freshness (bare = this node; ${g('--remote')} [name] = a service; ${g('--watch')} to tail)
    ${g('abx doctor')}              check environment (key, RPC, balance, factory incl. edition twins, storage)
    ${g('abx skill install')}       install the version-locked abx skill into your agent(s)   [--agent <name>] [--global] [--target <dir>]  ·  ${g('abx skill path')} prints the bundled skill
    ${g('abx version')}             print the installed CLI version

  ${dim('Run')} ${g('abx <command> --help')} ${dim('for per-command usage. --help / -h never executes — it only prints usage.')}
  ${dim('abx checks npm for a newer release (every 6h, notify-only). Silence with')} ${g('ABX_NO_UPDATE_CHECK=1')} ${dim('or')} ${g('--no-update-check')}${dim('.')}
`);
}



main().catch((err) => {
  // A validation helper with a non-void return type (ownerops.ts's requireAddress/requireFlag)
  // can't just set exitCode and return — it has to throw to satisfy the type checker — but it
  // already printed its own usage text; skip the generic formatting so that text isn't double-decorated.
  if (err instanceof CliError && err.alreadyPrinted) {
    process.exitCode = err.exitCode;
    return;
  }
  // Keep the actionable message; strip viem's verbose boilerplate trailer (Docs:/Version: lines) so
  // a creator sees a clean `✗ <reason>` instead of a library stack dump on e.g. a bad address/RPC.
  let msg = (err as Error)?.message ?? String(err);
  msg = msg
    .replace(/\n+Docs:\s*https:\/\/viem\.sh\S*/g, '')
    .replace(/\n+Version:\s*viem@[\w.\-]+/g, '')
    .trimEnd();
  // Provider and transport errors may echo a full configured RPC URL, including path/query API
  // keys. Enforce redaction once at the CLI boundary so individual commands cannot forget it.
  msg = redactRpcUrlsInText(msg, resolveRpcUrls(CHAIN));
  console.error(`\n${c.red}✗${c.reset} ${msg}\n`);
  process.exit(err instanceof CliError ? err.exitCode : 1);
});
