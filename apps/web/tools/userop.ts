// Minimal ERC-4337 v0.7 client: build and sign a UserOperation with the agent key, ask the EntryPoint what a bundler would see
// (eth_call), and submit it with handleOps. Shared by the proof script and the browser e2e test.
import { parseAbi, decodeErrorResult, decodeEventLog, encodeFunctionData, getAddress, concat, pad, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const OP = 'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }';
export const UOP_ABI = parseAbi([
  OP,
  'function handleOps(PackedUserOperation[] ops,address beneficiary)', 'function getUserOpHash(PackedUserOperation op) view returns (bytes32)', 'function getNonce(address sender,uint192 key) view returns (uint256)',
  'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)',
  'event UserOperationRevertReason(bytes32 indexed userOpHash,address indexed sender,uint256 nonce,bytes revertReason)',
  'function execute(address target,uint256 value,bytes data)',
  'error FailedOp(uint256 opIndex,string reason)', 'error FailedOpWithRevert(uint256 opIndex,string reason,bytes inner)',
  'error TargetNotAllowed(address target)', 'error ValueNotAllowed(uint256 value)', 'error SelectorNotAllowed(bytes4 selector)', 'error BadCall()', 'error NotEntryPoint()', 'error GasTooHigh(uint256 verificationGas,uint256 callGas,uint256 preVerificationGas)', 'error TipNotAllowed(uint256 maxPriorityFeePerGas)',
  'error MathMismatch(int256 claimedNet,int256 derivedNet,uint256 claimedBps,uint256 derivedBps)', 'error SpendCap(uint256 spendCents,uint256 capCents)', 'error DailyCap(uint256 spentAfterCents,uint256 capCents)',
  'error MarginTooLow(uint256 marginBps,uint256 floorBps)', 'error Stale(uint256 age,uint256 ttl)', 'error Paused()', 'error Unauthorized()',
]);

export type Op = { sender: Hex; nonce: bigint; initCode: Hex; callData: Hex; accountGasLimits: Hex; preVerificationGas: bigint; gasFees: Hex; paymasterAndData: Hex; signature: Hex };
const pack2 = (a: bigint, b: bigint) => concat([pad(toHex(a), { size: 16 }), pad(toHex(b), { size: 16 })]);
export const VERIFICATION_GAS = 600_000n; export const CALL_GAS = 2_000_000n; export const PRE_VERIFICATION_GAS = 100_000n;
// The agent account refuses a priority tip (priority fee 0) and caps the gas fields, so the agent key cannot pay itself out of the gas deposit.
export const feeFor = (gasPrice: bigint) => gasPrice * 3n + 1_000_000n;                          // headroom above the current price
export const prefundFor = (gasPrice: bigint) => (VERIFICATION_GAS + CALL_GAS + PRE_VERIFICATION_GAS) * feeFor(gasPrice);   // what one op reserves at the EntryPoint

/** pub: viem public client. beneficiary receives the bundler fee. send: submits a handleOps transaction and returns its hash. */
export function userOpClient(pub: any, entryPoint: Hex, beneficiary: Hex, send: (data: Hex) => Promise<Hex>) {
  const EP = getAddress(entryPoint);
  async function buildOp(account: Hex, callData: Hex, signingKey: Hex, over: { tip?: bigint; verificationGas?: bigint } = {}): Promise<Op> {
    const fee = feeFor(await pub.getGasPrice());
    const op: Op = { sender: account, nonce: await pub.readContract({ address: EP, abi: UOP_ABI, functionName: 'getNonce', args: [account, 0n] }), initCode: '0x', callData,
      accountGasLimits: pack2(over.verificationGas ?? VERIFICATION_GAS, CALL_GAS), preVerificationGas: PRE_VERIFICATION_GAS, gasFees: pack2(over.tip ?? 0n, fee), paymasterAndData: '0x', signature: '0x' };
    const h = await pub.readContract({ address: EP, abi: UOP_ABI, functionName: 'getUserOpHash', args: [op] });
    op.signature = await privateKeyToAccount(signingKey).signMessage({ message: { raw: h } });
    return op;
  }
  const exec = (target: Hex, value: bigint, data: Hex) => encodeFunctionData({ abi: UOP_ABI, functionName: 'execute', args: [target, value, data] });

  /** Ask the EntryPoint (eth_call) what a bundler would see for this op. */
  async function dryRun(op: Op): Promise<{ accepted: boolean; code?: string; error?: string; args?: string }> {
    try { await pub.simulateContract({ address: EP, abi: UOP_ABI, functionName: 'handleOps', args: [[op], beneficiary], account: beneficiary }); return { accepted: true }; }
    catch (e: any) {
      const data = (e?.walk?.((x: any) => typeof x?.raw === 'string')?.raw ?? e?.raw) as Hex | undefined;
      if (!data || data === '0x') return { accepted: false, error: String(e.shortMessage ?? e.message).slice(0, 200) };
      try {
        const d = decodeErrorResult({ abi: UOP_ABI, data });
        if (d.errorName === 'FailedOpWithRevert') {
          const [, reason, inner] = d.args as [bigint, string, Hex]; const code = reason.split(' ')[0];
          try { const i = decodeErrorResult({ abi: UOP_ABI, data: inner }); return { accepted: false, code, error: i.errorName, args: (i.args ?? []).map(String).join(', ') }; } catch { return { accepted: false, code, error: reason }; }
        }
        if (d.errorName === 'FailedOp') { const [, reason] = d.args as [bigint, string]; return { accepted: false, code: reason.split(' ')[0], error: reason }; }
        return { accepted: false, error: d.errorName };
      } catch { return { accepted: false, error: 'revert ' + data.slice(0, 10) }; }
    }
  }

  /** Include the op on chain. Returns whether the account's call succeeded and, if the vault refused it, the decoded reason. */
  async function bundle(op: Op) {
    const hash = await send(encodeFunctionData({ abi: UOP_ABI, functionName: 'handleOps', args: [[op], beneficiary] }));
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== 'success') throw new Error('handleOps transaction reverted ' + hash);
    let success = false; let reason: { name: string; args: string } | null = null; let gas = 0n;
    for (const l of receipt.logs) {
      if (getAddress(l.address) !== EP) continue;
      try {
        const ev = decodeEventLog({ abi: UOP_ABI, data: l.data, topics: l.topics });
        if (ev.eventName === 'UserOperationEvent') { success = (ev.args as any).success; gas = (ev.args as any).actualGasUsed; }
        if (ev.eventName === 'UserOperationRevertReason') {
          try { const d = decodeErrorResult({ abi: UOP_ABI, data: (ev.args as any).revertReason }); reason = { name: d.errorName, args: (d.args ?? []).map(String).join(', ') }; } catch { reason = { name: 'unknown', args: '' }; }
        }
      } catch { /* an EntryPoint event we do not need (BeforeExecution, Deposited, ...) */ }
    }
    return { hash, success, reason, gas };
  }
  return { buildOp, exec, dryRun, bundle };
}
