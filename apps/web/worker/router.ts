// Minimal path router for /api/*. Patterns use `:name` segments; trailing slashes are ignored.
import type { AppEnv, Deps } from './env.ts';
import type { LogFields } from './log.ts';

export type Ctx = {
  req: Request;
  env: AppEnv;
  exec: ExecutionContext;
  url: URL;
  requestId: string;
  params: Record<string, string>;
  deps: Deps;
  log: LogFields;
};
export type Handler = (c: Ctx) => Promise<Response>;
export type Route = { method: 'GET' | 'POST' | 'DELETE'; pattern: string; handler: Handler };
export type RouteMatch =
  | { kind: 'match'; route: Route; params: Record<string, string> }
  | { kind: 'method_not_allowed'; allow: string[] }
  | { kind: 'not_found' };

export function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = (pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname).split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) {
      if (!got[i]) return null;
      try { params[want[i].slice(1)] = decodeURIComponent(got[i]); } catch { return null; }
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return params;
}

export function matchRoute(routes: Route[], method: string, pathname: string): RouteMatch {
  const allow: string[] = [];
  for (const route of routes) {
    const params = matchPattern(route.pattern, pathname);
    if (!params) continue;
    if (route.method === method) return { kind: 'match', route, params };
    allow.push(route.method);
  }
  return allow.length ? { kind: 'method_not_allowed', allow } : { kind: 'not_found' };
}
