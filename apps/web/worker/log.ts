// One structured JSON line per event. Never logs secrets, tokens or request/response bodies.
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;

const SENSITIVE_KEY = /(token|secret|password|authorization|api[_-]?key|private|sa_json|assertion|cookie)/i;
const SENSITIVE_VALUE = /^(bearer\s|basic\s|ya29\.|eyJ|-----BEGIN)/i;
const MAX_VALUE = 200;

export function logLine(fields: LogFields, nowMs: number = Date.now()): string {
  const out: Record<string, string | number | boolean | null> = { ts: new Date(nowMs).toISOString() };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (SENSITIVE_KEY.test(key)) { out[key] = '[redacted]'; continue; }
    if (typeof value === 'string') {
      if (SENSITIVE_VALUE.test(value)) { out[key] = '[redacted]'; continue; }
      out[key] = value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) + '...' : value;
      continue;
    }
    out[key] = value;
  }
  return JSON.stringify(out);
}

export function log(fields: LogFields): void {
  console.log(logLine(fields));
}
