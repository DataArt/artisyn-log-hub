import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [svg, png] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1480, height: 1000 } });
await p.setContent(`<html><body style="margin:0">${readFileSync(svg, 'utf8')}</body></html>`);
await p.screenshot({ path: png });
await b.close();
