// Phase 5 UI test: theme presets (+ themed scrollbar), pane close button beside the scrollbar, double-click on the
// empty tab bar opens a tab.   BASE=... SHOT_DIR=... node test/e2e-p5.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE || 'http://127.0.0.1:7683/';
const SHOT = process.env.SHOT_DIR || '/tmp';
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  -> ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const page = await ctx.newPage();
const errors = [];
page.on('dialog', (d) => d.accept());   // "Close this pane?" confirm
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(BASE);
await waitFor(() => page.evaluate(() => window.tabs && window.tabs.tabs.length === 1 && window.tabs.active.session.state === 'connected'));

const css = (v) => page.evaluate((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim(), v);
const termBgs = () => page.evaluate(() => window.tabs.tabs.flatMap((t) => t.panes.map((p) => p.session.term.options.theme.background)));
const pick = async (name) => {
  await page.keyboard.press('Alt+p');
  await page.keyboard.type('Theme: ' + name);
  await page.keyboard.press('Enter');
  await sleep(200);
};

// ---- themes
check('default theme is Dracula', (await css('--term-bg')) === '#282a36' && (await page.evaluate(() => document.documentElement.style.colorScheme)) === 'dark');
await page.keyboard.press('Alt+p');
const names = await page.evaluate(() => [...document.querySelectorAll('.pl-name')].map((e) => e.textContent).filter((t) => t.startsWith('Theme: ')));
await page.keyboard.press('Escape');
check('palette lists 8 themes', names.length === 8, names.join(', '));

await pick('Nord');
check('Nord: page variables switch', (await css('--bar')) === '#242933' && (await css('--term-bg')) === '#2e3440');
check('Nord: terminal colours switch', (await termBgs()).every((b) => b === '#2e3440'));
check('Nord: theme-color meta follows', await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content) === '#242933');
check('Nord: saved in localStorage', await page.evaluate(() => localStorage.getItem('ttyd-ui.theme.v1')) === 'nord');
const sb = await page.evaluate(() => getComputedStyle(document.querySelector('.xterm-viewport')).scrollbarColor);
check('scrollbar colour comes from the theme (not the default light one)', /67, 76, 94/.test(sb), sb);   // #434c5e = hover
check('terminal pixels use the new background', await page.evaluate(() => getComputedStyle(document.getElementById('panes')).backgroundColor) === 'rgb(46, 52, 64)');

await pick('Solarized Light');
check('light theme: color-scheme light', (await page.evaluate(() => document.documentElement.style.colorScheme)) === 'light');
await page.screenshot({ path: SHOT + '/theme-light.png' });
await pick('Tokyo Night');
await page.screenshot({ path: SHOT + '/theme-tokyo.png' });

await page.reload();
await waitFor(() => page.evaluate(() => window.tabs && window.tabs.active && window.tabs.active.session.state === 'connected'));
check('theme persists after reload', (await css('--term-bg')) === '#1a1b26' && (await termBgs()).every((b) => b === '#1a1b26'));
await pick('Dracula');
check('back to Dracula', (await css('--term-bg')) === '#282a36');

await page.evaluate(() => localStorage.setItem('ttyd-ui.theme.v1', '<script>bogus'));
await page.reload();
await waitFor(() => page.evaluate(() => window.tabs && window.tabs.active));
check('unknown saved theme falls back to Dracula', (await css('--term-bg')) === '#282a36');
await waitFor(() => page.evaluate(() => window.tabs.active.session.state === 'connected'));

// ---- double-click on the empty tab bar
const count = () => page.evaluate(() => window.tabs.tabs.length);
const box = await page.evaluate(() => { const r = document.getElementById('tabs').getBoundingClientRect(); return { x: r.right - 30, y: r.top + r.height / 2 }; });
const before = await count();
await page.mouse.dblclick(box.x, box.y);
check('double-click on the empty bar opens a tab', await waitFor(async () => (await count()) === before + 1));
const tb = await page.evaluate(() => { const r = document.querySelector('.tab .title').getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 }; });
const n2 = await count();
await page.mouse.dblclick(tb.x, tb.y);
await sleep(400);
check('double-click on a tab renames it, no new tab', (await count()) === n2 && (await page.$('input.rename')) !== null);
await page.keyboard.press('Escape');
const btn = await page.evaluate(() => { const r = document.getElementById('sessions').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.dblclick(btn.x, btn.y);
check('double-click on a bar button opens no tab', (await count()) === n2);
await page.keyboard.press('Escape');

// ---- pane close button next to the scrollbar
await page.evaluate(() => window.tabs.activate(window.tabs.tabs[0].id));
await page.keyboard.press('Alt+Backslash');
await waitFor(() => page.evaluate(() => window.tabs.active.panes.length === 2));
await sleep(800);
const geo = await page.evaluate(() => window.tabs.active.panes.map((p) => {
  const v = p.leafEl.querySelector('.xterm-viewport').getBoundingClientRect();
  const x = p.leafEl.querySelector('.pclose').getBoundingClientRect();
  const l = p.leafEl.getBoundingClientRect();
  return { vRight: v.right, xLeft: x.left, xRight: x.right, lRight: l.right, top: x.top - l.top };
}));
check('close button is to the right of the scrollbar (no overlap)', geo.length === 2 && geo.every((g) => g.xLeft >= g.vRight - 0.5), JSON.stringify(geo));
check('close button stays inside its pane', geo.every((g) => g.xRight <= g.lRight + 0.5));
await page.screenshot({ path: SHOT + '/split-close.png' });
await page.click('.pane.active .pclose >> nth=0');
await waitFor(() => page.evaluate(() => window.tabs.active.panes.length === 1));
await sleep(300);
const pad = await page.evaluate(() => getComputedStyle(window.tabs.active.panes[0].leafEl).paddingRight);
check('single pane: no gutter', pad === '0px', pad);

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
