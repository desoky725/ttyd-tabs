import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const BASE = process.env.URL || 'http://127.0.0.1:7682/';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  -> ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const reqs = [];
page.on('request', (r) => reqs.push(r.url()));
let dialogs = [];
page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });

// text of the active terminal buffer
const screen = (i = null) => page.evaluate((i) => {
  const t = i === null ? window.tabs.active : window.tabs.tabs[i];
  const b = t.session.term.buffer.active; let s = '';
  for (let y = 0; y < b.length; y++) s += (b.getLine(y)?.translateToString(true) ?? '') + '\n';
  return s;
}, i);
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };
const type = async (s) => { await page.keyboard.type(s); await page.keyboard.press('Enter'); };

await page.goto(BASE);
check('tab 1 connects', await waitFor(() => page.evaluate(() => window.tabs.tabs[0]?.session.state === 'connected')));
check('no external requests', reqs.every((u) => u.startsWith(BASE.replace(/\/$/, '')) || u.startsWith('data:')), reqs.filter((u) => !u.startsWith(BASE)).join(','));
await sleep(500);

// --- independent sessions ---
await type('echo PID1=$$');
check('tab1 shell responds', await waitFor(async () => /PID1=\d+/.test(await screen(0))));
await page.keyboard.press('Alt+t');
check('Alt+T opens 2nd tab', await waitFor(() => page.evaluate(() => window.tabs.tabs.length === 2 && window.tabs.activeId === window.tabs.tabs[1].id)));
check('tab2 connects', await waitFor(() => page.evaluate(() => window.tabs.tabs[1].session.state === 'connected')));
await sleep(500);
await type('echo PID2=$$');
check('tab2 shell responds', await waitFor(async () => /PID2=\d+/.test(await screen(1))));
const s1 = await screen(0), s2 = await screen(1);
const p1 = s1.match(/PID1=(\d+)/)?.[1], p2 = s2.match(/PID2=(\d+)/)?.[1];
check('independent processes', p1 && p2 && p1 !== p2, `${p1} vs ${p2}`);
check('tab2 does not contain tab1 output', !/PID1=/.test(s2.replace(/echo PID1=\$\$/g, '')) );

// --- switching ---
await page.keyboard.press('Alt+1');
check('Alt+1 -> tab 1', await page.evaluate(() => window.tabs.activeId === window.tabs.tabs[0].id));
await page.keyboard.press('Alt+ArrowRight');
check('Alt+Right -> tab 2', await page.evaluate(() => window.tabs.activeId === window.tabs.tabs[1].id));
await page.keyboard.press('Alt+ArrowLeft');
check('Alt+Left -> tab 1', await page.evaluate(() => window.tabs.activeId === window.tabs.tabs[0].id));
check('Alt keys did not reach shell', !/\[1;3/.test(await screen(0)) && !(await screen(0)).includes('\x1b'));

// --- background output keeps flowing; flow control survives heavy output ---
await page.keyboard.press('Alt+2');
await type('seq 1 200000 | tail -n 3; echo FLOWDONE');
check('heavy output + flow control completes', await waitFor(async () => /FLOWDONE\n/.test((await screen(1)).replace('echo FLOWDONE', '')), 20000));

// --- title: follows server until renamed ---
await type('printf "\\033]0;srv-title\\007"');
check('title follows terminal title', await waitFor(() => page.evaluate(() => /root@/.test(window.tabs.tabs[1].title) && window.tabs.tabs[1].title !== 'Terminal 2')));
await page.dblclick('.tab:nth-child(2) .title');
await page.keyboard.type('mytab'); await page.keyboard.press('Enter');
check('double-click rename', await page.evaluate(() => window.tabs.tabs[1].title === 'mytab' && window.tabs.tabs[1].userRenamed));
await type('printf "\\033]0;other\\007"'); await sleep(500);
check('renamed tab ignores server title', await page.evaluate(() => window.tabs.tabs[1].title === 'mytab'));

// --- fit / resize ---
await type('stty size');
await sleep(500);
const sz1 = (await screen(1)).match(/^(\d+) (\d+)$/m);
const dims1 = await page.evaluate(() => [window.tabs.tabs[1].session.term.rows, window.tabs.tabs[1].session.term.cols]);
check('server pty size == terminal size', sz1 && +sz1[1] === dims1[0] && +sz1[2] === dims1[1], `${sz1?.[0]} vs ${dims1}`);
await page.setViewportSize({ width: 700, height: 500 });
await sleep(700);
await type('stty size'); await sleep(500);
const all = [...(await screen(1)).matchAll(/^(\d+) (\d+)$/gm)]; const last = all[all.length - 1];
const dims2 = await page.evaluate(() => [window.tabs.tabs[1].session.term.rows, window.tabs.tabs[1].session.term.cols]);
check('window resize refits + notifies server', last && +last[1] === dims2[0] && +last[2] === dims2[1] && dims2[1] < dims1[1], `${last?.[0]} vs ${dims2} (was ${dims1})`);
// hidden tab refits too, and activating a tab fits it
await page.keyboard.press('Alt+1'); await sleep(300);
const d1 = await page.evaluate(() => [window.tabs.tabs[0].session.term.rows, window.tabs.tabs[0].session.term.cols]);
await type('stty size'); await sleep(500);
const a1 = [...(await screen(0)).matchAll(/^(\d+) (\d+)$/gm)]; const l1 = a1[a1.length - 1];
const d1b = await page.evaluate(() => [window.tabs.tabs[0].session.term.rows, window.tabs.tabs[0].session.term.cols]);
check('tab1 refitted when shown; server size matches', l1 && +l1[2] === d1b[1] && Math.abs(d1b[1] - dims2[1]) <= 6 && d1b[0] === dims2[0], `${l1?.[0]} vs ${d1b} (other tab ${dims2})`);
await page.setViewportSize({ width: 1000, height: 700 }); await sleep(500);

// --- paste: multi-line via right-click (clipboard API) into a raw `cat -A` (no bracketed paste requested) ---
await page.keyboard.press('Alt+2');
await type('cat -A');
await sleep(300);
await page.evaluate(() => navigator.clipboard.writeText('line one\nline two\nline three'));
await page.click('.pane.active .xterm-screen', { button: 'right' });
await sleep(500);
await page.keyboard.press('Control+d');
await sleep(300);
const pasted = await screen(1);
const tail = pasted.slice(pasted.lastIndexOf('cat -A'));
check('right-click paste: lines arrive', /line one\$\s*\nline two\$\s*\nline three/.test(tail), JSON.stringify(tail.slice(0, 160)));
check('right-click paste: no ^[[200~ markers', !/\^\[\[20[01]~/.test(tail));
check('right-click paste: no doubled newlines', !/line one\$\s*\n\s*\n/.test(tail) && !/\^M/.test(tail.replace(/\^M\$/g, '')));

// --- paste into bash prompt (bracketed paste ON): readline consumes the markers ---
await page.evaluate(() => navigator.clipboard.writeText('echo AAA\necho BBB'));
await page.keyboard.press('Control+Shift+V');
await sleep(600);
const sc = await screen(1);
check('Ctrl+Shift+V pasted (info)', /echo AAA/.test(sc.slice(sc.lastIndexOf('line three'))), 'headless may not fire native paste');
await page.keyboard.press('Control+c');

// --- confirm on close ---
dialogs = [];
await page.click('.tab:nth-child(2) .close');
check('closing connected tab asks to confirm', dialogs.length === 1 && page.evaluate(() => window.tabs.tabs.length === 2));
check('tab kept after cancel', await page.evaluate(() => window.tabs.tabs.length === 2));
page.removeAllListeners('dialog'); page.on('dialog', (d) => d.accept());
await page.keyboard.press('Alt+w');
check('Alt+W closes (after confirm)', await waitFor(() => page.evaluate(() => window.tabs.tabs.length === 1)));
check('closed tab pane removed', await page.evaluate(() => document.querySelectorAll('.pane').length === 1));

// --- reconnect after restarting the container ---
await page.keyboard.press('Alt+t'); await sleep(1000);
await page.evaluate(() => window.tabs.tabs.forEach((t) => (t.session.term.reset())));
execSync(`docker restart ${process.env.CONTAINER || 'ttyd-ui-test'}`, { stdio: 'ignore' });
check('state goes to reconnecting', await waitFor(() => page.evaluate(() => window.tabs.tabs.every((t) => t.session.state === 'reconnecting')), 8000));
check('dot is amber while reconnecting', await page.evaluate(() => getComputedStyle(document.querySelector('.tab .dot')).backgroundColor) === 'rgb(241, 250, 140)');
check('both tabs reconnect on their own', await waitFor(() => page.evaluate(() => window.tabs.tabs.every((t) => t.session.state === 'connected')), 30000));
await sleep(500);
await type('echo BACK=$$');
check('shell works after reconnect', await waitFor(async () => /BACK=\d+/.test(await screen(1))));

// --- shell exit => closed, no auto retry, Enter restarts ---
await type('exit');
check('exit -> closed', await waitFor(() => page.evaluate(() => window.tabs.tabs[1].session.state === 'closed')));
await sleep(2500);
check('no auto-reconnect after clean exit', await page.evaluate(() => window.tabs.tabs[1].session.state === 'closed'));
await page.keyboard.press('Enter');
check('Enter restarts ended session', await waitFor(() => page.evaluate(() => window.tabs.tabs[1].session.state === 'connected')));

// --- webgl only on active tab ---
check('webgl only on active tab', await page.evaluate(() => window.tabs.tabs.filter((t) => t.session.webgl).length <= 1), 'headless may lack webgl');

// --- mobile ---
const m = await browser.newContext({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true });
const mp = await m.newPage();
await mp.goto(BASE); await sleep(1500);
for (let i = 0; i < 6; i++) await mp.evaluate(() => window.tabs.newTab());
await sleep(1500);
const geo = await mp.evaluate(() => {
  const t = document.getElementById('tabs');
  return { scrolls: t.scrollWidth > t.clientWidth, noPageOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    cols: window.tabs.active.session.term.cols, newVisible: document.getElementById('new').getBoundingClientRect().right <= window.innerWidth };
});
check('mobile: tab bar scrolls horizontally', geo.scrolls);
check('mobile: no page overflow, + button visible', geo.noPageOverflow && geo.newVisible);
check('mobile: terminal fits screen', geo.cols > 20 && geo.cols < 70, 'cols=' + geo.cols);
await mp.screenshot({ path: process.env.SHOT_DIR + '/mobile.png' });
await page.screenshot({ path: process.env.SHOT_DIR + '/desktop.png' });

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
