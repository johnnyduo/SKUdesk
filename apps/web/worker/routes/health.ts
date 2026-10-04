import type { HealthResponse } from '../api-types.ts';
import { json } from '../http.ts';
import type { Ctx } from '../router.ts';

export async function health(c: Ctx): Promise<Response> {
  const out: HealthResponse = { ok: true, service: 'robinize-api', apiVersion: 1, time: new Date(c.deps.nowMs()).toISOString(), requestId: c.requestId };
  return json(out, c.requestId);
}
