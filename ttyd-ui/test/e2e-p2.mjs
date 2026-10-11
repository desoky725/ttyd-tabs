// Phase 2 browser test: persistence via tmux. Needs playwright-core + a ttyd container built from ../Dockerfile
// running the ttyd-session wrapper with /login.sh replaced by a plain shell (see TESTING.md).
//   BASE=http://127.0.0.1:7683/ CONTAINER=ttyd-p2 node test/e2e-p2.mjs
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:7683/';
const CT = process.env.CONTAINER || 'ttyd-p2';
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  -> ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => { try { return execSync(`docker exec ${CT} sh -c '${cmd}'`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return ''; } };
const sessions = () => sh('tmux -L ttyd ls -F "#{session_name}" 2>/dev/null').split('\n').filter(Boolean);
const clients = () => Number(sh('tmux -L ttyd list-clients 2>/dev/null | wc -l').trim() || 0);
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };

sh('tmux -L ttyd kill-server 2>/dev/null; rm -f /tmp/pwn2');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
const errors = [];
const mk = async (c = ctx) => {
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('dialog', (d) => d.accept());
  return p;
};
const screen = (p, i = null) => p.evaluate((i) => {
  const t = i === null ? window.tabs.active : window.tabs.tabs[i];
  const b = t.session.term.buffer.active; let s = '';
  for (let y = 0; y < b.length; y++) s += (b.getLine(y)?.translateToString(true) ?? '') + '\n';
  return s;
}, i);
const states = (p) => p.evaluate(() => window.tabs.tabs.map((t) => t.session.state));
const allConnected = (p, n) => p.evaluate((n) => window.tabs.tabs.length === n && window.tabs.tabs.every((t) => t.session.state === 'connected'), n);
const type = async (p, s) => { await p.keyboard.type(s); await p.keyboard.press('Enter'); };
const pidOf = async (p, tag) => { await type(p, `echo ${tag}=$$`); await waitFor(async () => new RegExp(`^${tag}=\\d+$`, 'm').test(await screen(p))); return (await screen(p)).match(new RegExp(`^${tag}=(\\d+)$`, 'm'))?.[1]; };

// ---------- A. fresh load creates a tmux session per tab ----------
let p1 = await mk();
await p1.goto(BASE);
check('A tab connects', await waitFor(() => allConnected(p1, 1)));
await sleep(500);
const id1 = await p1.evaluate(() => window.tabs.tabs[0].id);
check('A tmux session ttyd-<id> exists', sessions().includes('ttyd-' + id1), sessions().join(','));
check('A tmux config active (status off, no prefix, mouse off)', sh('tmux -L ttyd show -g status').includes('off') && sh('tmux -L ttyd show -g prefix').includes('None') && sh('tmux -L ttyd show -g mouse').includes('off'));

// ---------- B. reload restores tabs and reattaches (same shell) ----------
const pidA = await pidOf(p1, 'PIDA');
await type(p1, 'echo MARK_ONE');
await p1.keyboard.press('Alt+t');
check('B second tab', await waitFor(() => allConnected(p1, 2)));
await sleep(500);
const pidB = await pidOf(p1, 'PIDB');
await p1.dblclick('.tab:nth-child(2) .title'); await p1.keyboard.type('second'); await p1.keyboard.press('Enter');
const id2 = await p1.evaluate(() => window.tabs.tabs[1].id);
check('B different tmux sessions', id1 !== id2 && sessions().length === 2 && pidA !== pidB, `${pidA}/${pidB}`);
await p1.reload();
check('B tabs restored and reconnected', await waitFor(() => allConnected(p1, 2)));
const rest = await p1.evaluate(() => ({ ids: window.tabs.tabs.map((t) => t.id), titles: window.tabs.tabs.map((t) => t.title), renamed: window.tabs.tabs[1].userRenamed, active: window.tabs.tabs.findIndex((t) => t.id === window.tabs.activeId) }));
check('B same ids, rename and active tab restored', rest.ids[0] === id1 && rest.ids[1] === id2 && rest.titles[1] === 'second' && rest.renamed && rest.active === 1, JSON.stringify(rest));
await sleep(800);
check('B screen state survived reload (MARK_ONE visible on tab 1)', await waitFor(async () => /MARK_ONE/.test(await screen(p1, 0))));
const pidA2 = await pidOf(p1, 'PIDA2');
check('B shell is the SAME process after reload (tab 2)', pidA2 === pidB, `${pidB} vs ${pidA2}`);
await p1.keyboard.press('Alt+1'); await sleep(300);
const pidA3 = await pidOf(p1, 'PIDA3');
check('B shell is the SAME process after reload (tab 1)', pidA3 === pidA, `${pidA} vs ${pidA3}`);
check('B no leaked tmux clients after reload', await waitFor(() => clients() === 2, 4000), 'clients=' + clients());
check('B still exactly 2 tmux sessions', sessions().length === 2, sessions().join(','));

// ---------- C. titles, truecolor, OSC 52 through tmux ----------
await type(p1, "PS1='$ '; printf '\\033]0;tmux-title\\007'");
check('C title passes through tmux', await waitFor(() => p1.evaluate(() => window.tabs.tabs[0].title === 'tmux-title')));
await type(p1, "printf '\\033[38;2;255;100;0m%s\\033[0m\\n' XYZ$((6*7))");
await sleep(500);
const color = await p1.evaluate(() => {
  const b = window.tabs.tabs[0].session.term.buffer.active;
  for (let y = 0; y < b.length; y++) { const l = b.getLine(y); const x = l?.translateToString(true).indexOf('XYZ42'); if (x >= 0) { const c = l.getCell(x); return { rgb: c.isFgRGB(), fg: c.getFgColor() }; } }
  return null;
});
check('C truecolor passes through tmux', color && color.rgb && color.fg === 0xff6400, JSON.stringify(color));
await p1.evaluate(() => navigator.clipboard.writeText('before'));
await type(p1, "printf '\\033]52;c;%s\\a' $(printf 'clip%s' $((1+1)) | base64)");
check('C OSC 52 sets browser clipboard through tmux', await waitFor(async () => (await p1.evaluate(() => navigator.clipboard.readText())) === 'clip2', 4000));

// ---------- D. wheel scrolls tmux history; typing returns to the prompt ----------
await type(p1, 'seq 1 400');
await waitFor(async () => /^400$/m.test(await screen(p1, 0)));
await p1.mouse.move(500, 350);
await p1.mouse.wheel(0, -1200);
check('D wheel up shows older history', await waitFor(async () => !/^400$/m.test(await screen(p1, 0)) && /^\d{2,3}$/m.test(await screen(p1, 0)), 5000));
const scrolledView = await screen(p1, 0);
await p1.keyboard.type('x'); await sleep(500);
const live = await screen(p1, 0);
check('D typing leaves scrollback and reaches the prompt', /^400$/m.test(live) && /\$ x/.test(live), JSON.stringify(live.split('\n').filter(Boolean).slice(-2)));
await p1.keyboard.press('Control+u');
await p1.mouse.wheel(0, -1200); await sleep(500);
await p1.mouse.wheel(0, 3000);
check('D wheel down to the bottom auto-exits copy mode', await waitFor(async () => /^400$/m.test(await screen(p1, 0)), 5000));

// ---------- E. multi-line paste through tmux ----------
await type(p1, 'cat -A');
await sleep(300);
await p1.evaluate(() => navigator.clipboard.writeText('line one\nline two\nline three'));
await p1.click('.pane.active .xterm-screen', { button: 'right' });
await sleep(600);
await p1.keyboard.press('Control+d'); await sleep(200);
await p1.keyboard.press('Control+d'); await sleep(400); // (no trailing newline in the pasted text: first ^D only flushes it)
const pasted = await screen(p1, 0);
const tail = pasted.slice(pasted.lastIndexOf('cat -A'));
check('E paste via tmux: lines arrive once, no markers, no ^M', /line one\$\s*\nline two\$\s*\nline three/.test(tail) && !/\^\[\[20[01]~/.test(tail) && !/\^M/.test(tail.replace(/\^M\$/g, '')), JSON.stringify(tail.slice(0, 120)));

// ---------- F. takeover by another browser window ----------
const p2 = await mk();
await p2.goto(BASE);
check('F second window attaches the same sessions', await waitFor(() => allConnected(p2, 2)));
await sleep(1000);
check('F first window was detached ("closed")', await waitFor(async () => (await states(p1)).every((s) => s === 'closed'), 6000), JSON.stringify(await states(p1)));
const pidT = await pidOf(p2, 'PIDT');
check('F takeover shows the same shell', [pidA, pidB].includes(pidT), pidT);
await p1.bringToFront();
await p1.keyboard.press('Enter');
check('F pressing Enter in the old window takes it back', await waitFor(async () => (await states(p1))[0] === 'connected' && (await states(p2)).some((s) => s === 'closed'), 8000), JSON.stringify([await states(p1), await states(p2)]));
await p2.close();
await p1.reload();
await waitFor(() => allConnected(p1, 2));

// ---------- G. close tab kills its tmux session; reload keeps it ----------
await p1.keyboard.press('Alt+t');
await waitFor(() => allConnected(p1, 3)); await sleep(500);
const id3 = await p1.evaluate(() => window.tabs.tabs[2].id);
await type(p1, 'sleep 600');
await sleep(300);
check('G session of 3rd tab exists', sessions().includes('ttyd-' + id3));
await p1.keyboard.press('Alt+w');
check('G closing the tab kills its tmux session', await waitFor(() => !sessions().includes('ttyd-' + id3), 5000), sessions().join(','));
check('G and kills the running command', await waitFor(() => sh('ps -eo args | grep \"[s]leep 600\" | wc -l').trim() === '0', 4000));
check('G other sessions untouched', sessions().includes('ttyd-' + id1) && sessions().includes('ttyd-' + id2));
check('G no leaked tmux clients', await waitFor(() => clients() === 2, 4000), 'clients=' + clients());

// ---------- H. orphans view (fresh browser profile = nothing in localStorage) ----------
const ctx2 = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const p3 = await mk(ctx2);
await p3.goto(BASE);
await waitFor(() => allConnected(p3, 1));
const idNew = await p3.evaluate(() => window.tabs.tabs[0].id);
await p3.click('#sessions');
check('H panel lists the 2 orphans (not the open tab)', await waitFor(async () => (await p3.locator('.sp-row').count()) === 2, 6000), 'rows=' + (await p3.locator('.sp-row').count()));
const rowText = await p3.locator('.sp-row').allInnerTexts();
check('H rows show ids; open tab not listed', rowText.join('|').includes(id1) && rowText.join('|').includes(id2) && !rowText.join('|').includes(idNew), rowText.join(' | ').replace(/\n/g, ' '));
await p3.locator('.sp-row', { hasText: id2 }).locator('button', { hasText: 'Attach' }).click({ timeout: 5000 }).catch(() => {});
check('H Attach opens a tab on that session', await waitFor(() => p3.evaluate((id) => window.tabs.tabs.some((t) => t.id === id && t.session.state === 'connected'), id2)));
await sleep(600);
const pidAtt = await pidOf(p3, 'PIDO');
check('H attached orphan is the same shell as before', pidAtt === pidB, `${pidB} vs ${pidAtt}`);
await p3.click('#sessions');
await waitFor(async () => (await p3.locator('.sp-row').count()) === 1, 6000);
await p3.locator('.sp-row', { hasText: id1 }).locator('button', { hasText: 'Kill' }).click({ timeout: 5000 }).catch(() => {});
check('H Kill removes the orphan session', await waitFor(() => !sessions().includes('ttyd-' + id1), 6000), sessions().join(','));
await p3.close();
await ctx2.close();
await p1.bringToFront();

// ---------- I. wrapper whitelist, driven through the real websocket path ----------
const before = sessions().length;
const attempts = [['attach', 'x;touch /tmp/pwn2'], ['attach', '$(touch /tmp/pwn2)'], ['attach', 't0123456789', '-x'], ['bogus'], ['attach', '../../etc/passwd'], ['kill', 't*'], ['list', 'extra'], ['attach', 't012345678\nINJ']];
const outs = [];
for (const a of attempts) outs.push(await p1.evaluate((a) => ttydControl(a, 4000).then((o) => o, (e) => 'ERR ' + e.message), a));
check('I rejected requests created no session, ran no command', sessions().length === before && sh('ls /tmp/pwn2 2>/dev/null | wc -l').trim() === '0');
check('I rejected requests never echo input', outs.every((o) => !/INJ|touch|passwd/.test(o.replace(/ttyd-session: invalid request/g, ''))), JSON.stringify(outs.map((o) => o.replace(/[\r\n]+/g, ' ').slice(0, 60))));
const listOut = await p1.evaluate(() => listSessions().then((l) => l.map((s) => s.id)));
check('I list returns only valid ids', listOut.every((i) => /^t[0-9a-f]{10}$/.test(i)) && listOut.includes(id2), JSON.stringify(listOut));

// ---------- J. shell exit ends the session; Enter starts a fresh one ----------
await p1.keyboard.press('Alt+1'); await sleep(300);
const idx = await p1.evaluate(() => window.tabs.tabs.findIndex((t) => t.id === window.tabs.activeId));
const idEx = await p1.evaluate(() => window.tabs.active.id);
const pidBefore = await pidOf(p1, 'PIDX');
await type(p1, 'exit');
check('J exit -> closed (no auto-reconnect)', await waitFor(() => p1.evaluate((i) => window.tabs.tabs[i].session.state === 'closed', idx), 6000));
await sleep(2500);
check('J stays closed; tmux session gone', (await states(p1))[idx] === 'closed' && !sessions().includes('ttyd-' + idEx));
await p1.keyboard.press('Enter');
check('J Enter starts a new session', await waitFor(() => p1.evaluate((i) => window.tabs.tabs[i].session.state === 'connected', idx)));
await sleep(500);
const pidAfter = await pidOf(p1, 'PIDY');
check('J it is a new shell', pidAfter && pidAfter !== pidBefore, `${pidBefore} -> ${pidAfter}`);

// ---------- K. container restart: concurrent reattach of many tabs ----------
// (the tab Attach'ed from the other profile in H was taken over by design and is 'closed': restart it first)
await p1.evaluate(() => window.tabs.tabs.forEach((t) => { if (t.session.state === 'closed') t.session.reconnectNow(); }));
for (let i = 0; i < 4; i++) await p1.keyboard.press('Alt+t');
await waitFor(async () => (await p1.evaluate(() => window.tabs.tabs.length)) >= 6);
await waitFor(async () => (await states(p1)).every((s) => s === 'connected'));
const nTabs = await p1.evaluate(() => window.tabs.tabs.length);
execSync(`docker restart ${CT}`, { stdio: 'ignore' });
check(`K all ${nTabs} tabs reconnect after container restart`, await waitFor(() => allConnected(p1, nTabs), 40000),
  JSON.stringify(await p1.evaluate(() => window.tabs.tabs.map((t) => [t.id, t.session.state, t.session.attempt]))));
check('K each tab got its own fresh tmux session (concurrent create)', await waitFor(() => sessions().length === nTabs, 5000), `${sessions().length}/${nTabs} ${sessions().join(',')}`);
const maxAttempt = await p1.evaluate(() => Math.max(...window.tabs.tabs.map((t) => t.session.attempt)));
check('K reattach worked (shell responds in each tab)', await (async () => {
  for (let i = 0; i < nTabs; i++) { await p1.evaluate((i) => window.tabs.activate(window.tabs.tabs[i].id), i); await sleep(300); await type(p1, `echo UP${i}=ok`); if (!(await waitFor(async () => new RegExp(`^UP${i}=ok$`, 'm').test(await screen(p1)), 4000))) return false; }
  return true;
})());
// reload after restart still restores
await p1.reload();
check('K reload after restart restores all tabs', await waitFor(() => allConnected(p1, nTabs), 15000));

// ---------- M. large paste through tmux (bracketed-paste end marker must survive pty chunking) ----------
await p1.evaluate(() => window.tabs.activate(window.tabs.tabs[0].id)); await sleep(300);
let pasteOk = 0;
for (let i = 0; i < 6; i++) {
  await type(p1, 'x=');
  await p1.keyboard.press('Control+a'); await p1.keyboard.press('Control+e'); // no-op, keeps focus on the prompt
  await p1.keyboard.type('x=');
  await p1.evaluate((n) => navigator.clipboard.writeText('A'.repeat(n)), 20000 + i * 7777);
  await p1.click('.pane.active .xterm-screen', { button: 'right' });
  await sleep(700);
  await p1.keyboard.press('Enter');
  await type(p1, 'echo LEN$((' + i + '))=${#x}');
  const want = 20000 + i * 7777;
  if (await waitFor(async () => new RegExp(`^LEN${i}=${want}$`, 'm').test(await screen(p1, 0)), 5000)) pasteOk++;
  await p1.keyboard.press('Control+u');
}
check('M large pastes (20-59 KB, with bracketed paste) arrive intact', pasteOk === 6, `${pasteOk}/6`);
check('M no stray 200~/201~ text after them', !/20[01]~/.test(await screen(p1, 0)));

// ---------- N. wheel inside a full-screen (alternate screen) app goes to the app as arrow keys ----------
await p1.evaluate(() => window.tabs.activate(window.tabs.tabs[0].id)); await sleep(300);
const idN = await p1.evaluate(() => window.tabs.tabs[0].id);
await type(p1, 'tput smcup; clear; echo APPALT; cat -v');
await sleep(600);
await p1.mouse.move(500, 350);
await p1.mouse.wheel(0, 600); await sleep(700);
await p1.mouse.wheel(0, -600); await sleep(700);
const appScreen = await screen(p1, 0);
const downs = (appScreen.replace(/\n/g, '').match(/\^\[\[B/g) || []).length;
const ups = (appScreen.replace(/\n/g, '').match(/\^\[\[A/g) || []).length;
check('N wheel in an alt-screen app: app receives Down and Up arrows', downs >= 3 && ups >= 3, `down=${downs} up=${ups}`);
check('N ...and tmux did not enter copy-mode', sh(`tmux -L ttyd display -p -t ttyd-${idN} "#{pane_in_mode}"`).trim() === '0');
await p1.keyboard.press('Control+c'); await type(p1, 'tput rmcup; clear');
await sleep(300);

// ---------- L. storage: corrupt localStorage does not break startup ----------
await p1.evaluate(() => localStorage.setItem('ttyd-ui.tabs.v1', '{not json'));
await p1.reload();
check('L corrupt storage -> one fresh tab', await waitFor(() => allConnected(p1, 1)));
await p1.evaluate(() => localStorage.setItem('ttyd-ui.tabs.v1', JSON.stringify({ tabs: [{ id: 'tevil;rm -rf', title: 'x' }, { id: 't0123456789', title: 'ok' }], active: 'tevil' })));
await p1.reload();
check('L invalid saved ids are dropped (only the valid one restored)', await waitFor(() => p1.evaluate(() => window.tabs.tabs.length === 1 && window.tabs.tabs[0].id === 't0123456789')));

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
