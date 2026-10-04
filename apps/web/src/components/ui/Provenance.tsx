import { PROVENANCE, type Provenance as Kind } from '../../lib/provenance';
// React twin of Provenance.astro (same classes; styles are in styles/global.css).
export default function Provenance({ kind, note }: { kind: Kind; note?: string }) {
  const p = PROVENANCE[kind];
  return <span className={`prov prov-${kind}`} title={note ? `${p.tip} (${note})` : p.tip}>{p.label}{note ? <span className="prov-n"> · {note}</span> : null}</span>;
}
