// Static SVG illustration of the clear phone case (back view): used as the loading skeleton and as the no-WebGL fallback.
import { useId } from 'react';
import { CASE_WALL, type CaseSpec } from './casespec';

export default function CaseArt({ spec, accent, skeleton = false, label }: { spec: CaseSpec; accent: string; skeleton?: boolean; label?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, ''); const u = (n: string) => `p3${id}${n}`;
  const { W, H, r } = spec, w = CASE_WALL, pad = 10;
  const vb = `${-W / 2 - pad} ${-H / 2 - pad} ${W + 2 * pad} ${H + 2 * pad}`;
  const lens = (l: { x: number; y: number; r: number }, k: number) => (
    <g key={k}>
      <circle cx={l.x} cy={l.y} r={l.r} fill={`url(#${u('metal')})`} />
      <circle cx={l.x} cy={l.y} r={l.r - 1.1} fill="#05060b" />
      <circle cx={l.x} cy={l.y} r={(l.r - 1.1) * 0.58} fill="none" stroke="#2a3a9a" strokeWidth={0.9} opacity={0.8} />
      <circle cx={l.x} cy={l.y} r={(l.r - 1.1) * 0.3} fill="#0a0d1c" />
      <circle cx={l.x - l.r * 0.3} cy={l.y + l.r * 0.3} r={l.r * 0.1} fill="#cfd6ff" opacity={0.75} />
    </g>
  );
  const p = spec.plateau;
  return (
    <svg className={'p3d-svg' + (skeleton ? ' skel' : '')} viewBox={vb} role="img" aria-label={label ?? `${spec.key} clear case illustration`} data-kind="case" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id={u('body')} x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor={spec.glass} /><stop offset="1" stopColor={spec.frame} /></linearGradient>
        <linearGradient id={u('metal')} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f1f3f6" /><stop offset="0.5" stopColor="#a8acb2" /><stop offset="1" stopColor="#e4e6ea" /></linearGradient>
        <linearGradient id={u('sheen')} x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset="0.42" stopColor="#fff" stopOpacity="0.22" /><stop offset="0.5" stopColor="#fff" stopOpacity="0" /><stop offset="0.72" stopColor="#fff" stopOpacity="0.1" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
        <filter id={u('glow')} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2" /></filter>
        <clipPath id={u('clip')}><rect x={-W / 2 - w} y={-H / 2 - w} width={W + 2 * w} height={H + 2 * w} rx={r + w} /></clipPath>
      </defs>
      <g transform="scale(1,-1)">
        <rect x={-W / 2 - w} y={-H / 2 - w} width={W + 2 * w} height={H + 2 * w} rx={r + w} fill="none" stroke={accent} strokeWidth={2.4} opacity={0.55} filter={`url(#${u('glow')})`} className="p3d-svg-glow" />
        <rect x={-W / 2} y={-H / 2} width={W} height={H} rx={r} fill={`url(#${u('body')})`} stroke={spec.frame} strokeWidth={0.8} />
        {spec.buttons.map((b, i) => <rect key={i} x={b.side === 'R' ? W / 2 - 0.2 : -W / 2 - 0.8} y={b.y - b.len / 2} width={1} height={b.len} rx={0.5} fill={spec.frame} />)}
        {p && <rect x={p.cx - p.w / 2} y={p.cy - p.h / 2} width={p.w} height={p.h} rx={p.r} fill={spec.plateauCol} stroke="#00000055" strokeWidth={0.5} />}
        {spec.pill && <rect x={spec.pill.cx - spec.pill.w / 2} y={spec.pill.cy - spec.pill.h / 2} width={spec.pill.w} height={spec.pill.h} rx={spec.pill.r} fill="#05060b" />}
        {spec.lenses.map((l, i) => lens(l, i))}
        {spec.flash.map((f, i) => <circle key={i} cx={f.x} cy={f.y} r={f.r} fill="#f4ead2" />)}
        {spec.lidar && <circle cx={spec.lidar.x} cy={spec.lidar.y} r={spec.lidar.r} fill="#05060b" stroke="#2a3a9a" strokeWidth={0.6} />}
        {spec.magsafe && <circle cx={0} cy={-4} r={28} fill="none" stroke="#fff" strokeWidth={1} opacity={0.5} />}
        {spec.cutouts.map((c, i) => <rect key={i} x={c.cx - c.w / 2} y={c.cy - c.h / 2} width={c.w} height={c.h} rx={c.r} fill="none" stroke="#ffffff" strokeOpacity={0.5} strokeWidth={1.1} />)}
        <rect x={-W / 2 - w} y={-H / 2 - w} width={W + 2 * w} height={H + 2 * w} rx={r + w} fill="#ffffff" fillOpacity={0.045} stroke="#ffffff" strokeOpacity={0.4} strokeWidth={1.1} />
        <rect x={-W / 2 - w + 3.2} y={-H / 2 - w + 3.2} width={W + 2 * w - 6.4} height={H + 2 * w - 6.4} rx={r - 1} fill="none" stroke="#ffffff" strokeOpacity={0.16} strokeWidth={0.8} />
        <g clipPath={`url(#${u('clip')})`}><rect x={-W} y={-H} width={2 * W} height={2 * H} fill={`url(#${u('sheen')})`} /></g>
        <rect x={-W / 2 - w} y={-H / 2 - w} width={W + 2 * w} height={H + 2 * w} rx={r + w} fill="none" stroke={accent} strokeWidth={0.9} opacity={0.9} />
      </g>
    </svg>
  );
}
