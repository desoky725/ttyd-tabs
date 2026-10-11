// Generates the README screenshots from a throwaway container (bash login, nothing from a real setup).
//   BASE=http://127.0.0.1:7683/ OUT=docs/screenshots node test/screenshots.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:7683/';
const OUT = process.env.OUT || 'docs/screenshots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };

// Demo helpers (colourful output) installed in the throwaway container so the typed commands stay short.
const CT = process.env.CONTAINER;
if (CT) {
  const put = (name, body) => execSync(`docker exec -i ${CT} sh -c 'cat > /usr/local/bin/${name} && chmod +x /usr/local/bin/${name}'`, { input: body });
  put('status', "#!/bin/sh\nprintf '\\033[1;32mOK\\033[0m    build passed\\n\\033[1;33mWARN\\033[0m  2 deprecations\\n\\033[1;31mFAIL\\033[0m  0 failures\\n'\n");
  put('colors', "#!/bin/sh\nfor i in 0 1 2 3 4 5 6 7; do printf \"\\033[4${i}m    \\033[0m\"; done; echo\nfor i in 0 1 2 3 4 5 6 7; do printf \"\\033[10${i}m    \\033[0m\"; done; echo\n");
  put('workers', "#!/bin/sh\nfor i in 1 2 3 4 5 6; do printf '\\033[2m12:00:0%s\\033[0m worker-%s \\033[32mready\\033[0m\\n' $i $i; done\n");
}

const browser = await chromium.launch();

async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 }, ...opts });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await waitFor(() => page.evaluate(() => window.tabs && window.tabs.active && window.tabs.active.session.state === 'connected'));
  await sleep(500);
  return page;
}
const run = async (page, cmd, wait = 350) => { await page.keyboard.type(cmd); await page.keyboard.press('Enter'); await sleep(wait); };
const rename = (page, i, title) => page.evaluate(([i, t]) => { const tab = window.tabs.tabs[i]; tab.title = t; tab.userRenamed = true; window.tabs._render(tab); }, [i, title]);
const theme = (page, id) => page.evaluate((id) => window.tabs.setTheme(id), id);
const clear = (page) => run(page, 'clear', 300);

const SCENE = [
  'uname -sr',
  'ls --color=always -l /etc | head -7',
  'status',
  'colors',
];
const scene = async (page) => { for (const c of SCENE) await run(page, c, 250); };

// ---- 1. tabs + default theme
{
  const page = await open();
  await scene(page);
  await page.keyboard.press('Alt+t'); await sleep(900);
  await run(page, 'echo second tab: its own shell and its own tmux session');
  await page.keyboard.press('Alt+t'); await sleep(900);
  await run(page, 'ls /usr');
  await rename(page, 0, 'web: build'); await rename(page, 1, 'db: logs'); await rename(page, 2, 'monitor');
  await page.evaluate(() => window.tabs.activate(window.tabs.tabs[0].id));
  await sleep(500);
  await page.screenshot({ path: OUT + '/tabs.png' });

  // ---- 2. themes (same scene, four presets)
  for (const [id, file] of [['nord', 'theme-nord'], ['solarizedlight', 'theme-solarized-light'], ['tokyonight', 'theme-tokyo-night'], ['gruvbox', 'theme-gruvbox']]) {
    await theme(page, id); await sleep(400);
    await page.screenshot({ path: `${OUT}/${file}.png` });
  }
  await theme(page, 'dracula'); await sleep(300);

  // ---- 3. command palette
  await page.keyboard.press('Alt+p'); await sleep(200);
  await page.keyboard.type('the'); await sleep(300);
  await page.screenshot({ path: OUT + '/palette.png' });
  await page.keyboard.press('Escape');

  // ---- 4. scrollback search
  await run(page, 'seq 1 30 | sed "s/^/request /; s/$/ served/"; echo deploy finished: all checks passed', 600);
  await page.keyboard.press('Control+Shift+F'); await sleep(300);
  await page.keyboard.type('passed'); await page.keyboard.press('Enter'); await sleep(1200);
  await page.screenshot({ path: OUT + '/search.png' });
  await page.keyboard.press('Escape');
  await page.context().close();
}

// ---- 5. split panes
{
  const page = await open();
  await run(page, 'ls --color=always -l /etc | head -10');
  await page.keyboard.press('Alt+Backslash'); await sleep(1200);
  await run(page, 'workers');
  await page.keyboard.press('Alt+Minus'); await sleep(1200);
  await run(page, 'ls --color=always -l /usr | head -8');
  await rename(page, 0, 'project');
  await sleep(500);
  await page.screenshot({ path: OUT + '/split.png' });
  await page.context().close();
}

// ---- 6. phone + key bar
{
  const page = await open({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  // headless Chromium's software WebGL paints nothing at 2x density; real phones have a GPU. Use the DOM renderer here.
  await page.evaluate(() => { const s = window.tabs.active.session; s.webglFailed = true; s._disableWebgl(); });
  await run(page, 'status');
  await run(page, 'ls --color=always -l /etc | head -8');
  await sleep(600);
  await page.screenshot({ path: OUT + '/mobile.png' });
  await page.context().close();
}

await browser.close();
console.log('screenshots written to ' + OUT);
