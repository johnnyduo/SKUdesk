// Story navigation end to end: the six-step menu, the Next button and the bottom strip walk the whole product in order, at desktop and phone width.
//   node scripts/e2e-journey.cjs http://127.0.0.1:4394
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:4394';
let failures = 0; const ok = (m) => console.log('  ok  ', m); const fail = (m) => { failures++; console.log('  FAIL', m); };
const expect = (c, m) => (c ? ok(m) : fail(m));
const LABELS = ['Desk', 'Agent trade', 'Agent market', 'Deploy agent', 'Limits', 'Proof'];
const PATHS = { show: '/show/', create: '/app/create/', market: '/market/', desk: '/app/', limits: '/app/agent/', proof: '/app/analytics/' };
(async () => {
  const b = await chromium.launch();
  for (const [tag, w, h] of [['desktop', 1280, 820], ['phone', 390, 844]]) {
    console.log(`\n[${tag}]`);
    const p = await b.newPage({ viewport: { width: w, height: h } }); const errs = [];
    p.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
    const here = async () => new URL(p.url()).pathname;
    const go = async (path) => { await p.goto(BASE + path, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(400); };

    await go(PATHS.create);
    if (tag === 'phone') await p.locator('.mnav summary').click();
    const nav = tag === 'phone' ? p.locator('.mnav-panel a') : p.locator('nav[aria-label="Primary"] a');
    const texts = (await nav.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    expect(texts.length === 6 && LABELS.every((l, i) => texts[i].includes(l) && texts[i].startsWith(String(i + 1))), 'menu has the six numbered steps in story order');
    expect((await nav.nth(3).getAttribute('aria-current')) === 'step' && (await nav.nth(0).getAttribute('aria-current')) === null, '"Deploy agent" is the one step marked current');
    if (tag === 'phone') await p.locator('.mnav summary').click();

    // walk the story with the Next controls
    await go(PATHS.desk);
    expect((await p.locator('.subtabs a').allInnerTexts()).join(',') === 'Overview,Opportunities,Lots,Transactions,Radar,Orders', 'the desk shows its six tabs');
    await p.getByTestId('journey-next').click(); await p.waitForURL('**/show/'); ok('desk -> bottom strip goes to Agent trade');
    await p.getByTestId(tag === 'phone' ? 'journey-next' : 'top-next').click(); await p.waitForURL('**/market/'); ok('/show -> Next goes to Agent market (top button on desktop, bottom strip on phone)');
    await p.getByLabel('Dismiss introduction').click({ timeout: 5000 }).catch(() => {});
    await p.getByTestId(tag === 'phone' ? 'market-next-foot' : 'market-next').click(); await p.waitForURL('**/app/create/'); ok('step 3 Next (the market footer link) goes to Deploy agent');
    await p.getByTestId(tag === 'phone' ? 'journey-next' : 'top-next').click(); await p.waitForURL('**/app/agent/'); ok('Deploy agent -> Limits');
    expect(await p.locator('.subtabs a').allInnerTexts().then((t) => t.join(',') === 'Agent,Mandate,Owner console'), 'Limits has Agent, Mandate, Owner console');
    await p.getByTestId('journey-next').click(); await p.waitForURL('**/app/analytics/'); ok('Limits -> Proof');
    expect(await p.getByTestId('top-next').count() === 0, 'the last step has no Next button in the top bar');
    await p.locator('.journey-a.next').click(); await p.waitForURL('**/app/'); ok('the end loops back to the Desk');

    // /app is the front page of the story: all six steps as cards, step 2 (Agent trade) is the primary button
    await go(PATHS.desk);
    const hub = await p.getByTestId('start-here').locator('.hub-steps li a').allInnerTexts();
    expect(hub.length === 6 && LABELS.every((l, i) => hub[i].includes(l)), '/app shows the six story steps as cards, in order');
    expect((await p.getByTestId('start-here').locator('a[aria-current="step"]').count()) === 1, 'the desk card is marked "You are here"');
    await p.getByTestId('hub-start').click(); await p.waitForURL('**/show/'); ok('the primary button goes to the next step, Agent trade');

    // deep pages keep their step
    await go('/app/lots/1/'); expect((await p.getByTestId('journey-next').innerText()).includes('Agent trade'), '/app/lots/1 stays inside step 1, the Desk (its Next is step 2)');
    await go('/app/owner/'); expect((await p.getByTestId('journey-next').innerText()).includes('Proof'), '/app/owner (step 5) points to Proof');
    for (const path of Object.values(PATHS).filter((x) => x.startsWith('/app'))) { await go(path); const ov = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); expect(!ov, `no horizontal overflow on ${path}`); }
    expect(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await p.close();
  }
  await b.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\njourney e2e: all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('crashed', e.message); process.exit(1); });
