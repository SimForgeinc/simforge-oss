import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.SHOWCASE_URL ?? 'http://127.0.0.1:4317';
const out = resolve(process.argv[2] ?? '../../../../research/edge-case-corpus/reports/rethink/showcase/p4-screens');
await mkdir(out,{recursive:true});
const browser = await chromium.launch({ executablePath:'/usr/bin/google-chrome', headless:true, args:['--no-sandbox'] });
const page = await browser.newPage({ viewport:{width:1440,height:1000}, deviceScaleFactor:1 });
await page.goto(`${base}/#/`,{waitUntil:'networkidle'}); await page.screenshot({path:resolve(out,'gallery.png'),fullPage:true});
await page.goto(`${base}/#/jobs/mock-night-crossing`,{waitUntil:'networkidle'}); await page.locator('.stage').nth(3).evaluate((node) => { node.open=true; }); await page.screenshot({path:resolve(out,'job-detail.png'),fullPage:true});
await page.goto(`${base}/#/submit`,{waitUntil:'networkidle'}); await page.locator('textarea').fill('A school bus stops abruptly as a cyclist emerges into the adjacent lane.'); await page.screenshot({path:resolve(out,'submit.png'),fullPage:true});
await page.getByRole('button',{name:/Start pipeline/}).click();
await page.waitForURL(/#\/jobs\/mock-/);
await page.locator('.job-heading').waitFor();
await browser.close();
console.log(`screenshots written to ${out}`);
