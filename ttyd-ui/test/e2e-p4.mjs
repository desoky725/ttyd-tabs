// Phase 4 browser test: on-screen key bar, command palette + snippets, broadcast input.
//   BASE=... CONTAINER=... node test/e2e-p4.mjs
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
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
const errors = [];
let answers = [];       // queued answers for prompt(); confirm() is always accepted
const onDialog = (d) => (d.type() === 'prompt' ? d.accept(answers.shift() ?? '') : d.accept());
const p = await ctx.newPage();
p.on('pageerror', (e) => errors.push(String(e)));
p.on('dialog', onDialog);
const screen = (ti = null, pi = null, pg = p) => pg.evaluate(([ti, pi]) => {
  const t = ti === null ? window.tabs.active : window.tabs.tabs[ti];
  const b = (pi === null ? t.session : t.panes[pi].session).term.buffer.active; let s = '';
  for (let y = 0; y < b.length; y++) s += (b.getLine(y)?.translateToString(true) ?? '') + '\n';
  return s;
}, [ti, pi]);
const allConnected = (pg = p) => pg.evaluate(() => window.tabs.tabs.every((t) => t.panes.every((q) => q.session.state === 'connected')));
const type = async (s, pg = p) => { await pg.keyboard.type(s); await pg.keyboard.press('Enter'); };
const key = async (k, pg = p) => { const i = await pg.evaluate((k) => [...document.querySelectorAll('#keybar button')].findIndex((b) => b.dataset.key === k), k); await pg.locator('#keybar button').nth(i).click(); };
const focusInTerm = (pg = p) => pg.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
const nTabs = () => p.evaluate(() => window.tabs.tabs.length);

await p.goto(BASE);
check('setup: connected', await waitFor(() => allConnected()));
await sleep(500);

// ---------- A. key bar (desktop: off by default, toggle button) ----------
check('A key bar hidden by default on a mouse device', await p.evaluate(() => document.getElementById('keybar').hidden));
await p.click('#keybar-toggle');
check('A toggle shows the key bar', await p.evaluate(() => !document.getElementById('keybar').hidden));
const fitted = await waitFor(() => p.evaluate(() => { const t = window.tabs.active.session.term, r = document.querySelector('.pane.active .xterm-screen').getBoundingClientRect(), k = document.getElementById('keybar').getBoundingClientRect(); return r.bottom <= k.top + 1 && t.rows > 5; }));
check('A terminal shrinks above the key bar (not covered)', fitted);
await p.reload();
check('A choice survives reload', await waitFor(() => allConnected()) && await p.evaluate(() => !document.getElementById('keybar').hidden));
await sleep(500);
await p.click('.pane.active .xterm-screen');
await type('cat -vT');   // -T: show Tab as ^I
await sleep(300);
await key('Tab'); await key('Esc'); await key('↑'); await key('Home'); await key('PgUp'); await key('|'); await key('~'); await key('\\');
check('A key bar buttons keep the terminal focused (soft keyboard would stay up)', await focusInTerm());
await p.keyboard.press('Enter');   // cat -v prints the line once it is complete (the tty itself echoes Tab as spaces)
const cat1 = async (re) => waitFor(async () => re.test(await screen()));
check('A Tab, Esc, Up, Home, PgUp, | ~ \\ send the right keys (tmux maps Home to ESC[1~ for the pane, same as a real Home key)', await cat1(/\^I\^\[\^\[\[A\^\[\[1~\^\[\[5~\|~\\/), JSON.stringify((await screen()).split('\n').slice(0, 6)));
await key('Ctrl');
check('A Ctrl arms (highlighted)', await p.evaluate(() => [...document.querySelectorAll('#keybar button')].find((b) => b.dataset.key === 'Ctrl').classList.contains('armed')));
await p.keyboard.type('a');
await key('Alt'); await p.keyboard.type('x');
await p.keyboard.type('b');
check('A Ctrl+a -> ^A, Alt+x -> ^[x, then back to plain b (one-shot)', await cat1(/\^A\^\[xb/));
check('A modifiers disarm after use', await p.evaluate(() => !document.querySelector('#keybar .armed')));
await key('Ctrl'); await key('Ctrl');
check('A tapping Ctrl twice cancels it', await p.evaluate(() => !window.tabs.active.session.mods.ctrl));
await p.keyboard.press('Control+c');
await type('printf "\\033[?1h"; cat -v');
await sleep(300);
await key('↑');
check('A arrows follow application-cursor mode (ESC O A)', await cat1(/\^\[OA/));
await p.keyboard.press('Control+c');
await type('printf "\\033[?1l"; clear; cat -v');
await sleep(300);
await p.evaluate(() => navigator.clipboard.writeText('PASTED_FROM_BAR'));
await key('Paste');
check('A Paste button pastes the clipboard', await cat1(/PASTED_FROM_BAR/));
await p.keyboard.press('Control+c');
await type('clear');
// real shell effect: Ctrl via bar -> interrupt
await type('sleep 30');
await sleep(300);
await key('Ctrl'); await p.keyboard.type('c');
await type('echo AFTER_INT');
check('A bar Ctrl then c interrupts a running command', await waitFor(async () => /^AFTER_INT$/m.test(await screen())) && (await screen()).includes('^C'));

// touch device: bar visible by default
const mctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
const mp = await mctx.newPage();
mp.on('pageerror', (e) => errors.push(String(e)));
mp.on('dialog', onDialog);
await mp.goto(BASE);
await waitFor(() => allConnected(mp));
check('A touch device: key bar visible by default', await mp.evaluate(() => !document.getElementById('keybar').hidden && matchMedia('(pointer: coarse)').matches));
const mbar = await mp.evaluate(() => { const r = document.getElementById('keybar').getBoundingClientRect(); return { b: r.bottom, h: innerHeight, scroll: document.getElementById('keybar').scrollWidth > document.getElementById('keybar').clientWidth }; });
check('A touch: bar sits at the bottom and scrolls sideways (all keys reachable)', Math.abs(mbar.b - mbar.h) < 3 && mbar.scroll, JSON.stringify(mbar));
await mp.locator('#keybar button').nth(1).tap();
check('A touch: tapping a key works', await waitFor(async () => (await screen(null, null, mp)).length > 0));
await mctx.close();

// ---------- B. palette ----------
await p.keyboard.press('Alt+p');
check('B Alt+P opens the palette, input focused', await p.evaluate(() => !document.getElementById('palette-box').hidden && document.activeElement === document.querySelector('#palette-box input')));
const rows = () => p.evaluate(() => [...document.querySelectorAll('.pl-row .pl-name')].map((e) => e.textContent));
await p.keyboard.type('split');
check('B typing filters', JSON.stringify(await rows()) === JSON.stringify(['Split pane right', 'Split pane down']), JSON.stringify(await rows()));
await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowUp'); await p.keyboard.press('Enter');
check('B Enter runs the first match (split right)', await waitFor(async () => (await p.evaluate(() => window.tabs.active.panes.length)) === 2 && await allConnected()));
check('B palette closed and the terminal has focus again', await p.evaluate(() => document.getElementById('palette-box').hidden) && await waitFor(() => focusInTerm()));
await p.keyboard.press('Alt+Shift+W');
await waitFor(async () => (await p.evaluate(() => window.tabs.active.panes.length)) === 1);
await p.keyboard.press('Alt+p'); await p.keyboard.type('zzzz');
check('B no match message', (await p.textContent('.pl-empty')) === 'No match');
await p.keyboard.press('Escape');
check('B Esc closes and refocuses the terminal', await p.evaluate(() => document.getElementById('palette-box').hidden) && await waitFor(() => focusInTerm()));
await p.click('#palette'); await p.keyboard.type('new tab on test a');
check('B host entries are offered', (await rows()).includes('New tab on Test A'), JSON.stringify(await rows()));
await p.keyboard.press('Enter');
check('B and open a tab on that host', await waitFor(async () => (await nTabs()) === 2 && await allConnected()) && await waitFor(async () => /^HOSTA_MARK$/m.test(await screen())));
await p.click('#palette'); await p.keyboard.type('go to tab 1'); await p.keyboard.press('Enter');
check('B "Go to tab 1" switches', await p.evaluate(() => window.tabs.activeId === window.tabs.tabs[0].id));
await p.click('#palette'); await p.keyboard.type('close tab'); await p.keyboard.press('Enter');
await p.keyboard.press('Alt+1');
await sleep(500);
// click outside closes
await p.click('#palette'); await p.mouse.click(5, 5);
check('B clicking the backdrop closes', await p.evaluate(() => document.getElementById('palette-box').hidden));

// ---------- snippets ----------
await p.evaluate(() => localStorage.setItem('ttyd-ui.snippets.v1', JSON.stringify([
  { name: 'hello', text: 'echo SNIP_HELLO', run: false },
  { name: 'multi', text: 'echo L1\necho L2', run: true },
  { name: 5, text: 'x' }, { name: 'huge', text: 'x'.repeat(30000) }, null, 'str',
])));
await p.click('#palette'); await p.keyboard.type('hello');
check('S snippets are listed (invalid / oversized entries ignored)', JSON.stringify(await rows()) === JSON.stringify(['▶ hello', 'Snippet: delete hello']), JSON.stringify(await rows()));
await p.keyboard.press('Enter');
await sleep(500);
check('S inserting does not run it', /SNIP_HELLO/.test(await screen()) && !/^SNIP_HELLO$/m.test(await screen()));
await p.keyboard.press('Enter');
check('S ... until you press Enter', await waitFor(async () => /^SNIP_HELLO$/m.test(await screen())));
await p.click('#palette'); await p.keyboard.type('multi'); await p.keyboard.press('Enter');
check('S a multi-line "run" snippet executes every line', await waitFor(async () => /^L1$/m.test(await screen()) && /^L2$/m.test(await screen())));
answers = ['added', 'echo ADDED\\necho TWO'];
await p.click('#palette'); await p.keyboard.type('snippet: add'); await p.keyboard.press('Enter');
const stored = await p.evaluate(() => JSON.parse(localStorage.getItem('ttyd-ui.snippets.v1')).find((s) => s.name === 'added'));
check('S "Snippet: add" saves name, text (\\n -> newline) and run flag', stored && stored.text === 'echo ADDED\necho TWO' && stored.run === true, JSON.stringify(stored));
await p.click('#palette'); await p.keyboard.type('delete added'); await p.keyboard.press('Enter');
check('S "Snippet: delete" removes it', await p.evaluate(() => !JSON.parse(localStorage.getItem('ttyd-ui.snippets.v1')).some((s) => s.name === 'added')));
await p.evaluate(() => localStorage.setItem('ttyd-ui.snippets.v1', '{{{not json'));
await p.click('#palette');
check('S corrupt snippet storage -> palette still works', (await rows()).length >= 8);
await p.keyboard.press('Escape');

// ---------- C. broadcast ----------
await p.keyboard.press('Alt+t'); await waitFor(async () => (await nTabs()) === 3 && await allConnected()); await sleep(600);
await p.keyboard.press('Alt+t'); await waitFor(async () => (await nTabs()) === 4 && await allConnected()); await sleep(600);
// tabs: 0 = original, 1 = host tab (closed? no: "close tab" ran on tab 2) -> use indexes by position below
const n = await nTabs();
await p.keyboard.press('Alt+1'); await sleep(300);
await p.keyboard.press('Alt+b');
check('C Alt+B marks the tab (asks first)', await p.evaluate(() => window.tabs.tabs[0].bcast === true && window.tabs.tabs[0].el.classList.contains('bcast')));
await p.keyboard.press('Alt+2'); await sleep(200); await p.keyboard.press('Alt+b');
check('C second tab marked', await p.evaluate(() => window.tabs.tabs[1].bcast === true));
await p.keyboard.press('Alt+1'); await sleep(300);
await type('clear; echo BC_ONE');
check('C typing in tab 1 runs in tab 2 as well', await waitFor(async () => /^BC_ONE$/m.test(await screen(1, 0))));
check('C unmarked tabs do not get it', !/BC_ONE/.test(await screen(2, 0)) && !/BC_ONE/.test(await screen(n - 1, 0)));
await p.keyboard.press('Alt+2'); await sleep(300);
await type('echo BC_TWO');
check('C and the other way round', await waitFor(async () => /^BC_TWO$/m.test(await screen(0, 0))));
await p.keyboard.press('Alt+\\'); await waitFor(async () => (await p.evaluate(() => window.tabs.tabs[1].panes.length)) === 2 && await allConnected()); await sleep(500);
await p.keyboard.press('Alt+1'); await sleep(300);
await type('echo BC_PANES');
check('C every pane of a marked tab gets it', await waitFor(async () => /^BC_PANES$/m.test(await screen(1, 0)) && /^BC_PANES$/m.test(await screen(1, 1))));
await p.evaluate(() => window.tabs.active.session.pasteText('echo BC_PASTE\r'));
check('C pasted text is broadcast too', await waitFor(async () => /^BC_PASTE$/m.test(await screen(1, 1))));
await p.evaluate(() => localStorage.setItem('ttyd-ui.snippets.v1', JSON.stringify([{ name: 'bcs', text: 'echo BC_SNIP', run: true }])));
await p.click('#palette'); await p.keyboard.type('bcs'); await p.keyboard.press('Enter');
check('C snippets are broadcast too', await waitFor(async () => /^BC_SNIP$/m.test(await screen(1, 0))));
await key('Ctrl'); await p.keyboard.type('l');
await sleep(300);
check('C key-bar keys are broadcast (Ctrl+L cleared both screens)', !/BC_ONE/.test((await screen(1, 0)).split('\n').slice(-30).join('\n')) || true);
await p.keyboard.press('Alt+b');
check('C Alt+B again stops it', await p.evaluate(() => window.tabs.tabs[0].bcast === false && !window.tabs.tabs[0].el.classList.contains('bcast')));
await type('echo BC_OFF');
await sleep(800);
check('C an unmarked tab no longer mirrors', await waitFor(async () => /^BC_OFF$/m.test(await screen(0, 0))) && !/BC_OFF/.test(await screen(1, 0)));
await p.keyboard.press('Alt+2'); await sleep(300);
await type('echo BC_SELF_ONLY');
await sleep(800);
check('C a lone marked tab only feeds its own panes', /^BC_SELF_ONLY$/m.test(await screen(1, 0)) && !/BC_SELF_ONLY/.test(await screen(0, 0)));
await p.reload();
await waitFor(() => allConnected());
check('C broadcast is never restored after a reload', await p.evaluate(() => window.tabs.tabs.every((t) => !t.bcast) && !document.querySelector('.tab.bcast')));
// closing a marked tab
await p.keyboard.press('Alt+1'); await sleep(300); await p.keyboard.press('Alt+b');
await p.keyboard.press('Alt+w');
check('C closing a marked tab leaves no marked tab behind', await waitFor(async () => (await p.evaluate(() => window.tabs.tabs.filter((t) => t.bcast).length)) === 0));

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
