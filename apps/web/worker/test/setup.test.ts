import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDataSourceRequest, dataSourceIdOf, findPrimaryApiDataSource, getRegistrationRequest, listDataSourcesRequest, registerGcpRequest } from '../google/setup.ts';

const fx = (name: string) => JSON.parse(readFileSync(new URL('./fixtures/merchant/' + name, import.meta.url), 'utf8'));
const TARGET = { language: 'en', feedLabel: 'US', countries: ['US'] };

test('registerGcpRequest: v1 path and body; refuses service-account emails', () => {
  assert.deepEqual(registerGcpRequest('123', 'dev@example.com'), { method: 'POST', path: '/accounts/v1/accounts/123/developerRegistration:registerGcp', body: { developerEmail: 'dev@example.com' } });
  assert.throws(() => registerGcpRequest('123', 'robot@proj.iam.gserviceaccount.com'), /service account/);
  assert.throws(() => registerGcpRequest('123', 'not-an-email'), /email/);
  assert.deepEqual(getRegistrationRequest('123'), { method: 'GET', path: '/accounts/v1/accounts/123/developerRegistration' });
});

test('data source requests: list with paging, create a primary source for en/US/US', () => {
  assert.deepEqual(listDataSourcesRequest('123'), { method: 'GET', path: '/datasources/v1/accounts/123/dataSources', query: { pageSize: '1000' } });
  assert.equal(listDataSourcesRequest('123', 'tok').query?.pageToken, 'tok');
  assert.deepEqual(createDataSourceRequest('123', TARGET).body, { displayName: 'Robinize API', primaryProductDataSource: { contentLanguage: 'en', feedLabel: 'US', countries: ['US'] } });
});

test('findPrimaryApiDataSource skips FILE sources and other locales', () => {
  assert.deepEqual(findPrimaryApiDataSource(fx('datasources-list.json'), TARGET), { name: 'accounts/123/dataSources/456', dataSourceId: '456' });
  assert.equal(findPrimaryApiDataSource(fx('datasources-list.json'), { ...TARGET, feedLabel: 'GB' }), null);
  assert.equal(findPrimaryApiDataSource({}, TARGET), null);
  assert.equal(dataSourceIdOf(fx('datasource-created.json')), '789');
  assert.equal(dataSourceIdOf({ name: 'accounts/1/dataSources/42' }), '42');
});

test('merchant-setup --plan prints the requests without network or key material', () => {
  const script = fileURLToPath(new URL('../scripts/merchant-setup.ts', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--account', '123', '--developer-email', 'dev@example.com', '--plan'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /POST https:\/\/merchantapi\.googleapis\.com\/accounts\/v1\/accounts\/123\/developerRegistration:registerGcp/);
  assert.match(r.stdout, /POST https:\/\/merchantapi\.googleapis\.com\/datasources\/v1\/accounts\/123\/dataSources /);
  assert.ok(!/PRIVATE KEY/.test(r.stdout));
  const bad = spawnSync(process.execPath, [script, '--account', '12a', '--plan'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
});
