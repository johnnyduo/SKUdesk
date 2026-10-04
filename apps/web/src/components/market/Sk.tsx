// A neutral loading placeholder as TEXT-sized inline block: same line height as the text it stands for (no layout shift), no market identity.
export default function Sk({ n = 8, className = '' }: { n?: number; className?: string }) {
  return <span className={`mk-sk mk-sk-t ${className}`.trim()} aria-hidden="true">{' '.repeat(n)}</span>;
}
