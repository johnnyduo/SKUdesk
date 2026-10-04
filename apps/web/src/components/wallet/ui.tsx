import type { ReactNode } from 'react';
import { explorer, short } from '../../lib/run';
import './wallet.css';

// Small presentational pieces shared by the Owner console and the Deploy-your-agent page.

export function Addr({ a, label }: { a: string; label?: string }) {
  const href = explorer.address(a);
  return href
    ? <a className="wl-a mono" href={href} target="_blank" rel="noopener noreferrer" title={a}>{label ?? short(a, 6, 4)} ↗<span className="sr-only"> (opens the block explorer in a new tab)</span></a>
    : <span className="mono" title={a}>{label ?? short(a, 6, 4)}</span>;
}

export function Field({ id, label, hint, value, onChange, testid, error, prefix, suffix, inputMode = 'decimal', disabled, placeholder, onBlur }:
  { id: string; label: string; hint?: ReactNode; value: string; onChange: (v: string) => void; testid: string; error?: string; prefix?: string; suffix?: string; inputMode?: 'decimal' | 'numeric' | 'text'; disabled?: boolean; placeholder?: string; onBlur?: () => void }) {
  const eid = id + '-e', hid = id + '-h';
  return (
    <div className="wl-field">
      <label htmlFor={id}>{label}</label>
      <div className={'wl-input' + (prefix ? ' has-pre' : '') + (suffix ? ' has-suf' + (suffix.length < 3 ? ' suf-s' : '') : '') + (error ? ' bad' : '')}>
        {prefix && <span className="wl-pre" aria-hidden="true">{prefix}</span>}
        <input id={id} data-testid={testid} type="text" inputMode={inputMode} autoComplete="off" spellCheck={false} value={value} placeholder={placeholder} disabled={disabled}
          onChange={(e) => onChange(e.target.value)} onBlur={onBlur} aria-invalid={error ? true : undefined} aria-describedby={[hint ? hid : '', error ? eid : ''].filter(Boolean).join(' ') || undefined} />
        {suffix && <span className="wl-suf" aria-hidden="true">{suffix}</span>}
      </div>
      {hint && <span className="wl-hint" id={hid}>{hint}</span>}
      {error && <span className="wl-err" id={eid} role="alert">{error}</span>}
    </div>
  );
}

export function Card({ id, title, intro, children, className }: { id: string; title: string; intro: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={'card wl-card' + (className ? ' ' + className : '')} aria-labelledby={id + '-h'}>
      <h2 id={id + '-h'} className="wl-h2">{title}</h2>
      <p className="ov-gl">{intro}</p>
      {children}
    </section>
  );
}

export const Need = ({ connected }: { connected: boolean }) => (connected ? null : <p className="wl-need" id="wl-need">Connect a wallet (top bar) to use this. Nothing is sent until you press the button.</p>);

