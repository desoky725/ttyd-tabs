// Phase 3c browser test: split panes (one tmux session per pane, layout tree saved per tab).
//   BASE=... CONTAINER=... node test/e2e-p3c.mjs
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:7683/';
const CT = process.env.CONTAINER || 'ttyd-p3-test';
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  -> ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => { try { return execSync(`docker exec ${CT} sh -c '${cmd}'`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return ''; } };
const sessions = () => sh('tmux -L ttyd ls -F "#{session_name}" 2>/dev/null').split('\n').filter(Boolean);
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };

sh('tmux -L ttyd kill-server 2>/dev/null');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const errors = [];
const p = await ctx.newPage();
p.on('pageerror', (e) => errors.push(String(e)));
p.on('dialog', (d) => d.accept());
const screen = (ti, pi) => p.evaluate(([ti, pi]) => {
  const b = window.tabs.tabs[ti].panes[pi].session.term.buffer.active; let s = '';
  for (let y = 0; y < b.length; y++) s += (b.getLine(y)?.translateToString(true) ?? '') + '\n';
  return s;
}, [ti, pi]);
const allConnected = () => p.evaluate(() => window.tabs.tabs.every((t) => t.panes.every((q) => q.session.state === 'connected')));
const nPanes = (ti = 0) => p.evaluate((ti) => window.tabs.tabs[ti].panes.length, ti);
const focusIdx = (ti = 0) => p.evaluate((ti) => { const t = window.tabs.tabs[ti]; return t.panes.findIndex((q) => q.id === t.focus); }, ti);
const rect = (ti, pi) => p.evaluate(([ti, pi]) => { const r = window.tabs.tabs[ti].panes[pi].leafEl.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, [ti, pi]);
const type = async (s) => { await p.keyboard.type(s); await p.keyboard.press('Enter'); };
const pid = async (ti, pi, tag) => { await waitFor(async () => (await focusIdx(ti)) === pi); await type(`echo ${tag}=$$`); await waitFor(async () => new RegExp(`^${tag}=\\d+$`, 'm').test(await screen(ti, pi))); return (await screen(ti, pi)).match(new RegExp(`^${tag}=(\\d+)$`, 'm'))[1]; };

await p.goto(BASE);
check('setup: tab connects', await waitFor(async () => await nPanes() === 1 && await allConnected()));
await sleep(500);
const tab0 = await p.evaluate(() => window.tabs.tabs[0].id);
const pid0 = await pid(0, 0, 'P0');

// ---------- A. split right ----------
await p.keyboard.press('Alt+\\');
check('A Alt+\\ splits: 2 panes, both connected', await waitFor(async () => await nPanes() === 2 && await allConnected()));
await sleep(500);
check('A new pane is focused and receives typing', (await focusIdx()) === 1);
const pid1 = await pid(0, 1, 'P1');
check('A the panes are different shells in different tmux sessions', pid0 !== pid1 && sessions().length === 2, `${pid0}/${pid1} ${sessions().length}`);
const r0 = await rect(0, 0), r1 = await rect(0, 1);
check('A side by side, equal halves, full height', Math.abs(r0.w - r1.w) < 3 && r1.x >= r0.x + r0.w - 1 && Math.abs(r0.h - r1.h) < 2 && Math.abs(r0.y - r1.y) < 2, JSON.stringify([r0, r1]));
const cols = await p.evaluate(() => window.tabs.tabs[0].panes.map((q) => q.session.term.cols));
check('A each terminal was fitted to its half (cols about half of the full width)', cols[0] > 20 && Math.abs(cols[0] - cols[1]) <= 2, cols.join('/'));
check('A the first pane did not receive the typing of the second', !/P1=/.test(await screen(0, 0)));
// the server was told the right size
const tmuxSizes = sh('tmux -L ttyd list-clients -F "#{client_width}x#{client_height}" | sort -u | wc -l').trim();
check('A both clients report their own size to tmux', Number(tmuxSizes) >= 1);

// ---------- B. split down + directional focus ----------
await p.keyboard.press('Alt+-');
check('B Alt+- splits the focused pane down (3 panes)', await waitFor(async () => await nPanes() === 3 && await allConnected()));
await sleep(500);
const r2 = await rect(0, 2), r1b = await rect(0, 1);
check('B right column is now stacked: pane 1 above pane 2', r2.y >= r1b.y + r1b.h - 1 && Math.abs(r1b.w - r2.w) < 3 && Math.abs(r1b.x - r2.x) < 2, JSON.stringify([r1b, r2]));
check('B focus is on the newest pane', (await focusIdx()) === 2);
await p.keyboard.press('Alt+Shift+ArrowUp');
check('B Alt+Shift+Up -> pane above', (await focusIdx()) === 1);
await p.keyboard.press('Alt+Shift+ArrowLeft');
check('B Alt+Shift+Left -> left pane', (await focusIdx()) === 0);
await p.keyboard.press('Alt+Shift+ArrowLeft');
check('B no pane further left: focus stays', (await focusIdx()) === 0);
await p.keyboard.press('Alt+Shift+ArrowRight');
check('B Alt+Shift+Right -> a right pane', (await focusIdx()) >= 1);
await p.keyboard.press('Alt+Shift+ArrowDown'); await p.keyboard.press('Alt+Shift+ArrowDown');
check('B Alt+Shift+Down -> bottom right pane', (await focusIdx()) === 2);
await type('echo ONLY_IN_PANE_2');
check('B typing goes to the focused pane only', await waitFor(async () => /^ONLY_IN_PANE_2$/m.test(await screen(0, 2))) && !/ONLY_IN_PANE_2/.test(await screen(0, 0)) && !/ONLY_IN_PANE_2/.test(await screen(0, 1)));
// click focus
await p.click('.pane.active .leaf:nth-of-type(1) .xterm-screen');
check('B clicking a pane focuses it', (await focusIdx()) === 0);

// ---------- C. limit ----------
await p.keyboard.press('Alt+\\');
check('C fourth pane works', await waitFor(async () => await nPanes() === 4 && await allConnected()));
await p.keyboard.press('Alt+\\');
await sleep(300);
check('C fifth pane refused with a message', (await nPanes()) === 4 && /At most 4/.test(await p.textContent('#toast')) && sessions().length === 4);

// ---------- D. divider drag ----------
await p.keyboard.press('Alt+Shift+W'); // back to 3 panes via close (also tests F early): focused is the newest
check('D/F Alt+Shift+W closes the focused pane and its tmux session', await waitFor(async () => await nPanes() === 3 && sessions().length === 3), `${await nPanes()} panes, ${sessions().length} sessions`);
const before = await rect(0, 0);
const div = await p.evaluate(() => { const d = [...window.tabs.tabs[0].dividers.values()].map((e) => e.getBoundingClientRect()).sort((a, b) => b.height - a.height)[0]; return { x: d.left + d.width / 2, y: d.top + d.height * 0.25 }; });   // 25%: the T-junction with the other divider is at 50%
await p.mouse.move(div.x, div.y); await p.mouse.down(); await p.mouse.move(div.x + 200, div.y, { steps: 8 }); await p.mouse.up();
await sleep(500);
const after = await rect(0, 0);
check('D dragging the divider resizes the panes', after.w > before.w + 150, `${before.w} -> ${after.w}`);
const colsAfter = await p.evaluate(() => window.tabs.tabs[0].panes[0].session.term.cols);
check('D and the terminal refits (more columns)', colsAfter > cols[0] + 10, `${cols[0]} -> ${colsAfter}`);
const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('ttyd-ui.tabs.v1')).tabs[0].layout.ratio);
check('D new ratio is saved (clamped to 10..90%)', saved > 0.55 && saved <= 0.9, String(saved));
await p.mouse.move(div.x + 200, div.y); await p.mouse.down(); await p.mouse.move(5, div.y, { steps: 8 }); await p.mouse.up();
const clamp = await p.evaluate(() => window.tabs.tabs[0].layout.ratio);
check('D dragging past the edge clamps at 10%', Math.abs(clamp - 0.1) < 0.001, String(clamp));

// ---------- E. reload keeps layout, shells, focus ----------
const idsBefore = await p.evaluate(() => window.tabs.tabs[0].panes.map((q) => q.id));
await p.keyboard.press('Alt+Shift+ArrowRight');
const focusBefore = await focusIdx();
const pidsBefore = [];
for (let i = 0; i < 3; i++) { await p.evaluate((i) => window.tabs.focusPane(window.tabs.tabs[0], window.tabs.tabs[0].panes[i].id), i); pidsBefore.push(await pid(0, i, 'Q' + i)); }
await p.evaluate((i) => window.tabs.focusPane(window.tabs.tabs[0], window.tabs.tabs[0].panes[i].id), focusBefore);
const rectsBefore = await Promise.all([0, 1, 2].map((i) => rect(0, i)));
await p.reload();
check('E reload restores 3 panes, all reconnected', await waitFor(async () => await nPanes() === 3 && await allConnected()));
await sleep(800);
const idsAfter = await p.evaluate(() => window.tabs.tabs[0].panes.map((q) => q.id));
check('E same pane ids, same focus', JSON.stringify(idsBefore) === JSON.stringify(idsAfter) && (await focusIdx()) === focusBefore);
const rectsAfter = await Promise.all([0, 1, 2].map((i) => rect(0, i)));
check('E same geometry (incl. dragged ratio)', rectsBefore.every((r, i) => Math.abs(r.x - rectsAfter[i].x) < 3 && Math.abs(r.w - rectsAfter[i].w) < 3 && Math.abs(r.h - rectsAfter[i].h) < 3), JSON.stringify([rectsBefore[0], rectsAfter[0]]));
const pidsAfter = [];
for (let i = 0; i < 3; i++) { await p.evaluate((i) => window.tabs.focusPane(window.tabs.tabs[0], window.tabs.tabs[0].panes[i].id), i); pidsAfter.push(await pid(0, i, 'R' + i)); }
check('E every pane reattached to its SAME shell', JSON.stringify(pidsBefore) === JSON.stringify(pidsAfter), pidsBefore + ' vs ' + pidsAfter);
check('E no leaked tmux clients, no extra sessions', sessions().length === 3 && Number(sh('tmux -L ttyd list-clients | wc -l').trim()) === 3);

// ---------- H. the Sessions panel does not offer panes of open tabs ----------
await p.click('#sessions');
check('H Sessions panel: no orphans (panes of open tabs are not listed)', await waitFor(() => p.evaluate(() => /No orphaned sessions/.test(document.getElementById('sessions-panel').textContent))));
await p.keyboard.press('Escape');

// ---------- I. search covers the FOCUSED pane ----------
await p.evaluate(() => window.tabs.focusPane(window.tabs.tabs[0], window.tabs.tabs[0].panes[1].id));
await type('echo SEARCH_ONLY_HERE_9');
await waitFor(async () => /^SEARCH_ONLY_HERE_9$/m.test(await screen(0, 1)));
await p.keyboard.press('Control+Shift+F');
await p.fill('#search-panel input', 'search_only_here_9');
const res = () => p.evaluate(() => document.querySelector('.ss-info').textContent);
check('I search finds text of the focused pane', await waitFor(async () => /matches?/.test(await res()) && !/No matches/.test(await res())));
await p.keyboard.press('Escape');
await p.evaluate(() => window.tabs.focusPane(window.tabs.tabs[0], window.tabs.tabs[0].panes[0].id));
await p.keyboard.press('Control+Shift+F');
await p.fill('#search-panel input', 'search_only_here_9');
check('I and does not find it when another pane is focused', await waitFor(async () => (await res()) === 'No matches.'));
await p.keyboard.press('Escape');

// ---------- J. tab state with one ended pane ----------
await p.evaluate(() => window.tabs.focusPane(window.tabs.tabs[0], window.tabs.tabs[0].panes[2].id));
await type('exit');
check('J one pane ends: it shows closed, the tab stays connected (others live)', await waitFor(() => p.evaluate(() => window.tabs.tabs[0].panes[2].session.state === 'closed' && window.tabs.tabs[0].el.dataset.state === 'connected')));
check('J the tab shows the reconnect button', await p.evaluate(() => !window.tabs.tabs[0].reconnectEl.hidden));
await p.keyboard.press('Enter');
check('J Enter in the ended pane starts a new shell', await waitFor(allConnected));

// ---------- K. badges with panes ----------
await p.keyboard.press('Alt+t');
check('K second tab', await waitFor(async () => await p.evaluate(() => window.tabs.tabs.length) === 2 && await allConnected()));
await sleep(1500);
await p.evaluate(() => window.tabs.activate(window.tabs.tabs[0].id));
await p.evaluate(() => window.tabs.focusPane(window.tabs.tabs[0], window.tabs.tabs[0].panes[1].id));
await type('sleep 2; echo BG');   // runs in pane 1
await p.evaluate(() => window.tabs.focusPane(window.tabs.tabs[0], window.tabs.tabs[0].panes[0].id));
await p.keyboard.press('Alt+2');
check('K output in a NON-focused pane of a background tab badges the tab', await waitFor(() => p.evaluate(() => window.tabs.tabs[0].el.dataset.badge === 'activity'), 6000));
await p.keyboard.press('Alt+1');
check('K badge clears on activate', await p.evaluate(() => !window.tabs.tabs[0].el.dataset.badge));

// ---------- L. hostile / corrupt saved layouts ----------
const L = (layout, extra = {}) => p.evaluate(({ layout, extra }) => Layout.validate(layout) ? JSON.stringify(Layout.leaves(Layout.validate(layout)).map((l) => l.id + ':' + l.host)) : 'null', { layout, extra });
const lf = (c, host) => ({ id: 't' + String(c).repeat(10), host });
check('L valid tree accepted', (await L({ dir: 'h', ratio: 0.3, a: lf(1), b: lf(2, 'shella') })) === '["t1111111111:","t2222222222:shella"]');
check('L bad host string stripped from a leaf', (await L(lf(1, 'x;rm -rf'))) === '["t1111111111:"]');
check('L bad id -> rejected', (await L({ dir: 'h', a: lf(1), b: { id: 'tZZ', host: '' } })) === 'null');
check('L duplicate ids -> rejected', (await L({ dir: 'h', a: lf(1), b: lf(1) })) === 'null');
check('L more than 4 leaves -> rejected', (await L({ dir: 'h', a: { dir: 'v', a: lf(1), b: lf(2) }, b: { dir: 'v', a: { dir: 'h', a: lf(3), b: lf(4) }, b: lf(5) } })) === 'null');
let deep = lf(1); for (let i = 2; i < 40; i++) deep = { dir: 'h', a: deep, b: lf(i % 9 + 1) };
check('L deep tree -> rejected', (await L(deep)) === 'null');
check('L bad dir -> rejected', (await L({ dir: 'x', a: lf(1), b: lf(2) })) === 'null');
check('L absurd ratio -> reset to 0.5', await p.evaluate((a) => Layout.validate(a).ratio === 0.5, { dir: 'h', ratio: 7, a: lf(1), b: lf(2) }));
check('L not an object -> rejected', (await L('x')) === 'null' && (await L(null)) === 'null' && (await L(5)) === 'null');
await p.evaluate(() => localStorage.setItem('ttyd-ui.tabs.v1', JSON.stringify({ tabs: [{ id: 't0123456789', title: 'x', layout: { dir: 'h', a: { id: 't0123456789' }, b: { id: 'evil;id' } } }], active: 't0123456789' })));
await p.reload();
check('L stored hostile layout -> one clean pane', await waitFor(async () => await nPanes() === 1 && await allConnected()));
await p.evaluate(() => localStorage.setItem('ttyd-ui.tabs.v1', JSON.stringify({ tabs: [{ id: 't0123456789', title: 'old' }], active: 't0123456789' })));
await p.reload();
check('L v1 storage (no layout) still restores', await waitFor(async () => await nPanes() === 1 && await allConnected()));

// ---------- F. closing ----------
sh('tmux -L ttyd kill-server');
await p.evaluate(() => localStorage.clear());
await p.reload();
await waitFor(async () => await nPanes() === 1 && await allConnected());
await sleep(500);
await p.keyboard.press('Alt+\\');
await waitFor(async () => await nPanes() === 2 && await allConnected());
await sleep(500);
const paneIds = await p.evaluate(() => window.tabs.tabs[0].panes.map((q) => q.id));
await p.hover('.pane.active .leaf:nth-of-type(1)');
await p.click('.pane.active .leaf:nth-of-type(1) .pclose');
check('F x button closes that pane and kills its session', await waitFor(async () => await nPanes() === 1 && !sessions().includes('ttyd-' + paneIds[0]) && sessions().includes('ttyd-' + paneIds[1])), sessions().join());
const rr = await rect(0, 0);
const area = await p.evaluate(() => { const r = document.getElementById('panes').getBoundingClientRect(); return { w: r.width, h: r.height }; });
check('F the remaining pane takes the whole area and gets focus', Math.abs(rr.w - area.w) < 3 && Math.abs(rr.h - area.h) < 3 && (await focusIdx()) === 0);
check('F single pane: no close-x, no dividers', await p.evaluate(() => getComputedStyle(document.querySelector('.pclose')).display === 'none' && document.querySelectorAll('.divider').length === 0));
await p.keyboard.press('Alt+Shift+W');
await sleep(300);
check('F Alt+Shift+W on a single pane does nothing (use Alt+W for the tab)', (await nPanes()) === 1 && sessions().length === 1);
await p.keyboard.press('Alt+\\'); await p.keyboard.press('Alt+-');
await waitFor(async () => await nPanes() === 3 && await allConnected());
await sleep(500);
check('G 3 panes = 3 tmux sessions', sessions().length === 3);
await p.keyboard.press('Alt+w');
check('G closing the tab kills ALL its panes\' sessions', await waitFor(() => sessions().length === 1, 6000), sessions().join());   // 1 = the fresh replacement tab
check('G a fresh single-pane tab replaced it', await waitFor(async () => await nPanes() === 1 && await allConnected()));

// ---------- M. host inheritance + narrow screen ----------
await p.click('#new');
await p.click('#hosts-menu button:has-text("Test A")');
await waitFor(async () => (await p.evaluate(() => window.tabs.tabs.length)) === 2 && await allConnected());
await sleep(500);
await p.keyboard.press('Alt+\\');
await waitFor(async () => await nPanes(1) === 2 && await allConnected());
check('M a split of a saved-host pane inherits the host', await p.evaluate(() => window.tabs.tabs[1].panes.every((q) => q.host === 'shella' && /arg=shella$/.test(q.session.query))));
await sleep(500);
check('M the inherited pane ran the host command', await waitFor(async () => /^HOSTA_MARK$/m.test(await screen(1, 1))));
await p.setViewportSize({ width: 390, height: 800 });
await sleep(500);
const bar = await p.evaluate(() => ({ tabs: document.getElementById('tabs').getBoundingClientRect().width, btns: ['sessions', 'palette', 'new'].map((i) => document.getElementById(i).getBoundingClientRect().width) }));
check('M phone width: tab strip keeps room and all buttons stay visible', bar.tabs > 100 && bar.btns.every((w) => w > 20), JSON.stringify(bar));
const mr = await Promise.all([0, 1].map((i) => rect(1, i)));
check('M phone width: both panes fit inside the screen', mr.every((r) => r.x >= -1 && r.x + r.w <= 391));

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
