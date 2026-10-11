// Phase 3a browser test: clickable links, background-tab badges, scrollback search.
//   BASE=http://127.0.0.1:7683/ CONTAINER=ttyd-p3-test node test/e2e-p3.mjs
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:7683/';
const CT = process.env.CONTAINER || 'ttyd-p3-test';
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  -> ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => { try { return execSync(`docker exec ${CT} sh -c '${cmd}'`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return ''; } };
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };

sh('tmux -L ttyd kill-server 2>/dev/null');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const errors = [];
await ctx.route('https://links.test/**', (r) => r.fulfill({ body: 'ok', contentType: 'text/plain' }));
const p = await ctx.newPage();
p.on('pageerror', (e) => errors.push(String(e)));
p.on('dialog', (d) => d.accept());
const screen = (i = null) => p.evaluate((i) => {
  const t = i === null ? window.tabs.active : window.tabs.tabs[i];
  const b = t.session.term.buffer.active; let s = '';
  for (let y = 0; y < b.length; y++) s += (b.getLine(y)?.translateToString(true) ?? '') + '\n';
  return s;
}, i);
const allConnected = (n) => p.evaluate((n) => window.tabs.tabs.length === n && window.tabs.tabs.every((t) => t.session.state === 'connected'), n);
const type = async (s) => { await p.keyboard.type(s); await p.keyboard.press('Enter'); };
const badges = () => p.evaluate(() => window.tabs.tabs.map((t) => t.el.dataset.badge || ''));

await p.goto(BASE);
check('setup: tab connects', await waitFor(() => allConnected(1)));
await sleep(500);

// ---------- A. links ----------
await type('clear; echo "see https://links.test/page?x=1 and javascript:alert(1) done"');
await waitFor(async () => /links\.test/.test(await screen()));
// locate the link on screen: cell size = .xterm-screen box / (cols, rows)
const pos = await p.evaluate(() => {
  const t = window.tabs.active.session.term, b = t.buffer.active;
  for (let y = 0; y < t.rows; y++) {
    const line = b.getLine(b.viewportY + y)?.translateToString(true) ?? '';
    const x = line.indexOf('https://links.test');
    if (x >= 0 && !line.startsWith('$') && !/echo/.test(line)) {
      const r = document.querySelector('.pane.active .xterm-screen').getBoundingClientRect();
      return { x: r.left + (x + 6) * (r.width / t.cols), y: r.top + (y + 0.5) * (r.height / t.rows) };
    }
  }
  return null;
});
check('A link found on screen', !!pos);
await p.mouse.move(pos.x, pos.y);
check('A hovering a link shows the pointer cursor', await waitFor(() => p.evaluate(() => !!document.querySelector('.pane.active .xterm-cursor-pointer'))));
const popupP = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null);
await p.mouse.down(); await p.mouse.up();
const popup = await popupP;
check('A click opens the URL in a new tab', popup && popup.url() === 'https://links.test/page?x=1', popup && popup.url());
check('A opened tab has no opener (noopener)', popup && await popup.evaluate(() => window.opener === null));
if (popup) await popup.close();
check('A javascript: text is not a link (no extra page)', ctx.pages().length === 1);

// ---------- B. badges ----------
await p.keyboard.press('Alt+t');
check('B second tab', await waitFor(() => allConnected(2)));
await sleep(2000);
check('B no badge on the active tab or after attach repaint', (await badges()).join() === ',');
await p.keyboard.press('Alt+1'); await sleep(300);
await type('sleep 2; echo ACT_DONE');
await p.keyboard.press('Alt+2');
check('B background output sets the activity badge', await waitFor(async () => (await badges())[0] === 'activity', 6000), (await badges()).join());
await p.keyboard.press('Alt+1');
check('B activating the tab clears the badge', (await badges())[0] === '');
await sleep(500);
await type('sleep 2; printf "\\a"; echo BELL_DONE');
await p.keyboard.press('Alt+2');
check('B bell sets the bell badge (outranks activity)', await waitFor(async () => (await badges())[0] === 'bell', 6000), (await badges()).join());
await sleep(500);
check('B bell badge sticks after more output', (await badges())[0] === 'bell');
await p.keyboard.press('Alt+1'); await sleep(300);
check('B bell cleared on activate', (await badges())[0] === '');
await type('printf "\\a"; echo SELF');
await sleep(500);
check('B bell in the ACTIVE tab does not badge', (await badges()).join() === ',');
// reload: the repaint on reattach must not look like activity
await type('sleep 1; echo X');
await p.reload();
check('B reload reconnects', await waitFor(() => allConnected(2)));
await sleep(2500);
const bs = (await badges()).join();
check('B no badges right after reload (repaint is not activity)', bs === ',', bs);

// ---------- C. scrollback search ----------
await p.keyboard.press('Alt+1'); await sleep(300);
await type('clear; for i in $(seq 1 200); do echo "LINE_$i needle$((i%7)) Mixed"; done; echo "<img src=x onerror=window.__xss=1>"');
await waitFor(async () => /<img src=x/.test(await screen()));
await sleep(1200);   // let tmux finish repainting
const topLine = await p.evaluate(() => { const t = window.tabs.active.session.term, b = t.buffer.active; return b.getLine(b.viewportY)?.translateToString(true); });
check('C early lines have scrolled out of the visible screen', !/LINE_1 /.test(topLine), topLine);
await p.keyboard.press('Control+Shift+F');
check('C Ctrl+Shift+F opens the panel with input focused', await waitFor(() => p.evaluate(() => !document.getElementById('search-panel').hidden && document.activeElement === document.querySelector('#search-panel input'))));
await p.keyboard.type('line_5 ');
const res = () => p.evaluate(() => ({ info: document.querySelector('.ss-info').textContent, rows: [...document.querySelectorAll('.ss-row')].map((r) => r.textContent) }));
check('C finds a line that is only in tmux history (case-insensitive)', await waitFor(async () => { const r = await res(); return r.rows.length === 1 && r.rows[0].includes('LINE_5 needle5 Mixed'); }), JSON.stringify((await res()).info));
const r1 = await res();
check('C result is exactly the one matching line, with its line number', r1.rows.length === 1 && r1.rows[0] === '5LINE_5 needle5 Mixed', JSON.stringify(r1.rows));
check('C typed text did not reach the terminal', !/line_5/.test(await screen()));
await p.fill('#search-panel input', 'needle3');
await waitFor(async () => /^29 matches/.test((await res()).info));
const r3 = await res();
check('C count and newest-first order', /^29 matches/.test(r3.info) && /LINE_199 /.test(r3.rows[0]), r3.info + ' | ' + r3.rows[0]);
await p.fill('#search-panel input', 'needle');
await waitFor(async () => /^200 matches/.test((await res()).info));
const rc = await res();
check('C all 200 matches listed (under the cap)', /^200 matches$/.test(rc.info) && rc.rows.length === 200, rc.info + ' rows=' + rc.rows.length);
await p.keyboard.press('Escape');
await type('for i in $(seq 1 400); do echo "dupline $i"; done');
await waitFor(async () => /dupline 400/.test(await screen()));
await p.keyboard.press('Control+Shift+F');
await p.fill('#search-panel input', 'dupline');
await waitFor(async () => /^401 matches/.test((await res()).info));
const rcap = await res();
check('C result cap: counts all 401 (400 lines + the command), renders the newest 300', /^401 matches \(showing the newest 300\)$/.test(rcap.info) && rcap.rows.length === 300 && rcap.rows[0].includes('dupline 400'), rcap.info + ' rows=' + rcap.rows.length);
await p.fill('#search-panel input', 'zzzz_nothing');
check('C no match message', await waitFor(async () => (await res()).info === 'No matches.'));
await p.fill('#search-panel input', 'img src');
await waitFor(async () => /1 match/.test((await res()).info));
check('C history text is shown as text, never as HTML (no XSS)', (await res()).rows[0].includes('<img src=x onerror=window.__xss=1>') && !(await p.evaluate(() => window.__xss)) && (await p.evaluate(() => document.querySelectorAll('.ss-results img').length)) === 0);
await p.keyboard.press('Escape');
check('C Escape closes the panel and refocuses the terminal', await waitFor(() => p.evaluate(() => document.getElementById('search-panel').hidden && document.activeElement === document.querySelector('.pane.active .xterm-helper-textarea'))));
await type('echo AFTER_SEARCH_OK');
check('C terminal still works after search', await waitFor(async () => /^AFTER_SEARCH_OK$/m.test(await screen())));
// search is per tab: tab 2 does not contain tab 1's history
await p.keyboard.press('Alt+2'); await sleep(300);
await p.click('#search');
await p.fill('#search-panel input', 'needle3');
check('C search covers only the active tab', await waitFor(async () => (await res()).info === 'No matches.'));
await p.keyboard.press('Escape');
// refresh picks up new output
await p.keyboard.press('Alt+1'); await sleep(300);
await type('echo FRESH_MARK_77');
await p.keyboard.press('Control+Shift+F');
await p.fill('#search-panel input', 'fresh_mark_77');
check('C panel loads a fresh snapshot each time it opens', await waitFor(async () => (await res()).rows.some((r) => r.includes('FRESH_MARK_77'))));
await p.keyboard.press('Escape');

// ---------- D. capture through the real websocket path: whitelist ----------
const bad = await p.evaluate(async () => { try { await captureSession('t0123456;id'); return 'resolved'; } catch (e) { return 'rejected'; } });
check('D capture with an invalid id is rejected by the wrapper', bad === 'rejected');
const empty = await p.evaluate(async () => (await captureSession('t0000000000')).join('').trim());
check('D capture of a nonexistent session returns nothing', empty === '', JSON.stringify(empty));
check('D no stray tmux sessions were created by capture', !sh('tmux -L ttyd ls -F "#{session_name}"').includes('t0000000000'));

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
