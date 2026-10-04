// Compact menu for phones: the six story steps (from JOURNEY), so a phone user can reach every step. Hidden on wide screens, where the header shows links.
import { useEffect, useRef, useState } from 'react';
import { JOURNEY } from '../../lib/journey';

export default function NavMenu({ current = '/market' }: { current?: string }) {
  const [open, setOpen] = useState(false); const root = useRef<HTMLDivElement>(null); const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('pointerdown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className="mk-menu" ref={root}>
      <button ref={btn} type="button" className="mk-menu-btn" data-testid="nav-menu-btn" aria-expanded={open} aria-controls="mk-menu-list" aria-label="Menu: the six steps of the story" onClick={() => setOpen((o) => !o)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">{open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}</svg>
      </button>
      {open && (
        <nav className="mk-menu-list" id="mk-menu-list" aria-label="The six steps">
          <ol>
            {JOURNEY.map((s) => (
              <li key={s.n}><a href={s.href} aria-current={s.href === current ? 'page' : undefined} onClick={() => setOpen(false)}><span className="mk-menu-n" aria-hidden="true">{s.n}</span><span>{s.label}</span></a></li>
            ))}
          </ol>
        </nav>
      )}
    </div>
  );
}
