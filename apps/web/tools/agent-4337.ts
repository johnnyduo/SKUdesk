// Proves the agent factory end to end on a real chain and records the result in src/data/agent4337.json.
//   node --env-file=../../.env tools/agent-4337.ts [--rpc URL] [--chain 46630] [--out src/data/agent4337.json]
// 1. createAgent: one transaction makes a vault, a locked ERC-4337 account and an identity NFT for the owner.
// 2. The agent key signs UserOperations; this script acts as the bundler and calls the canonical EntryPoint v0.7.
// 3. An honest commit goes through; a lying commit is accepted by the account but refused by the vault (on chain);
//    seven attacks are refused by the ACCOUNT during validation (token transfer, owner functions, ETH, a bundler tip, huge gas, a stranger's signature) (shown with eth_call, so no gas is spent on them).
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, encodeAbiParameters, parseAbiParameters, encodeFunctionData, decodeEventLog, defineChain, getAddress, toHex, formatEther, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { userOpClient, prefundFor } from './userop.ts';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const CHAIN_ID = Number(arg('chain', process.env.CHAIN_ID ?? '46630'));
const RPC = arg('rpc', process.env.ROBINHOOD_RPC)!;
const OUT = arg('out', 'src/data/agent4337.json')!;
const readJson = (p: string) => JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
const dep = readJson(`../../packages/contracts/deployments/${CHAIN_ID}.json`);
const ag = readJson(`../../packages/contracts/deployments/agents-${CHAIN_ID}.json`);
const chain = defineChain({ id: CHAIN_ID, name: 'robinize-' + CHAIN_ID, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 30_000 }) });
const owner = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex);          // the human owner (and the bundler, for this proof)
const wallet = createWalletClient({ account: owner, chain, transport: http(RPC, { timeout: 30_000 }) });
const agentKey = generatePrivateKey(); const agentAcct = privateKeyToAccount(agentKey);   // fresh key per run
const EP = getAddress(ag.entryPoint); const FACTORY = getAddress(ag.factory); const REGISTRY = getAddress(ag.registry); const TOKEN = getAddress(ag.token);
const SUPPLIER = getAddress(dep.supplier); const PAYER = getAddress(dep.payer);
const THIEF = getAddress('0x000000000000000000000000000000000000dEaD');

const QUOTE = '(uint256 purchaseCents,uint256 shipCents,uint256 dutyCents,uint256 taxCents,uint256 procFeeCents,uint256 payFeeCents,uint256 sellCents,uint256 mktFeeBps,uint256 fulfillCents,uint256 retBps,uint256 chainCents)';
const OP = 'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }';
const ABI = parseAbi([
  OP,
  'function createAgent((address agentKey,uint256 dailyCap,uint256 maxPerTrade,uint256 minMarginBps,uint256 quoteTTL,string agentURI,address[] payees,address[] payers) p) returns (uint256 index,address vault,address account,uint256 agentId)',
  'event AgentCreated(uint256 indexed index,address indexed owner,address vault,address account,uint256 indexed agentId,address signer)',
  'function handleOps(PackedUserOperation[] ops,address beneficiary)', 'function getUserOpHash(PackedUserOperation op) view returns (bytes32)', 'function getNonce(address sender,uint192 key) view returns (uint256)',
  'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)',
  'event UserOperationRevertReason(bytes32 indexed userOpHash,address indexed sender,uint256 nonce,bytes revertReason)',
  'function execute(address target,uint256 value,bytes data)', 'function addDeposit() payable', 'function deposit() view returns (uint256)',
  `function commitOpportunity(bytes32 productHash,bytes32 quoteHash,bytes32 snapshotHash,uint256 observedAt,uint256 units,${QUOTE} q,int256 agentNet,uint256 agentMarginBps) returns (bytes32,uint256,int256)`,
  'function opps(bytes32) view returns (bytes32 productHash,uint256 units,uint256 landedCents,uint256 spendCents,int256 netCents,bool exists,bool consumed)',
  'function mint(address to,uint256 amount)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)',
  'function deposit(uint256 amount)', 'function withdraw(uint256 amount)', 'function pause(bool p)',
  'function ownerOf(uint256) view returns (address)', 'function tokenURI(uint256) view returns (string)', 'function getMetadata(uint256,string) view returns (bytes)',
  'function owner() view returns (address)', 'function agent() view returns (address)', 'function signer() view returns (address)', 'function vault() view returns (address)',
  'function dailySpendCap() view returns (uint256)', 'function maxExec() view returns (uint256)', 'function minMarginBps() view returns (uint256)', 'function quoteTTL() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)', 'function free() view returns (uint256)', 'function spentToday() view returns (uint256)',
  'error FailedOp(uint256 opIndex,string reason)', 'error FailedOpWithRevert(uint256 opIndex,string reason,bytes inner)',
  'error TargetNotAllowed(address target)', 'error ValueNotAllowed(uint256 value)', 'error SelectorNotAllowed(bytes4 selector)', 'error BadCall()', 'error NotEntryPoint()',
  'error MathMismatch(int256 claimedNet,int256 derivedNet,uint256 claimedBps,uint256 derivedBps)', 'error SpendCap(uint256 spendCents,uint256 capCents)', 'error Unauthorized()',
]);

const usd = (c: number | bigint) => '$' + (Number(c) / 100).toFixed(2);
const log = (...a: unknown[]) => console.log(...a);
const sendTx = async (to: Hex, data: Hex, value = 0n) => {
  const hash = await wallet.sendTransaction({ to, data, value, gas: 6_000_000n });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (r.status !== 'success') throw new Error('tx reverted ' + hash);
  return { hash, receipt: r };
};

const uop = userOpClient(pub, EP, owner.address, (data) => wallet.sendTransaction({ to: EP, data, gas: 4_000_000n }));
const { exec, dryRun, bundle } = uop;
const buildOp = (account: Hex, inner: Hex, signWith: Hex = agentKey, over: { tip?: bigint; verificationGas?: bigint } = {}) => uop.buildOp(account, inner, signWith, over);
type Op = Awaited<ReturnType<typeof buildOp>>;

async function main() {
  log(`chain ${CHAIN_ID}  factory ${FACTORY}  registry ${REGISTRY}  entryPoint ${EP}`);
  if ((await pub.getCode({ address: EP })) === undefined) throw new Error('EntryPoint not deployed here');
  const result: any = { chainId: CHAIN_ID, entryPoint: EP, factory: FACTORY, registry: REGISTRY, token: TOKEN, ranAt: new Date().toISOString(), owner: owner.address, agentKey: agentAcct.address, steps: [] as any[], ops: [] as any[], attacks: [] as any[] };

  // 1. one transaction: vault + locked account + identity NFT
  const params = { agentKey: agentAcct.address, dailyCap: 500_000n, maxPerTrade: 250_000n, minMarginBps: 1800n, quoteTTL: 180n,
    agentURI: 'data:application/json;utf8,' + JSON.stringify({ type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'SKUdesk proof agent', description: 'Created by tools/agent-4337.ts', active: true }),
    payees: [SUPPLIER], payers: [PAYER] };
  const created = await sendTx(FACTORY, encodeFunctionData({ abi: ABI, functionName: 'createAgent', args: [params] }));
  let info: any = null;
  for (const l of created.receipt.logs) { try { const ev = decodeEventLog({ abi: ABI, data: l.data, topics: l.topics }); if (ev.eventName === 'AgentCreated') info = ev.args; } catch { /* other contract */ } }
  if (!info) throw new Error('AgentCreated event missing');
  const VAULT = getAddress(info.vault); const ACCOUNT = getAddress(info.account); const AGENT_ID = info.agentId as bigint;
  Object.assign(result, { vault: VAULT, account: ACCOUNT, agentId: String(AGENT_ID), createTx: created.hash, createGas: String(created.receipt.gasUsed), deployBlock: String(created.receipt.blockNumber) });
  log(`created agent #${AGENT_ID}: vault ${VAULT} account ${ACCOUNT} (gas ${created.receipt.gasUsed})`);
  const rd = (address: Hex, functionName: any, args: any[] = []) => pub.readContract({ address, abi: ABI, functionName, args } as any) as Promise<any>;
  const checks = {
    vaultOwner: await rd(VAULT, 'owner') === owner.address, vaultAgentIsAccount: await rd(VAULT, 'agent') === ACCOUNT,
    accountSigner: await rd(ACCOUNT, 'signer') === agentAcct.address, accountVault: await rd(ACCOUNT, 'vault') === VAULT,
    nftOwner: await rd(REGISTRY, 'ownerOf', [AGENT_ID]) === owner.address, vaultInIdentity: ('0x' + (await rd(REGISTRY, 'getMetadata', [AGENT_ID, 'vault'])).slice(-40)).toLowerCase() === VAULT.toLowerCase(),
  };
  if (!Object.values(checks).every(Boolean)) throw new Error('factory wiring wrong: ' + JSON.stringify(checks));
  result.wiring = checks;

  // 2. fund: tokens into the vault, ETH gas deposit for the account at the EntryPoint (no paymaster)
  await sendTx(TOKEN, encodeFunctionData({ abi: ABI, functionName: 'mint', args: [owner.address, 1_000_000_000n] }));
  await sendTx(TOKEN, encodeFunctionData({ abi: ABI, functionName: 'approve', args: [VAULT, 1_000_000_000n] }));
  await sendTx(VAULT, encodeFunctionData({ abi: ABI, functionName: 'deposit', args: [1_000_000_000n] }));
  const prefund = prefundFor(await pub.getGasPrice());     // what one op reserves at the EntryPoint (the unused part is refunded)
  await sendTx(ACCOUNT, encodeFunctionData({ abi: ABI, functionName: 'addDeposit' }), prefund * 5n);
  log(`funded: vault free ${Number(await rd(VAULT, 'free')) / 1e6} mUSDG, gas deposit ${formatEther(await rd(ACCOUNT, 'deposit'))} ETH`);

  // 3. honest and lying commits through the account
  const q = { purchaseCents: 590n, shipCents: 42n, dutyCents: 12n, taxCents: 8n, procFeeCents: 5n, payFeeCents: 2n, sellCents: 1099n, mktFeeBps: 800n, fulfillCents: 65n, retBps: 200n, chainCents: 4n };
  const qh = keccak256(encodeAbiParameters(parseAbiParameters(QUOTE.slice(1, -1)), [q.purchaseCents, q.shipCents, q.dutyCents, q.taxCents, q.procFeeCents, q.payFeeCents, q.sellCents, q.mktFeeBps, q.fulfillCents, q.retBps, q.chainCents]));
  const PROD = keccak256(toHex('CASE-IP16PRO-CLEAR-MAG-001')); const SNAP = keccak256(toHex('snapshot-' + Date.now()));
  const commit = (units: bigint, net: bigint, bps: bigint) => encodeFunctionData({ abi: ABI, functionName: 'commitOpportunity', args: [PROD, qh, SNAP, BigInt(Math.floor(Date.now() / 1000) - 5), units, q, net, bps] });
  const oppHash = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32,bytes32'), [PROD, qh, SNAP]));

  const liar = await buildOp(ACCOUNT, exec(VAULT, 0n, commit(240n, 390n, 2374n)));
  const liarRun = await bundle(liar);
  const afterLiar = await rd(VAULT, 'opps', [oppHash]);
  if (liarRun.success || afterLiar[5]) throw new Error('lying op was not refused by the vault');
  result.ops.push({ label: 'Agent claims net 390c (true value 261c)', via: 'account -> vault', tx: liarRun.hash, accepted: true, executed: false, refusedBy: 'vault', error: liarRun.reason?.name, args: liarRun.reason?.args, gas: String(liarRun.gas) });
  log('lying commit: UserOp accepted by the account, refused by the vault:', liarRun.reason);

  const oversize = await buildOp(ACCOUNT, exec(VAULT, 0n, commit(400n, 261n, 2374n)));
  const oversizeRun = await bundle(oversize);
  if (oversizeRun.success) throw new Error('oversize op was not refused');
  result.ops.push({ label: 'Agent tries a 400-unit trade (cap is $2,500)', via: 'account -> vault', tx: oversizeRun.hash, accepted: true, executed: false, refusedBy: 'vault', error: oversizeRun.reason?.name, args: oversizeRun.reason?.args, gas: String(oversizeRun.gas) });
  log('oversize commit refused by the vault:', oversizeRun.reason);

  const honest = await buildOp(ACCOUNT, exec(VAULT, 0n, commit(240n, 261n, 2374n)));
  const honestRun = await bundle(honest);
  const opp = await rd(VAULT, 'opps', [oppHash]);
  if (!honestRun.success || !opp[5]) throw new Error('honest op failed: ' + JSON.stringify(honestRun.reason));
  result.ops.push({ label: 'Honest commit: 240 units, net $2.61/unit', via: 'account -> vault', tx: honestRun.hash, accepted: true, executed: true, spendCents: String(opp[3]), gas: String(honestRun.gas) });
  log(`honest commit executed: spend ${usd(opp[3])} derived by the vault`);

  // 4. attacks the ACCOUNT refuses during validation (eth_call of handleOps: what a bundler would see)
  const attacks: { label: string; op: Op }[] = [
    { label: 'Call the token contract directly to send tokens to a stranger', op: await buildOp(ACCOUNT, exec(TOKEN, 0n, encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [THIEF, 100_000_000n] }))) },
    { label: 'Withdraw the vault balance (owner-only function)', op: await buildOp(ACCOUNT, exec(VAULT, 0n, encodeFunctionData({ abi: ABI, functionName: 'withdraw', args: [1_000_000n] }))) },
    { label: 'Pause the vault (owner-only function)', op: await buildOp(ACCOUNT, exec(VAULT, 0n, encodeFunctionData({ abi: ABI, functionName: 'pause', args: [true] }))) },
    { label: 'Send 1 wei of ETH to the vault with the call', op: await buildOp(ACCOUNT, exec(VAULT, 1n, commit(240n, 261n, 2374n))) },
    { label: 'Pay itself a 1 gwei tip as its own bundler (draining the gas deposit)', op: await buildOp(ACCOUNT, exec(VAULT, 0n, commit(240n, 261n, 2374n)), agentKey, { tip: 1_000_000_000n }) },
    { label: 'Ask for 5,000,000 verification gas (draining the gas deposit)', op: await buildOp(ACCOUNT, exec(VAULT, 0n, commit(240n, 261n, 2374n)), agentKey, { verificationGas: 5_000_000n }) },
    { label: 'UserOp signed by a stranger instead of the agent key', op: await buildOp(ACCOUNT, exec(VAULT, 0n, commit(240n, 261n, 2374n)), generatePrivateKey()) },
  ];
  for (const a of attacks) {
    const r = await dryRun(a.op);
    if (r.accepted) throw new Error('ATTACK ACCEPTED: ' + a.label);
    result.attacks.push({ label: a.label, refusedBy: 'account (validation)', code: r.code, error: r.error, args: r.args });
    log(`refused: ${a.label} -> ${r.code ?? ''} ${r.error ?? ''} ${r.args ?? ''}`);
  }
  const unchanged = (await rd(VAULT, 'free')) === 1_000_000_000n && (await rd(VAULT, 'agent')) === ACCOUNT && (await rd(VAULT, 'owner')) === owner.address;
  if (!unchanged) throw new Error('vault state changed by an attack');
  result.vaultUntouchedByAttacks = true;
  fs.writeFileSync(path.resolve(OUT), JSON.stringify(result, null, 1) + '\n');
  log(`wrote ${OUT}: ${result.ops.length} bundled ops, ${result.attacks.length} attacks refused`);
}
main().catch((e) => { console.error('RUN FAILED:', e.shortMessage ?? e.message ?? e); process.exit(1); });
