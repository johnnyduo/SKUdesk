// ABIs and addresses for the "Deploy your agent" page. Human-readable, with every custom error the factory path can raise
// (including the ones thrown inside the vault and account constructors) so a revert always decodes into a sentence.
import { parseAbi } from 'viem';
import agents from '../data/agents.json';
import proof from '../data/agent4337.json';

export const AGENTS = agents as { chainId: number; factory: `0x${string}`; registry: `0x${string}`; faucet: `0x${string}`; entryPoint: `0x${string}`; token: `0x${string}`; deployBlock: number };
export type ProofItem = { label: string; via?: string; tx?: string; accepted?: boolean; executed?: boolean; refusedBy: string; error?: string; args?: string; code?: string; gas?: string; spendCents?: string };
export const PROOF = proof as unknown as { chainId: number; entryPoint: string; factory: string; registry: string; owner: string; agentKey: string; vault: string; account: string; agentId: string; createTx: string; createGas: string; ranAt: string; ops: ProofItem[]; attacks: ProofItem[]; wiring: Record<string, boolean>; vaultUntouchedByAttacks: boolean };

export const FACTORY_ABI = parseAbi([
  'function createAgent((address agentKey,uint256 dailyCap,uint256 maxPerTrade,uint256 minMarginBps,uint256 quoteTTL,string agentURI,address[] payees,address[] payers) p) returns (uint256 index,address vault,address account,uint256 agentId)',
  'function agentCount() view returns (uint256)', 'function agentsOf(address owner) view returns (uint256[])',
  'function agents(uint256) view returns (address owner,address vault,address account,uint256 agentId,address signer,uint64 createdAt)',
  'event AgentCreated(uint256 indexed index,address indexed owner,address vault,address account,uint256 indexed agentId,address signer)',
  'error BadAgentKey()', 'error TooMany()', 'error BadMargin(uint256 bps)', 'error BadOwner()',
]);
export const REGISTRY_ABI = parseAbi([
  'function ownerOf(uint256 agentId) view returns (address)', 'function tokenURI(uint256 agentId) view returns (string)', 'function getMetadata(uint256 agentId,string key) view returns (bytes)',
  'function getAgentWallet(uint256 agentId) view returns (address)', 'function totalAgents() view returns (uint256)',
]);
export const ACCOUNT_ABI = parseAbi([
  'function vault() view returns (address)', 'function signer() view returns (address)', 'function owner() view returns (address)', 'function entryPoint() view returns (address)',
  'function deposit() view returns (uint256)', 'function addDeposit() payable', 'function setSigner(address s)',
  'error NotOwner()', 'error NotEntryPoint()', 'error TargetNotAllowed(address target)', 'error ValueNotAllowed(uint256 value)', 'error SelectorNotAllowed(bytes4 selector)', 'error BadCall()',
]);
export const FAUCET_ABI = parseAbi([
  'function drip()', 'function amount() view returns (uint256)', 'function cooldown() view returns (uint256)', 'function nextDripAt(address) view returns (uint256)',
  'error TooSoon(uint256 nextAt)', 'error Empty(uint256 balance,uint256 needed)', 'error TransferFailed()',
]);
