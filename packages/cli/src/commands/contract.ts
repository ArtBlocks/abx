import {readFileSync} from 'node:fs';
import {resolve as resolvePath} from 'node:path';
import {keccak256, type Address, type Hex} from 'viem';
import {
  CREATE2_PROXY,
  create2CalldataFromSalt,
  makePublicClient,
  predictCreate2AddressFromSalt,
  resolveChain,
  saltFor,
  waitForCodeAt,
  type PreparedTx,
} from '@artblocks/abx-sdk';
import {CHAIN, explorerBase} from '../config.js';
import {sponsoredWalletAddress} from '../creator-signer.js';
import {assertSaltGuardForDeployer, type Flags, isDryRun, parseSaltFlag} from '../flags.js';
import {bold, dim, info, ok} from '../output.js';
import {gatedSend, laneFromFlags} from '../riskgate.js';

const MAX_INITCODE_BYTES = 49_152;

function exactHex(value: unknown, label: string, allowEmpty = false): Hex {
  if (typeof value !== 'string') throw new Error(`${label} must be a hex string.`);
  const normalized = value.trim();
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(normalized)) {
    throw new Error(`${label} must be complete byte-aligned hex (unlinked library placeholders are not deployable).`);
  }
  if (!allowEmpty && normalized === '0x') throw new Error(`${label} is empty.`);
  return normalized.toLowerCase() as Hex;
}

function artifactBytecode(path: string): Hex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvePath(path), 'utf8'));
  } catch (cause) {
    throw new Error(`Could not read Foundry artifact ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const object = parsed as {bytecode?: string | {object?: string}};
  const bytecode = typeof object.bytecode === 'string' ? object.bytecode : object.bytecode?.object;
  return exactHex(bytecode, `bytecode in ${path}`);
}

function hexFile(path: string, label: string, allowEmpty = false): Hex {
  return exactHex(readFileSync(resolvePath(path), 'utf8'), label, allowEmpty);
}

/** Resolve exact creation initcode. ABX deliberately does not compile Solidity or infer constructor
 * types: Foundry produces the artifact and the caller supplies already-ABI-encoded constructor
 * arguments. That keeps the transaction reviewable and toolchain-neutral. */
export function contractInitcode(flags: Flags): Hex {
  const artifact = flags.artifact;
  const initcodeFile = flags.initcode;
  if (Boolean(artifact) === Boolean(initcodeFile)) {
    throw new Error('deploy-contract needs exactly one of --artifact <Foundry JSON> or --initcode <hex file>.');
  }
  const constructorArgs = flags['constructor-args'];
  const constructorArgsFile = flags['constructor-args-file'];
  if (constructorArgs !== undefined && constructorArgsFile !== undefined) {
    throw new Error('Pass constructor arguments once: --constructor-args <hex> or --constructor-args-file <path>.');
  }
  if (initcodeFile && (constructorArgs !== undefined || constructorArgsFile !== undefined)) {
    throw new Error('--initcode is already complete creation bytecode; constructor arguments are accepted only with --artifact.');
  }
  const base = artifact ? artifactBytecode(artifact) : hexFile(initcodeFile!, `initcode in ${initcodeFile}`);
  const args = constructorArgsFile
    ? hexFile(constructorArgsFile, `constructor arguments in ${constructorArgsFile}`, true)
    : exactHex(constructorArgs ?? '0x', 'constructor arguments', true);
  const combined = (`0x${base.slice(2)}${args.slice(2)}`) as Hex;
  const bytes = (combined.length - 2) / 2;
  if (bytes > MAX_INITCODE_BYTES) {
    throw new Error(`Contract initcode is ${bytes} bytes; EIP-3860 permits at most ${MAX_INITCODE_BYTES}.`);
  }
  return combined;
}

export interface SponsoredContractPlan {
  address: Address;
  salt: Hex;
  transaction: PreparedTx;
}

/** Build the target call used for a sponsored custom-contract deployment. Privy's sponsored relay
 * requires a call target, so this lane uses the already-canonical keyless CREATE2 proxy rather than
 * a raw `to: null` transaction. The initcode is unchanged, but constructors observe the proxy as
 * `msg.sender`; contracts that care about ownership must take it as an explicit constructor arg. */
export function sponsoredContractPlan(
  data: Hex,
  salt: Hex,
  chainId: number,
  label = 'custom contract',
): SponsoredContractPlan {
  const address = predictCreate2AddressFromSalt(salt, data);
  const bytes = (data.length - 2) / 2;
  return {
    address,
    salt,
    transaction: {
      op: 'deploy-contract',
      to: CREATE2_PROXY,
      data: create2CalldataFromSalt(salt, data),
      value: '0x0',
      chainId,
      summary: `Deploy ${label} from exact EVM initcode through deterministic CREATE2 proxy`,
      fields: {
        label,
        address,
        salt,
        initcode: `${bytes} bytes`,
        hash: keccak256(data),
        value: '0 ETH',
        constructorCaller: CREATE2_PROXY,
      },
    },
  };
}

export async function cmdDeployContract(flags: Flags): Promise<void> {
  const data = contractInitcode(flags);
  const bytes = (data.length - 2) / 2;
  const label = flags.label?.trim() || 'custom contract';
  const lane = laneFromFlags(flags);
  const expectedSigner = flags.for as Address | undefined;
  const sponsoredSigner = lane === 'sponsor'
    ? await sponsoredWalletAddress(CHAIN, {provision: !isDryRun(flags)})
    : undefined;
  if (sponsoredSigner && expectedSigner && sponsoredSigner.toLowerCase() !== expectedSigner.toLowerCase()) {
    throw new Error(`The ABX creator wallet ${sponsoredSigner} is not the required signer ${expectedSigner}.`);
  }
  const previewSigner = sponsoredSigner ?? expectedSigner;
  const chainId = resolveChain(CHAIN).id;
  const explicitSalt = parseSaltFlag(flags.salt);
  if (explicitSalt && lane !== 'sponsor') {
    throw new Error('--salt applies only to --sponsor, whose provider-backed lane deploys through CREATE2.');
  }
  if (explicitSalt && sponsoredSigner) assertSaltGuardForDeployer(explicitSalt, sponsoredSigner);
  const sponsored = lane === 'sponsor'
    ? sponsoredContractPlan(
        data,
        explicitSalt ?? saltFor(sponsoredSigner!),
        chainId,
        label,
      )
    : undefined;
  const prepared: PreparedTx = sponsored?.transaction ?? {
    op: 'deploy-contract',
    to: null,
    data,
    value: '0x0',
    chainId,
    summary: `Deploy ${label} from exact EVM initcode`,
    fields: {
      label,
      initcode: `${bytes} bytes`,
      hash: keccak256(data),
      value: '0 ETH',
    },
  };

  info(`${bold(sponsored ? 'sponsored CREATE2' : 'direct CREATE')} · ${bytes} initcode bytes · ${dim(keccak256(data))}`);
  info('ABX sends these exact bytes; it does not compile, link, or infer constructor arguments.');
  if (sponsored) {
    info(`predicted address ${sponsored.address}`);
    info(`salt ${sponsored.salt}`);
    info(`constructor msg.sender ${CREATE2_PROXY} (keyless CREATE2 proxy, not the creator wallet)`);
  }
  const result = await gatedSend(prepared, flags, {
    chainKey: CHAIN,
    expectedSigner: previewSigner,
  });
  if (!result) return;
  let address = result.contractAddress;
  if (sponsored) {
    address = sponsored.address;
    if (!(await waitForCodeAt(makePublicClient({chainKey: CHAIN}), address))) {
      throw new Error(`Transaction ${result.txHash} confirmed but no code appeared at predicted address ${address}.`);
    }
  } else if (!address) {
    throw new Error(`Transaction ${result.txHash} confirmed but its receipt has no contract address.`);
  }
  ok(`deployed ${label} → ${address}`);
  info(`tx ${explorerBase()}/tx/${result.txHash}`);
  if (flags.json !== undefined) {
    console.log(JSON.stringify({
      command: 'deploy-contract',
      chain: CHAIN,
      chainId,
      address,
      txHash: result.txHash,
      deployBlock: result.blockNumber.toString(),
      initcodeHash: keccak256(data),
      initcodeBytes: bytes,
      deploymentMode: sponsored ? 'create2-proxy' : 'create',
      ...(sponsored ? {salt: sponsored.salt, constructorCaller: CREATE2_PROXY} : {}),
    }, null, 2));
  }
}
