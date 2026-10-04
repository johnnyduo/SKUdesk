import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Black-box test of the secrets guard in worker/scripts/smoke.mjs. It runs the script in an empty temp dir that
// contains only EMPTY files with the names under test (no dist/), so the script exits 2 either way:
// with the "real secrets" message when the guard trips, or with "dist/ is missing" when the guard lets it through.
const SCRIPT = resolve(import.meta.dirname, '..', 'scripts', 'smoke.mjs');

function run(names: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-guard-'));
  try {
    for (const n of names) writeFileSync(join(dir, n), '');
    const res = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', timeout: 20_000, env: { ...process.env, SMOKE_ALLOW_DEV_VARS: '', ...env } });
    return { status: res.status, err: res.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const name of ['.dev.vars.example', '.env.example']) {
  test(`smoke guard allows the template ${name}`, () => {
    const r = run([name]);
    assert.equal(r.status, 2);
    assert.match(r.err, /dist\/ is missing/);
    assert.doesNotMatch(r.err, /real secrets/);
  });
}

test('smoke guard allows both templates together', () => {
  assert.match(run(['.dev.vars.example', '.env.example']).err, /dist\/ is missing/);
});

for (const name of ['.dev.vars', '.dev.vars.production', '.env', '.env.local']) {
  test(`smoke guard refuses ${name}`, () => {
    const r = run([name]);
    assert.equal(r.status, 2);
    assert.match(r.err, /real secrets/);
    assert.ok(r.err.includes(name));
  });
}

test('smoke guard still refuses a real file next to a template', () => {
  assert.match(run(['.dev.vars.example', '.dev.vars']).err, /real secrets/);
});

test('SMOKE_ALLOW_DEV_VARS=1 overrides the guard', () => {
  const r = run(['.dev.vars'], { SMOKE_ALLOW_DEV_VARS: '1' });
  assert.match(r.err, /dist\/ is missing/);
});
