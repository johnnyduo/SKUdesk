// Request entry: /api/* goes through the router, everything else falls through to static assets.
import type { AppEnv, Deps } from './env.ts';
import { HttpError, errorResponse, json, newRequestId } from './http.ts';
import { log } from './log.ts';
import type { LogFields } from './log.ts';
import { matchRoute } from './router.ts';
import { ROUTES } from './routes.ts';

export async function handleFetch(req: Request, env: AppEnv, exec: ExecutionContext, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
  const requestId = newRequestId();
  const started = deps.nowMs();
  const fields: LogFields = {};
  const m = matchRoute(ROUTES, req.method, url.pathname);
  let res: Response;
  try {
    if (m.kind === 'not_found') throw new HttpError(404, 'NOT_FOUND', 'no such route');
    if (m.kind === 'method_not_allowed') {
      res = json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed', requestId } }, requestId, 405, { allow: m.allow.join(', ') });
      fields.code = 'METHOD_NOT_ALLOWED';
    } else {
      res = await m.route.handler({ req, env, exec, url, requestId, params: m.params, deps, log: fields });
    }
  } catch (err) {
    res = errorResponse(err, requestId);
    if (err instanceof HttpError) fields.code = err.code;
    else fields.error = err instanceof Error ? err.name : 'unknown';
  }
  // Handler fields go FIRST so they can never overwrite the core request fields.
  log({ ...fields, requestId, method: req.method, route: m.kind === 'match' ? m.route.pattern : 'unmatched', status: res.status, durationMs: deps.nowMs() - started });
  return res;
}
