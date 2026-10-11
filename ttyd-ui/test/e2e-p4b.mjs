// Phase 4b browser test: trzsz file transfer (trz = upload to the server, tsz = download) through tmux.
// Needs the trzsz-go binaries (trz, tsz) in TRZSZ_DIR (https://github.com/trzsz/trzsz-go/releases, linux_x86_64);
// without them this test is skipped. The File System Access pickers are replaced by in-page stubs (a headless
// browser cannot drive the native dialogs), so this checks the protocol path, not the dialogs.
//   BASE=... CONTAINER=... TRZSZ_DIR=/path node test/e2e-p4b.mjs
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:7683/';
const CT = process.env.CONTAINER || 'ttyd-p3-test';
const DIR = process.env.TRZSZ_DIR;
if (!DIR || !existsSync(join(DIR, 'trz'))) { console.log('SKIP trzsz test (set TRZSZ_DIR to a directory with trz and tsz)'); process.exit(0); }
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  -> ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => { try { return execSync(`docker exec ${CT} sh -c '${cmd}'`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return ''; } };
const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };
const sha = (b) => createHash('sha256').update(b).digest('hex');

execSync(`docker cp ${join(DIR, 'trz')} ${CT}:/usr/local/bin/trz && docker cp ${join(DIR, 'tsz')} ${CT}:/usr/local/bin/tsz`);
const work = mkdtempSync(join(tmpdir(), 'trzsz-'));
const upBytes = randomBytes(700000), downBytes = randomBytes(300000);
writeFileSync(join(work, 'down.bin'), downBytes);
execSync(`docker cp ${join(work, 'down.bin')} ${CT}:/tmp/down.bin`);
sh('rm -rf /tmp/up; mkdir -p /tmp/up; tmux -L ttyd kill-server 2>/dev/null');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const errors = [];
await ctx.addInitScript(() => {
  window.__got = {};
  window.__mode = 'ok';
  window.showOpenFilePicker = async () => {
    if (window.__mode === 'cancel') throw new DOMException('cancelled', 'AbortError');
    const bytes = Uint8Array.from(atob(window.__upB64), (c) => c.charCodeAt(0));
    return [{ getFile: async () => new File([bytes], 'up.bin') }];
  };
  window.showDirectoryPicker = async () => {
    if (window.__mode === 'cancel') throw new DOMException('cancelled', 'AbortError');
    return { kind: 'directory', name: 'dl', async *values() {}, getFileHandle: async (name) => ({ createWritable: async () => { const parts = []; return { write: async (c) => { parts.push(c instanceof Blob ? c : new Blob([c])); }, close: async () => { window.__got[name] = new Blob(parts); } }; } }) };
  };
});
const p = await ctx.newPage();
p.on('pageerror', (e) => errors.push(String(e)));
p.on('dialog', (d) => d.accept());
const screen = () => p.evaluate(() => { const b = window.tabs.active.session.term.buffer.active; let s = ''; for (let y = 0; y < b.length; y++) s += (b.getLine(y)?.translateToString(true) ?? '') + '\n'; return s; });
const type = async (s) => { await p.keyboard.type(s); await p.keyboard.press('Enter'); };

await p.goto(BASE);
await waitFor(() => p.evaluate(() => window.tabs.active.session.state === 'connected'));
await sleep(600);
await p.evaluate((b) => { window.__upB64 = b; }, upBytes.toString('base64'));

// ---------- upload (trz) ----------
await type('cd /tmp/up && trz');
check('trz: upload completes', await waitFor(async () => /Saved 1 file\/directory to \/tmp\/up/.test(await screen())), (await screen()).split('\n').filter(Boolean).slice(-3).join(' | '));
check('trz: 700 kB arrives byte-exact (sha256) through tmux', sha(upBytes) === sh('sha256sum /tmp/up/up.bin').split(' ')[0]);
await type('echo AFTER_UP');
check('trz: the terminal is back to normal afterwards', await waitFor(async () => /^AFTER_UP$/m.test(await screen())));

// ---------- download (tsz) ----------
await type('clear; tsz /tmp/down.bin');
check('tsz: download completes', await waitFor(async () => /Saved 1 file\/directory to dl/.test(await screen()) && await p.evaluate(() => !!window.__got['down.bin'])), (await screen()).split('\n').filter(Boolean).slice(-3).join(' | '));
const gotB64 = await p.evaluate(async () => { const v = window.__got['down.bin']; if (!v) return ''; const b = new Uint8Array(await v.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return btoa(s); });
check('tsz: 300 kB arrives byte-exact (sha256) through tmux', gotB64 && sha(Buffer.from(gotB64, 'base64')) === sha(downBytes), gotB64 ? `got ${Buffer.from(gotB64, 'base64').length} bytes` : 'nothing received; screen tail: ' + (await screen()).split('\n').filter(Boolean).slice(-6).map((l) => l.slice(0, 100)).join(' | '));
await type('echo AFTER_DOWN');
check('tsz: the terminal is back to normal afterwards', await waitFor(async () => /^AFTER_DOWN$/m.test(await screen())));

// ---------- cancel / unsupported ----------
await p.evaluate(() => { window.__mode = 'cancel'; });
sh('rm -f /tmp/up/*');
await type('clear; trz');
check('cancelling the picker cancels the transfer cleanly', await waitFor(async () => /Cancelled/i.test(await screen())) && sh('ls /tmp/up').trim() === '');
await type('echo AFTER_CANCEL');
check('... and the shell keeps working', await waitFor(async () => /^AFTER_CANCEL$/m.test(await screen())));
const p2 = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
await p2.addInitScript(() => { delete window.showOpenFilePicker; delete window.showDirectoryPicker; });
p2.on('pageerror', (e) => errors.push(String(e)));
await p2.goto(BASE);
await waitFor(() => p2.evaluate(() => window.tabs.active.session.state === 'connected'));
await sleep(600);
await p2.keyboard.type('trz'); await p2.keyboard.press('Enter');
const scr2 = () => p2.evaluate(() => { const b = window.tabs.active.session.term.buffer.active; let s = ''; for (let y = 0; y < b.length; y++) s += (b.getLine(y)?.translateToString(true) ?? '') + '\n'; return s; });
check('a browser without the File System Access API gets a clear message and a working shell', await waitFor(async () => /File System Access/i.test(await scr2())), (await scr2()).split('\n').filter(Boolean).slice(-3).join(' | '));
await p2.keyboard.type('echo STILL_OK'); await p2.keyboard.press('Enter');
check('... and the shell keeps working', await waitFor(async () => /^STILL_OK$/m.test(await scr2())));

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
