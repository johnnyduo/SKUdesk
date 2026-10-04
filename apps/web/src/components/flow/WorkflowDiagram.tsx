import { useEffect, useId, useState } from 'react';
import './flow.css';
import {
  CHECKS, EDGES, LAYOUTS, NODES, STAGE_ACTIVE, STAGE_NAMES, checkKeyOf, guardTarget, orth, stageCaption,
  type EdgeId, type Layout, type NodeId, type PacketKind, type Rect, type Trust,
} from './model';
import { RUN } from '../../lib/run';

export type WorkflowDiagramProps = {
  /** 0..5 matching the Show stages (Mandate, Agent thinks, Gates verify, Contract commits, Refusals, Settlement). null = idle gentle loop. */
  stage?: number | null;
  /** Contract error name (e.g. 'MathMismatch'). While set, the matching on-chain check flashes red with a stamp. */
  highlightGuard?: string | null;
  /** Small embed: hides node sub-lines and edge labels. */
  compact?: boolean;
  /** false renders a still diagram (no packets, no idle loop). Used for print-like embeds such as the deck. */
  animate?: boolean;
  /** Hide the plain-English caption under the diagram. */
  hideCaption?: boolean;
  className?: string;
};

const TRUST_LABEL: Record<Trust, string> = { enforced: 'enforced by the contract', hash: 'off-chain, committed as a hash', attested: 'agent-attested', plain: 'off-chain, not trusted' };
const IDLE_DWELL = 2800;

function useReducedMotion() {
  const [r, setR] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setR(mq.matches);
    const on = () => setR(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return r;
}

function Lines({ x, y, lines, lh, cls, anchor = 'start' }: { x: number; y: number; lines: string[]; lh: number; cls: string; anchor?: 'start' | 'middle' | 'end' }) {
  return (
    <text className={cls} x={x} y={y} textAnchor={anchor}>
      {lines.map((l, i) => <tspan key={i} x={x} dy={i === 0 ? 0 : lh}>{l}</tspan>)}
    </text>
  );
}

function Packet({ kind, d, i, n, dur, red }: { kind: PacketKind; d: string; i: number; n: number; dur: number; red?: boolean }) {
  const begin = `${(-(i * dur) / n).toFixed(2)}s`;
  const cls = red ? 'bad' : kind;
  return (
    <g className={`wf-packet ${cls}`} opacity="0">
      <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.08;0.9;1" dur={`${dur}s`} begin={begin} repeatCount="indefinite" />
      <animateMotion dur={`${dur}s`} begin={begin} repeatCount="indefinite" path={d} />
      {kind === 'money' || red ? (
        <>
          <circle r={red ? 7 : 8} />
          <text y="4" textAnchor="middle">{red ? '!' : '$'}</text>
        </>
      ) : (
        <rect x="-5" y="-5" width="10" height="10" rx="2" transform="rotate(45)" />
      )}
    </g>
  );
}

export default function WorkflowDiagram({ stage = null, highlightGuard = null, compact = false, animate = true, hideCaption = false, className = '' }: WorkflowDiagramProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const reduced = useReducedMotion();
  const moving = animate && !reduced;

  /* Idle loop: when no stage is driven from outside, walk the stages slowly. */
  const [auto, setAuto] = useState(0);
  useEffect(() => {
    if (stage !== null && stage !== undefined) return;
    if (!moving) return;
    const t = setInterval(() => setAuto((a) => (a + 1) % STAGE_NAMES.length), IDLE_DWELL);
    return () => clearInterval(t);
  }, [stage, moving]);

  const driven = stage !== null && stage !== undefined && stage >= 0;
  const idleStage = !driven && moving ? auto : null;
  const eff: number | null = driven ? stage! : idleStage;
  const guard = driven ? highlightGuard : eff === 4 ? RUN.attacks[0]?.error ?? null : null;
  const target = eff === 4 ? guardTarget(guard) : null;
  const failCheck = eff === 4 ? checkKeyOf(guard) : null;

  const act = eff === null ? null : STAGE_ACTIVE[eff];
  const activeNodes = new Set<NodeId>(act?.nodes ?? []);
  const activeEdges = new Set<EdgeId>(act?.edges ?? []);
  if (eff === 4 && target) {
    activeNodes.add(target.node);
    if (target.edge !== 'submit') { activeEdges.delete('submit'); activeEdges.add(target.edge); if (target.node !== 'commit') activeNodes.delete('commit'); }
  }
  const attackEdge = eff === 4 ? (target?.edge ?? 'submit') : null;
  const stampNode: NodeId | null = eff === 4 && guard ? (target?.node ?? 'commit') : null;

  const caption = stageCaption(eff, guard);
  const stageName = eff === null ? 'idle' : `stage ${eff + 1} of 6, ${STAGE_NAMES[eff]}`;

  const render = (key: 'wide' | 'tall') => {
    const L: Layout = LAYOUTS[key];
    const m = key === 'tall';
    const id = `${uid}${key}`;
    const rect = (n: NodeId): Rect => L.nodes[n];
    const lhT = m ? 18 : 20, lhS = m ? 15 : 17;
    return (
      <svg key={key} className={`wf-svg wf-${key}`} viewBox={`0 0 ${L.vw} ${L.vh}`} role="img" aria-labelledby={`${id}t`} focusable="false">
        <title id={`${id}t`}>SKUdesk workflow: owner mandate, market snapshot, AI agent and identity gates off-chain; commit check, vault, lot escrow, allowlisted supplier, allowlisted payer and settlement on Robinhood Chain Testnet. Currently showing {stageName}.</title>
        <defs>
          {(['money', 'data', 'attested', 'bad'] as const).map((k) => (
            <marker key={k} id={`${id}m${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" className={`wf-mk ${k}`} />
            </marker>
          ))}
        </defs>

        {/* lanes */}
        <g className="wf-lane off">
          <rect x={L.lanes.off.x} y={L.lanes.off.y} width={L.lanes.off.w} height={L.lanes.off.h} rx="14" />
          <text className="wf-lane-tag" x={L.lanes.off.x + 16} y={L.lanes.off.y + 4}>{L.lanes.offTag}</text>
        </g>
        <g className="wf-lane on">
          <rect x={L.lanes.on.x} y={L.lanes.on.y} width={L.lanes.on.w} height={L.lanes.on.h} rx="14" />
          <text className="wf-lane-tag" x={L.lanes.onTagX} y={L.lanes.on.y + 4}>{L.lanes.onTag}</text>
        </g>

        {/* edges (under nodes) */}
        <g>
          {(Object.keys(EDGES) as EdgeId[]).map((eid) => {
            const e = EDGES[eid];
            const d = orth(L.edges[eid].pts, 10);
            const on = activeEdges.has(eid);
            const isAtk = attackEdge === eid;
            const mk = isAtk ? 'bad' : e.kind;
            return (
              <path key={eid} d={d} className={`wf-edge ${e.kind}${on ? ' on' : ''}${isAtk ? ' atk' : ''}${act && !on ? ' dim' : ''}`} markerEnd={`url(#${id}m${mk})`} fill="none">
                <title>{e.name}</title>
              </path>
            );
          })}
        </g>

        {/* edge labels */}
        {!compact && (
          <g className="wf-labels">
            {(Object.keys(EDGES) as EdgeId[]).map((eid) => {
              const e = EDGES[eid], pos = L.edges[eid].label;
              const lines = m ? e.linesM ?? e.lines : e.lines;
              if (!pos || !lines.length) return null;
              const on = activeEdges.has(eid);
              return <Lines key={eid} x={pos.x} y={pos.y} lines={lines} lh={pos.step ?? 15} cls={`wf-elabel ${e.kind}${on ? ' on' : ''}${act && !on ? ' dim' : ''}`} anchor={pos.anchor} />;
            })}
          </g>
        )}

        {/* nodes */}
        <g>
          {(Object.keys(NODES) as NodeId[]).map((nid) => {
            const nd = NODES[nid];
            const r = rect(nid);
            const on = activeNodes.has(nid);
            const bad = stampNode === nid;
            const title = m && nd.title2 ? nd.title2 : nd.title;
            const sub = m && nd.subM ? nd.subM : nd.sub;
            const cls = `wf-node ${nd.trust}${on ? ' on' : ''}${bad ? ' bad' : ''}${act && !on ? ' dim' : ''}${nid === 'agent' && eff === 1 ? ' think' : ''}`;
            return (
              <g key={nid} className={cls}>
                <title>{`${title.join(' ')}: ${TRUST_LABEL[nd.trust]}`}</title>
                <rect className="wf-box" x={r.x} y={r.y} width={r.w} height={r.h} rx="10" strokeDasharray={nd.trust === 'hash' ? '6 4' : undefined} />
                <Lines x={r.x + 14} y={r.y + 12 + lhT - 3} lines={title} lh={lhT} cls="wf-title" />
                {!compact && nid !== 'commit' && <Lines x={r.x + 14} y={r.y + 12 + lhT - 3 + title.length * lhT + 1} lines={sub} lh={lhS} cls="wf-sub" />}
                {nid === 'commit' && !compact && <Lines x={r.x + 14} y={r.y + 12 + lhT - 3 + lhT + 1} lines={sub} lh={lhS} cls="wf-sub" />}
                {nid === 'agent' && eff === 1 && moving && (
                  <g className="wf-dots" transform={`translate(${r.x + r.w - 40} ${r.y + 22})`}><circle cx="0" r="2.6" /><circle cx="10" r="2.6" /><circle cx="20" r="2.6" /></g>
                )}
                {nid === 'commit' && (
                  <g>
                    {CHECKS.map((c, i) => {
                      const p = L.checks(r, i);
                      const failing = failCheck === c.key;
                      const passing = eff === 3;
                      return (
                        <g key={c.key} className={`wf-check${failing ? ' fail' : ''}${passing ? ' pass' : ''}${eff === 4 && !failing ? ' calm' : ''}`} transform={`translate(${p.x} ${p.y})`}>
                          <circle r="7.5" />
                          {failing ? <path d="M-3 -3 L3 3 M3 -3 L-3 3" /> : <path d="M-3.4 0.2 L-1 2.8 L3.6 -2.6" style={passing && moving ? { animationDelay: `${0.25 + i * 0.32}s` } : undefined} />}
                          <text x="15" y="4.5">{c.label}</text>
                        </g>
                      );
                    })}
                  </g>
                )}
              </g>
            );
          })}
        </g>

        {/* moving packets */}
        {moving && act && (
          <g className="wf-packets" aria-hidden="true">
            {(Array.from(activeEdges) as EdgeId[]).map((eid) => {
              const e = EDGES[eid];
              const d = orth(L.edges[eid].pts, 10);
              const red = attackEdge === eid;
              const dur = red ? 1.6 : 2.6;
              return Array.from({ length: red ? 2 : 2 }, (_, i) => <Packet key={`${eid}${i}${eff}`} kind={e.kind} d={d} i={i} n={2} dur={dur} red={red} />);
            })}
          </g>
        )}

        {/* revert stamp */}
        {stampNode && guard && (() => {
          const r = rect(stampNode);
          const sw = m ? 156 : 184;
          const raw: [number, number] = stampNode === 'commit' ? L.stampAt : [r.x + r.w / 2, r.y + r.h + 40];
          const sx = Math.min(L.vw - 10 - sw / 2, Math.max(10 + sw / 2, raw[0])), sy = raw[1];
          return (
            <g key={`${guard}`} className="wf-stamp" transform={`translate(${sx} ${sy}) rotate(-7)`}>
              <rect x={-sw / 2} y="-30" width={sw} height="60" rx="8" />
              <text className="wf-stamp-h" y="-4" textAnchor="middle">REVERTED</text>
              <text className="wf-stamp-s" y="18" textAnchor="middle">{guard}</text>
            </g>
          );
        })()}
      </svg>
    );
  };

  return (
    <figure className={`wf${compact ? ' compact' : ''}${className ? ' ' + className : ''}`} data-stage={eff ?? 'idle'}>
      {render('wide')}
      {render('tall')}
      <ul className="wf-legend" aria-label="Legend">
        <li><i className="sw enforced" />Enforced by the contract</li>
        <li><i className="sw hash" />Off-chain, committed as a hash</li>
        <li><i className="sw attested" />Agent-attested</li>
        <li><i className="sw plain" />Off-chain, not trusted</li>
        <li><i className="pk money" aria-hidden="true">$</i>Money packet</li>
        <li><i className="pk data" aria-hidden="true" />Data packet</li>
      </ul>
      {!hideCaption && (
        <figcaption className="wf-cap" aria-live={driven ? 'polite' : 'off'}>
          {eff !== null && <b className="wf-cap-stage">{eff + 1}. {STAGE_NAMES[eff]}</b>}
          <span>{caption}</span>
        </figcaption>
      )}
    </figure>
  );
}
