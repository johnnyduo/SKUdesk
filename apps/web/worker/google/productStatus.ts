// Processed product (products.get, v1) -> our listing status. Pure.
// Fields: productStatus.destinationStatuses[{reportingContext, approvedCountries, pendingCountries, disapprovedCountries}],
//         productStatus.itemLevelIssues[{code, severity, attribute, description, detail, applicableCountries}].
import type { Issue } from '../api-types.ts';

export type DerivedStatus = { status: 'PROCESSING' | 'APPROVED' | 'DISAPPROVED'; issues: Issue[] };

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// APPROVED if any destination approves the country (issues still listed); else DISAPPROVED if any destination
// disapproves it or a DISAPPROVED-severity issue applies; otherwise PROCESSING.
export function deriveStatus(product: unknown, country: string): DerivedStatus {
  const ps = (product as { productStatus?: Record<string, unknown> } | null)?.productStatus ?? {};
  const dests = Array.isArray(ps.destinationStatuses) ? (ps.destinationStatuses as Record<string, unknown>[]) : [];
  const rawIssues = Array.isArray(ps.itemLevelIssues) ? (ps.itemLevelIssues as Record<string, unknown>[]) : [];
  const issues: Issue[] = rawIssues
    .filter((i) => { const c = strs(i.applicableCountries); return c.length === 0 || c.includes(country); })
    .map((i) => ({ code: str(i.code) ?? 'unknown', severity: str(i.severity) ?? 'UNKNOWN', attribute: str(i.attribute), description: (str(i.description) ?? '').slice(0, 300), detail: str(i.detail)?.slice(0, 300) ?? null }));
  if (dests.some((d) => strs(d.approvedCountries).includes(country))) return { status: 'APPROVED', issues };
  if (dests.some((d) => strs(d.disapprovedCountries).includes(country)) || issues.some((i) => i.severity === 'DISAPPROVED')) {
    return { status: 'DISAPPROVED', issues };
  }
  return { status: 'PROCESSING', issues };
}
