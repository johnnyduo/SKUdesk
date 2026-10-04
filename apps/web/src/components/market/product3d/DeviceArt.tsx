// 2D fallback for the 3D product viewer (no WebGL, context lost, or still loading): one flat silhouette per kind, accent coloured.
import { ART, type Role } from './art';
import CaseArt from './CaseArt';
import { caseSpecForSymbol } from './casespec';
import { accentOnDark, type Kind } from './specs';

const FILL: Record<Exclude<Role, 'accent'>, string> = { body: '#cfd2d8', trim: '#8f949c', dark: '#15181c' };

/** kind 'case' draws the clear-case illustration for `symbol`; every other kind draws its flat silhouette. */
export default function DeviceArt({ kind, accent, label, skeleton = false, symbol }: { kind: Kind; accent: string; label: string; skeleton?: boolean; symbol?: string }) {
  if (kind === 'case') return <CaseArt spec={caseSpecForSymbol(symbol)} accent={accent} skeleton={skeleton} label={skeleton ? 'Loading 3D model' : label} />;
  const edge = accentOnDark(accent), col = (c: Role) => (c === 'accent' ? edge : FILL[c]);
  return (
    <svg className="p3d-svg" viewBox="0 0 240 240" role="img" aria-label={skeleton ? 'Loading 3D model' : label} data-kind={kind} focusable="false">
      <g aria-hidden="true">
        {ART[kind as Exclude<Kind, 'case'>].map((s, i) => {
          if (s.t === 'rect') return <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} rx={s.r ?? 0} fill={col(s.c)} opacity={s.o} />;
          if (s.t === 'circle') return <circle key={i} cx={s.cx} cy={s.cy} r={s.r} fill={col(s.c)} opacity={s.o} />;
          return s.stroke ? <path key={i} d={s.d} fill="none" stroke={col(s.c)} strokeWidth={s.stroke} strokeLinecap="round" opacity={s.o} />
            : <path key={i} d={s.d} fill={col(s.c)} opacity={s.o} />;
        })}
      </g>
    </svg>
  );
}
