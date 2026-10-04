// Honest status labels for live-backend panels. Pure; shared by the React islands.
export type PillClass = 'ok' | 'warn' | 'bad' | 'blue' | 'good';
export type Pill = { cls: PillClass; text: string };

export function modePill(mode: string): Pill {
  switch (mode) {
    case 'REAL': return { cls: 'ok', text: 'REAL' };
    case 'MOCK': return { cls: 'warn', text: 'TEST DATA' }; // offers the Worker generated instead of fetching
    case 'NOT_CONNECTED': return { cls: 'warn', text: 'NOT CONNECTED' }; // client-side row state: no API key yet
    case 'DRY_RUN': return { cls: 'blue', text: 'DRY RUN · nothing sent' };
    case 'DEGRADED': return { cls: 'warn', text: 'DEGRADED' };
    case 'OFFLINE': return { cls: 'bad', text: 'API NOT CONNECTED' };
    default: return { cls: 'warn', text: mode };
  }
}

export function listingPill(status: string): Pill {
  if (status === 'APPROVED') return { cls: 'ok', text: 'APPROVED' };
  if (status === 'DISAPPROVED' || status === 'ERROR') return { cls: 'bad', text: status };
  if (status === 'DELETED') return { cls: 'warn', text: 'DELETED' };
  return { cls: 'blue', text: status };
}

export function fmtCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isSafeInteger(cents)) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return sign + '$' + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}

export function fmtBpsPct(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
  return (bps / 100).toFixed(2) + '%';
}

const FLAG_TEXT: Record<string, string> = {
  single_source: 'fewer than 2 sources priced it',
  gtin_unavailable: 'no GTIN: matched by title gates',
  stale_cache: 'some prices are cached (stale)',
  quota_exhausted: 'a source hit its daily budget',
  no_canonical: 'not a catalog SKU: exact GTIN matches only',
  all_mock: 'all prices are test data (no source has an API key yet)',
  no_locked_offers: 'no offer passed the identity gates',
};
export function flagText(flag: string): string {
  return FLAG_TEXT[flag] ?? flag;
}
