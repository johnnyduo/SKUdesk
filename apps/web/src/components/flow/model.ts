// Data and geometry for the canonical SKUdesk workflow diagram.
// Every number shown comes from lib/run.ts (the run), nothing is invented here.
import { RUN, SNAPSHOT, DEPLOYMENT, ECON, GUARDS, usdCents, usdBase, pct, short, type RunEvent } from '../../lib/run';

export type NodeId = 'owner' | 'snapshot' | 'agent' | 'gates' | 'commit' | 'vault' | 'escrow' | 'supplier' | 'payer' | 'settle';
export type EdgeId = 'mandate' | 'reads' | 'offers' | 'proposal' | 'submit' | 'accepted' | 'fund' | 'pay' | 'attest' | 'proceeds' | 'credit';
/** enforced = the contract enforces it; hash = off-chain, committed on-chain as a hash; attested = the contract takes the agent's word; plain = off-chain, not trusted */
export type Trust = 'enforced' | 'hash' | 'attested' | 'plain';
export type PacketKind = 'money' | 'data' | 'attested';

export const STAGE_NAMES = ['Mandate', 'Agent thinks', 'Gates verify', 'Contract commits', 'Refusals', 'Settlement'] as const;

/* the commit check list, in contract order (error names are real, see GUARDS) */
export const CHECKS: { key: string; label: string; errors: string[] }[] = [
  { key: 'MathMismatch', label: 'Economics re-derived', errors: ['MathMismatch', 'OutOfBounds', 'BadUnits'] },
  { key: 'SpendCap', label: 'Spend cap', errors: ['SpendCap'] },
  { key: 'DailyCap', label: 'Daily cap', errors: ['DailyCap'] },
  { key: 'Stale', label: 'Quote is fresh', errors: ['Stale', 'FutureObservation'] },
  { key: 'BadQuoteHash', label: 'Quote hash', errors: ['BadQuoteHash'] },
  { key: 'Replay', label: 'No replay', errors: ['Replay'] },
  { key: 'MarginTooLow', label: 'Margin floor', errors: ['MarginTooLow', 'NonPositiveNet'] },
];
export const checkKeyOf = (err?: string | null) => (err ? CHECKS.find((c) => c.errors.includes(err))?.key ?? null : null);

/** Which node/edge each guard error lights up. Anything not listed is a commit-check error. */
export const GUARD_TARGET: Record<string, { node: NodeId; edge: EdgeId }> = {
  PayeeNotAllowed: { node: 'supplier', edge: 'pay' },
  PayerNotAllowed: { node: 'payer', edge: 'proceeds' },
  InsufficientFree: { node: 'vault', edge: 'fund' },
  ExceedsEscrow: { node: 'escrow', edge: 'pay' },
  BadTransition: { node: 'escrow', edge: 'attest' },
  UnknownOpportunity: { node: 'escrow', edge: 'fund' },
  OpportunityConsumed: { node: 'escrow', edge: 'fund' },
};
export const guardTarget = (err?: string | null): { node: NodeId; edge: EdgeId } | null => {
  if (!err) return null;
  return GUARD_TARGET[err] ?? { node: 'commit', edge: 'submit' };
};

/* which parts are lit at each stage */
export const STAGE_ACTIVE: { nodes: NodeId[]; edges: EdgeId[] }[] = [
  { nodes: ['owner', 'snapshot'], edges: ['mandate', 'reads'] },
  { nodes: ['agent', 'snapshot'], edges: ['offers'] },
  { nodes: ['gates', 'agent'], edges: ['proposal'] },
  { nodes: ['commit', 'vault', 'escrow'], edges: ['submit', 'accepted', 'fund'] },
  { nodes: ['commit'], edges: ['submit'] },
  { nodes: ['escrow', 'supplier', 'payer', 'settle', 'vault'], edges: ['pay', 'attest', 'proceeds', 'credit'] },
];

/* event kinds -> stages (shared by /app/agent and the Show) */
export const isFailedTx = (e: RunEvent) => e.kind === 'tx' && e.tx?.status === 'reverted';
export function stageOfEvent(e: RunEvent): number {
  switch (e.kind) {
    case 'policy': case 'snapshot': return 0;
    case 'agent': case 'reason': return 1;
    case 'gate': case 'econ': return 2;
    case 'revert': return 4;
    case 'state': return 5;
    case 'tx': {
      if (isFailedTx(e)) return 4;
      return /^(commitOpportunity|mintLot|fundLot)/.test(e.title) ? 3 : 5;
    }
    default: return 1;
  }
}
/** The guard error an attack event demonstrates. The one failed on-chain tx is the inflated-profit commit. */
export function guardOfEvent(e: RunEvent): string | undefined {
  if (e.kind === 'revert') return e.data?.error;
  if (isFailedTx(e)) return RUN.attacks.find((a) => /inflat/i.test(a.name))?.error ?? RUN.attacks[0]?.error;
  return undefined;
}

/* labels derived from the run */
const fmt0 = (cents: number | string) => '$' + Math.round(Number(cents) / 100).toLocaleString('en-US');
const n = SNAPSHOT.offers.length;
const policy = RUN.policy;
export const SPEND = usdCents(ECON.spendCents);
export const PROCEEDS = usdBase(RUN.end.totalProceeds);

export type NodeDef = { id: NodeId; trust: Trust; title: string[]; sub: string[]; subM?: string[]; title2?: string[] };
export const NODES: Record<NodeId, NodeDef> = {
  owner: { id: 'owner', trust: 'enforced', title: ['Owner mandate'], sub: [`${fmt0(policy.maxExec)} per trade`, `${fmt0(policy.dailySpendCap)} per day · ${pct(policy.minMarginBps).replace('.00', '')} floor`], subM: [`${fmt0(policy.maxExec)} per trade`, `${fmt0(policy.dailySpendCap)} new commitments per UTC day`, `${pct(policy.minMarginBps).replace('.00', '')} margin floor`] },
  snapshot: { id: 'snapshot', trust: 'hash', title: ['Market snapshot'], title2: ['Market', 'snapshot'], sub: [`${n} offers`, `hash ${short(RUN.meta.snapshotHash, 6, 4)}`], subM: [`${n} offers`, `hash ${short(RUN.meta.snapshotHash, 4, 4)}`] },
  agent: { id: 'agent', trust: 'plain', title: ['AI agent'], sub: ['language model', 'proposes, never pays'], subM: ['language model', 'only proposes'] },
  gates: { id: 'gates', trust: 'hash', title: ['Identity gates'], sub: ['TypeScript, same SKU', 'off-chain, hashed'], subM: ['TypeScript, same', 'SKU check'] },
  commit: { id: 'commit', trust: 'enforced', title: ['Commit check'], sub: ['the contract re-derives it'], subM: ['re-derives it all'] },
  vault: { id: 'vault', trust: 'enforced', title: ['Vault'], sub: ['free funds'] },
  escrow: { id: 'escrow', trust: 'enforced', title: [`Lot #${RUN.meta.lot} escrow`], sub: ['locked for one purchase'], subM: ['locked for one', 'purchase'] },
  supplier: { id: 'supplier', trust: 'enforced', title: ['Allowlisted', 'supplier'], sub: [short(DEPLOYMENT.supplier, 6, 4)] },
  payer: { id: 'payer', trust: 'enforced', title: ['Allowlisted payer', '/ marketplace'], sub: [short(DEPLOYMENT.payer, 6, 4)], title2: ['Allowlisted', 'payer'] },
  settle: { id: 'settle', trust: 'enforced', title: ['Settlement'], sub: ['profit = tokens received', 'minus paid out'], subM: ['profit = received', 'minus paid out'] },
};

export type EdgeDef = { id: EdgeId; kind: PacketKind; from: NodeId; to: NodeId; lines: string[]; linesM?: string[]; name: string };
export const EDGES: Record<EdgeId, EdgeDef> = {
  mandate: { id: 'mandate', kind: 'data', from: 'owner', to: 'commit', lines: ['sets caps, floor, TTL on-chain'], linesM: ['sets', 'mandate'], name: 'Owner writes the mandate on-chain' },
  reads: { id: 'reads', kind: 'data', from: 'owner', to: 'agent', lines: ['reads the mandate'], linesM: [], name: 'Agent reads the mandate' },
  offers: { id: 'offers', kind: 'data', from: 'snapshot', to: 'agent', lines: [`${n} offers`], linesM: [], name: 'Agent receives the offers' },
  proposal: { id: 'proposal', kind: 'data', from: 'agent', to: 'gates', lines: [`${RUN.accepted.units} units`], linesM: ['proposal'], name: 'Agent proposes a buy and sell pair' },
  submit: { id: 'submit', kind: 'data', from: 'gates', to: 'commit', lines: ['commitOpportunity(quote, claimed net)'], linesM: ['commitOpportunity'], name: 'Agent submits the proposal to the contract' },
  accepted: { id: 'accepted', kind: 'data', from: 'commit', to: 'vault', lines: ['accepted'], name: 'Contract accepts the opportunity' },
  fund: { id: 'fund', kind: 'money', from: 'vault', to: 'escrow', lines: ['fundLot', SPEND], name: 'Vault funds the lot escrow' },
  pay: { id: 'pay', kind: 'money', from: 'escrow', to: 'supplier', lines: ['pay', SPEND], name: 'Escrow pays the allowlisted supplier' },
  attest: { id: 'attest', kind: 'attested', from: 'escrow', to: 'settle', lines: ['received, listed, sold', 'agent-attested'], linesM: ['agent-attested'], name: 'Agent attests received, listed and sold' },
  proceeds: { id: 'proceeds', kind: 'money', from: 'payer', to: 'settle', lines: ['proceeds', PROCEEDS], linesM: ['proceeds', PROCEEDS], name: 'Payer sends the sale proceeds' },
  credit: { id: 'credit', kind: 'money', from: 'settle', to: 'vault', lines: ['proceeds join', 'free funds'], linesM: ['to vault'], name: 'Proceeds return to free funds' },
};

/* geometry */
export type Rect = { x: number; y: number; w: number; h: number };
export type Pt = [number, number];
export type Anchor = 'start' | 'middle' | 'end';
export type LabelPos = { x: number; y: number; anchor: Anchor; step?: number };
export type Layout = {
  vw: number; vh: number;
  lanes: { off: Rect; on: Rect; offTag: string; onTag: string; onTagX: number };
  nodes: Record<NodeId, Rect>;
  edges: Record<EdgeId, { pts: Pt[]; label?: LabelPos }>;
  checks: (r: Rect, i: number) => { x: number; y: number };
  stampAt: Pt;
};

const cx = (r: Rect) => r.x + r.w / 2;
const cy = (r: Rect) => r.y + r.h / 2;
const R = (r: Rect) => r.x + r.w;
const B = (r: Rect) => r.y + r.h;

/** Orthogonal polyline with rounded corners. */
export function orth(pts: Pt[], r = 12): string {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i], [nx, ny] = pts[i + 1];
    const l1 = Math.hypot(x - px, y - py), l2 = Math.hypot(nx - x, ny - y);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = x - ((x - px) / l1) * rr, ay = y - ((y - py) / l1) * rr;
    const bx = x + ((nx - x) / l2) * rr, by = y + ((ny - y) / l2) * rr;
    d += ` L${ax} ${ay} Q${x} ${y} ${bx} ${by}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return d + ` L${lx} ${ly}`;
}

const OFF_TAG = 'OFF-CHAIN: the agent proposes, nothing here can move money';
const ON_TAG = 'ON-CHAIN: Robinhood Chain Testnet, enforced by the contract';

function wide(): Layout {
  const nodes = {
    owner: { x: 36, y: 84, w: 200, h: 88 },
    snapshot: { x: 330, y: 84, w: 180, h: 88 },
    agent: { x: 590, y: 84, w: 180, h: 88 },
    gates: { x: 850, y: 84, w: 180, h: 88 },
    commit: { x: 36, y: 296, w: 200, h: 296 },
    vault: { x: 330, y: 296, w: 180, h: 88 },
    escrow: { x: 590, y: 296, w: 180, h: 88 },
    supplier: { x: 850, y: 296, w: 180, h: 88 },
    settle: { x: 590, y: 470, w: 180, h: 88 },
    payer: { x: 850, y: 470, w: 180, h: 88 },
  } as Record<NodeId, Rect>;
  const N = nodes;
  const edges = {
    mandate: { pts: [[cx(N.owner), B(N.owner)], [cx(N.owner), N.commit.y]] as Pt[], label: { x: cx(N.owner) + 10, y: 200, anchor: 'start' } as LabelPos },
    reads: { pts: [[cx(N.owner), N.owner.y], [cx(N.owner), 58], [cx(N.agent), 58], [cx(N.agent), N.agent.y]] as Pt[], label: { x: 440, y: 52, anchor: 'middle' } as LabelPos },
    offers: { pts: [[R(N.snapshot), cy(N.snapshot)], [N.agent.x, cy(N.agent)]] as Pt[], label: { x: (R(N.snapshot) + N.agent.x) / 2, y: cy(N.agent) - 10, anchor: 'middle' } as LabelPos },
    proposal: { pts: [[R(N.agent), cy(N.agent)], [N.gates.x, cy(N.gates)]] as Pt[], label: { x: (R(N.agent) + N.gates.x) / 2, y: cy(N.agent) - 10, anchor: 'middle' } as LabelPos },
    submit: { pts: [[cx(N.gates), B(N.gates)], [cx(N.gates), 240], [R(N.commit) - 28, 240], [R(N.commit) - 28, N.commit.y]] as Pt[], label: { x: 560, y: 232, anchor: 'middle' } as LabelPos },
    accepted: { pts: [[R(N.commit), cy(N.vault)], [N.vault.x, cy(N.vault)]] as Pt[], label: { x: (R(N.commit) + N.vault.x) / 2, y: cy(N.vault) - 10, anchor: 'middle' } as LabelPos },
    fund: { pts: [[R(N.vault), cy(N.vault)], [N.escrow.x, cy(N.escrow)]] as Pt[], label: { x: (R(N.vault) + N.escrow.x) / 2, y: cy(N.vault) - 10, anchor: 'middle', step: 30 } as LabelPos },
    pay: { pts: [[R(N.escrow), cy(N.escrow)], [N.supplier.x, cy(N.supplier)]] as Pt[], label: { x: (R(N.escrow) + N.supplier.x) / 2, y: cy(N.escrow) - 10, anchor: 'middle', step: 30 } as LabelPos },
    attest: { pts: [[cx(N.escrow), B(N.escrow)], [cx(N.settle), N.settle.y]] as Pt[], label: { x: cx(N.escrow) + 12, y: 418, anchor: 'start' } as LabelPos },
    proceeds: { pts: [[N.payer.x, cy(N.payer)], [R(N.settle), cy(N.settle)]] as Pt[], label: { x: (R(N.settle) + N.payer.x) / 2, y: cy(N.payer) - 10, anchor: 'middle', step: 30 } as LabelPos },
    credit: { pts: [[N.settle.x, cy(N.settle)], [cx(N.vault), cy(N.settle)], [cx(N.vault), B(N.vault)]] as Pt[], label: { x: cx(N.vault) + 12, y: 452, anchor: 'start' } as LabelPos },
  };
  return {
    vw: 1100, vh: 650,
    lanes: { off: { x: 10, y: 22, w: 1080, h: 192 }, on: { x: 10, y: 262, w: 1080, h: 364 }, offTag: OFF_TAG, onTag: ON_TAG, onTagX: 262 },
    nodes, edges,
    checks: (r, i) => ({ x: r.x + 18, y: r.y + 84 + i * 29 }),
    stampAt: [cx(N.commit), B(N.commit) + 4],
  };
}

function tall(): Layout {
  const nodes = {
    owner: { x: 10, y: 44, w: 136, h: 92 },
    snapshot: { x: 184, y: 44, w: 136, h: 92 },
    agent: { x: 85, y: 172, w: 160, h: 76 },
    gates: { x: 85, y: 276, w: 160, h: 76 },
    commit: { x: 10, y: 408, w: 310, h: 172 },
    vault: { x: 10, y: 622, w: 127, h: 84 },
    escrow: { x: 193, y: 622, w: 127, h: 84 },
    settle: { x: 10, y: 762, w: 127, h: 84 },
    supplier: { x: 193, y: 762, w: 127, h: 84 },
    payer: { x: 10, y: 902, w: 127, h: 84 },
  } as Record<NodeId, Rect>;
  const N = nodes;
  const edges = {
    mandate: { pts: [[26, B(N.owner)], [26, N.commit.y]] as Pt[], label: { x: 34, y: 232, anchor: 'start' } as LabelPos },
    reads: { pts: [[78, B(N.owner)], [78, 156], [145, 156], [145, N.agent.y]] as Pt[] },
    offers: { pts: [[252, B(N.snapshot)], [252, 156], [185, 156], [185, N.agent.y]] as Pt[] },
    proposal: { pts: [[cx(N.agent), B(N.agent)], [cx(N.agent), N.gates.y]] as Pt[], label: { x: cx(N.agent) + 10, y: 267, anchor: 'start' } as LabelPos },
    submit: { pts: [[cx(N.gates), B(N.gates)], [cx(N.gates), N.commit.y]] as Pt[], label: { x: cx(N.gates) + 10, y: 368, anchor: 'start' } as LabelPos },
    accepted: { pts: [[cx(N.vault), B(N.commit)], [cx(N.vault), N.vault.y]] as Pt[], label: { x: cx(N.vault) - 8, y: 606, anchor: 'end' } as LabelPos },
    fund: { pts: [[R(N.vault), cy(N.vault)], [N.escrow.x, cy(N.escrow)]] as Pt[], label: { x: (R(N.vault) + N.escrow.x) / 2, y: cy(N.vault) - 10, anchor: 'middle', step: 30 } as LabelPos },
    pay: { pts: [[cx(N.escrow), B(N.escrow)], [cx(N.escrow), N.supplier.y]] as Pt[], label: { x: cx(N.escrow) + 8, y: 730, anchor: 'start' } as LabelPos },
    attest: { pts: [[cx(N.escrow) - 40, B(N.escrow)], [cx(N.escrow) - 40, 734], [cx(N.settle) + 28, 734], [cx(N.settle) + 28, N.settle.y]] as Pt[], label: { x: 168, y: 727, anchor: 'middle' } as LabelPos },
    proceeds: { pts: [[cx(N.payer), N.payer.y], [cx(N.payer), B(N.settle)]] as Pt[], label: { x: cx(N.payer) + 10, y: 876, anchor: 'start' } as LabelPos },
    credit: { pts: [[cx(N.settle) - 34, N.settle.y], [cx(N.settle) - 34, B(N.vault)]] as Pt[], label: { x: cx(N.settle) - 26, y: 744, anchor: 'start' } as LabelPos },
  };
  return {
    vw: 330, vh: 1008,
    lanes: { off: { x: 2, y: 16, w: 326, h: 356 }, on: { x: 2, y: 384, w: 326, h: 608 }, offTag: 'OFF-CHAIN: agent proposes', onTag: 'ON-CHAIN: enforced', onTagX: 40 },
    nodes, edges,
    checks: (r, i) => ({ x: r.x + 14 + (i % 2) * 152, y: r.y + 78 + Math.floor(i / 2) * 26 }),
    stampAt: [N.commit.x + N.commit.w - 86, N.commit.y + 36],
  };
}
export const LAYOUTS = { wide: wide(), tall: tall() };

/* plain-English caption for each stage, with the real numbers */
export const stageCaption = (stage: number | null, guard?: string | null): string => {
  const a = RUN.accepted;
  switch (stage) {
    case 0: return `The owner has written the mandate on-chain: up to ${usdCents(policy.maxExec)} per trade, ${usdCents(policy.dailySpendCap)} of new commitments per UTC day, a ${pct(policy.minMarginBps)} margin floor and quotes the agent dates no older than ${policy.quoteTTL} seconds. The agent reads it, and receives the market snapshot (${n} offers; its hash ${short(RUN.meta.snapshotHash, 8, 6)} is committed on-chain).`;
    case 1: return `The agent reads the ${n} offers and proposes one trade: buy ${a.buyOfferId}, sell ${a.sellOfferId}, ${a.units} units. It can only propose. It holds no money.`;
    case 2: return `Plain TypeScript checks that both offers are exactly the same product, then computes the unit economics in whole cents: ${usdCents(ECON.landedCents)} landed cost, ${usdCents(ECON.netCents)} net per unit, ${pct(ECON.marginBps)} margin. The result is committed on-chain only as a hash.`;
    case 3: return `The agent submits commitOpportunity. The contract re-derives the economics and the spend itself, checks the caps, freshness, quote hash and replay, then creates lot #${RUN.meta.lot} and moves exactly ${SPEND} from the vault into its escrow.`;
    case 4: {
      const att = guard ? RUN.attacks.find((x) => x.error === guard) : undefined;
      return att ? `${att.name}. ${att.sentence} The contract refused and undid the transaction (a revert); no money moved.` : 'The agent tries to cheat. Each attempt reaches the contract, which refuses and undoes the transaction (a revert); no money moves.';
    }
    case 5: return `Escrow pays the owner-approved supplier ${SPEND}. Received, listed and sold are attested by the agent (the contract cannot see the real world). The approved payer sends ${PROCEEDS}, and profit is measured on tokens actually received.`;
    default: return 'Idle loop: the six stages of the run, one after another. Green circles carry money, teal diamonds carry data.';
  }
};
export const GUARD_NAMES = new Set(GUARDS.map((g) => g.error));
