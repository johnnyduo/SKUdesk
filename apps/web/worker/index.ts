// Worker entry. Static assets are served directly by Cloudflare; only /api/* runs this code first.
import { handleFetch } from './app.ts';
import { handleScheduled } from './cron.ts';
import { defaultDeps } from './env.ts';
import type { AppEnv } from './env.ts';

export default {
  fetch(req, env, ctx) {
    return handleFetch(req, env, ctx, defaultDeps());
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(handleScheduled(controller, env, defaultDeps()));
  },
} satisfies ExportedHandler<AppEnv>;
