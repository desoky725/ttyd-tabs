// Phase 3b browser test: saved hosts (server-side hosts file, key-only from the client).
//   BASE=... CONTAINER=... HOSTS_FILE=<host path of the file mounted at /etc/ttyd-hosts> node test/e2e-p3b.mjs
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:7683/';
const CT = process.env.CONTAINER || 'ttyd-p3-test';
const HOSTS_FILE = process.env.HOSTS_FILE;
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  -> ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => { try { return execSync(`docker exec ${CT} sh -c '${cmd}'`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return ''; } };
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };

sh('tmux -L ttyd kill-server 2>/dev/null; rm -f /tmp/pwn3');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const errors = [];
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
const menuItems = () => p.evaluate(() => document.getElementById('hosts-menu').hidden ? null : [...document.querySelectorAll('#hosts-menu button')].map((b) => b.textContent));

await p.goto(BASE);
check('setup: first tab connects', await waitFor(() => allConnected(1)));

// ---------- A. the list the server publishes ----------
const hosts = await p.evaluate(() => listHosts());
check('A hosts list: valid lines only, trimmed, comments/blank/bad-key/no-label/2-field lines dropped',
  JSON.stringify(hosts) === JSON.stringify([{ key: 'shella', label: 'Test A' }, { key: 'piped', label: 'Piped' }, { key: 'spaced', label: 'Spaced Out' }]), JSON.stringify(hosts));
check('A the commands never reach the browser', !(await p.evaluate(() => JSON.stringify(window.hostMenu.hosts))).includes('echo'));

// ---------- B. "+" menu ----------
await waitFor(() => p.evaluate(() => window.hostMenu.hosts.length === 3));
await p.click('#new');
const items = await menuItems();
check('B "+" opens a menu: Default + the 3 saved hosts', JSON.stringify(items) === JSON.stringify(['Default (login)', 'Test A', 'Piped', 'Spaced Out']), JSON.stringify(items));
await p.keyboard.press('Escape');
check('B Escape closes the menu', (await menuItems()) === null);
await p.click('#new');
await p.click('#hosts-menu button:has-text("Test A")');
check('B picking a host opens a tab running its command', await waitFor(() => allConnected(2)) && await waitFor(async () => /^HOSTA_MARK$/m.test(await screen())));
const tabHost = await p.evaluate(() => ({ host: window.tabs.tabs[1].host, q: window.tabs.tabs[1].session.query, def: window.tabs.tabs[0].host }));
check('B tab remembers its host; the websocket query carries the KEY only', tabHost.host === 'shella' && tabHost.def === '' && /arg=attach&arg=t[0-9a-f]{10}&arg=shella$/.test(tabHost.q), JSON.stringify(tabHost));
check('B menu closed after picking', (await menuItems()) === null);
await p.click('#new');
await p.click('#hosts-menu button:has-text("Piped")');
check('B command with a | inside survives (field 3+ rejoined)', await waitFor(() => allConnected(3)) && await waitFor(async () => /^ONE$/m.test(await screen())));
await p.click('#new');
await p.click('#hosts-menu button:has-text("Spaced Out")');
check('B padded key/label/command lines work', await waitFor(() => allConnected(4)) && await waitFor(async () => /^SPACED_MARK$/m.test(await screen())));
await p.keyboard.press('Alt+t');
check('B Alt+T opens a default tab (no host)', await waitFor(() => allConnected(5)) && await p.evaluate(() => window.tabs.tabs[4].host === ''));

// ---------- C. persistence ----------
await p.keyboard.press('Alt+2'); await sleep(300);
await p.keyboard.type('echo PID=$$'); await p.keyboard.press('Enter');
await waitFor(async () => /^PID=\d+$/m.test(await screen()));
const pidA = (await screen()).match(/^PID=(\d+)$/m)[1];
const stored = await p.evaluate(() => JSON.parse(localStorage.getItem('ttyd-ui.tabs.v1')).tabs.map((t) => t.host));
check('C hosts are saved in localStorage', JSON.stringify(stored) === JSON.stringify(['', 'shella', 'piped', 'spaced', '']), JSON.stringify(stored));
await p.reload();
check('C reload restores all 5 tabs', await waitFor(() => allConnected(5)));
await sleep(800);
await p.keyboard.press('Alt+2'); await sleep(300);
await p.keyboard.type('echo PID2=$$'); await p.keyboard.press('Enter');
await waitFor(async () => /^PID2=\d+$/m.test(await screen()));
check('C host tab reattaches to the SAME shell after reload (command not run again)', (await screen()).match(/^PID2=(\d+)$/m)[1] === pidA && (await screen()).split('HOSTA_MARK').length === 2);
check('C restored tabs keep their host', await p.evaluate(() => window.tabs.tabs.map((t) => t.host).join() === ',shella,piped,spaced,'));

// ---------- D. hosts file edits show up without a rebuild ----------
appendFileSync(HOSTS_FILE, 'late | Late Host | echo LATE_OK; exec bash\n');
await p.click('#new'); await sleep(1500); await p.keyboard.press('Escape');
await p.click('#new');
check('D a host added to the file appears in the next menu', ((await menuItems()) || []).includes('Late Host'));
await p.click('#hosts-menu button:has-text("Late Host")');
check('D and it runs', await waitFor(() => allConnected(6)) && await waitFor(async () => /^LATE_OK$/m.test(await screen())));

// ---------- E. no hosts -> "+" opens a default tab straight away ----------
await p.evaluate(() => { window.hostMenu.hosts = []; window.hostMenu.refresh = async () => {}; });
await p.click('#new');
check('E with no saved hosts "+" opens a default tab directly', await waitFor(() => allConnected(7)) && (await menuItems()) === null);

// ---------- F. attacks through the real websocket path ----------
const sessionsBefore = sh('tmux -L ttyd ls -F "#{session_name}"').split('\n').filter(Boolean).length;
const attack = async (...args) => p.evaluate((a) => ttydControl(a, 2500, 'NEVER').then((o) => o, (e) => 'ERR ' + e.message), args);
for (const bad of ['nosuchhost', 'SHELLA', 'shella;touch /tmp/pwn3', '$(touch /tmp/pwn3)', 'Bad Key', 'bad', 'a'.repeat(33), '-c']) {
  const out = await attack('attach', 't00000000ff', bad);
  check(`F rejected host arg ${JSON.stringify(bad.slice(0, 20))}`, !/HOSTA_MARK|ONE|LATE_OK|\$ $/.test(out) && !/touch/.test(out.replace(/invalid request/g, '')), out.replace(/[\r\n]+/g, ' ').slice(0, 60));
}
const outExtra = await attack('attach', 't00000000ff', 'shella', 'piped');
check('F two host args rejected', !/HOSTA_MARK|ONE/.test(outExtra), outExtra.slice(0, 60));
const sessionsAfter = sh('tmux -L ttyd ls -F "#{session_name}"').split('\n').filter(Boolean);
check('F rejected requests created no session and ran nothing', sessionsAfter.length === sessionsBefore && !sessionsAfter.includes('ttyd-t00000000ff') && sh('ls /tmp/pwn3 2>&1 | head -1').includes('No such') );

// ---------- G. corrupt host in storage ----------
await p.evaluate(() => localStorage.setItem('ttyd-ui.tabs.v1', JSON.stringify({ tabs: [{ id: 't0123456789', title: 'x', host: 'bad host;id' }], active: 't0123456789' })));
await p.reload();
check('G invalid saved host is dropped (tab opens as a default tab)', await waitFor(() => p.evaluate(() => window.tabs.tabs.length === 1 && window.tabs.tabs[0].host === '')) && await waitFor(() => allConnected(1)));

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
