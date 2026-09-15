import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const host = JSON.parse(readFileSync(process.env.HOME + '/Library/Application Support/SimForge Studio/host.json', 'utf8'));
const H = { authorization: 'Bearer ' + host.controlToken };
const doc = 'uscn_2200019111fd4a10b71040fb';
const s = await (await fetch(host.baseUrl + '/api/simforge/host/session', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ next: `/dashboard/scenario?document=${doc}` }) })).json();
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 200)));
await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 120000 });
let saved = null;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(5000);
  const r = await fetch(`${host.baseUrl}/api/simforge/documents/${doc}/simulation-preview`, { headers: H });
  if (r.status === 200) { saved = await r.json(); break; }
  if (i % 6 === 5) console.log(`${(i + 1) * 5}s:`, (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 220));
}
console.log(saved ? JSON.stringify({ draftVersion: saved.draftVersion, sizeBytes: saved.sizeBytes }) : 'no preview after 300 s');
await page.screenshot({ path: '/tmp/sf-prod.png' });
await browser.close();
