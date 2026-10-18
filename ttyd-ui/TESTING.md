# Manual test checklist (Phase 1)

Run after `docker compose up -d --build ttyd`. Tick each box.

## Tabs and sessions
- [ ] Page loads, one tab, shows `login as:`, dot turns green.
- [ ] Alt+T and `+` open new tabs; each shows its own `login as:` prompt.
- [ ] Log in to each tab and run `echo $$` and `tty`: **different PIDs and different ttys** (independent sessions).
- [ ] Type in tab A while tab B runs `ping localhost`/`top`: B keeps updating in the background.
- [ ] Alt+1..9, Alt+Left/Right switch tabs and focus the terminal. Keys do not echo into the shell.
- [ ] Double-click a title: rename works. Rename sticks while the terminal title changes. Rename to empty: follows the terminal title again.
- [ ] Tab title otherwise follows the terminal title (e.g. `user@host: ~/dir` after `cd`).
- [ ] Closing a connected tab (x or Alt+W) asks for confirmation; Cancel keeps it; OK closes it and its `ssh` process ends (`docker exec ttyd ps aux | grep ssh`).
- [ ] Closing the last tab opens a fresh one. Reloading/closing the browser tab with sessions open asks for confirmation.

## Resize / fit
- [ ] Resize the browser window: terminal refits; `stty size` matches what you see (also after resizing while another tab is active, then switching back).
- [ ] `vim`/`htop` redraw correctly after a resize.
- [ ] Zoom the browser (Ctrl +/-): still fits.

## Reconnect
- [ ] `docker restart ttyd` (host): all tabs go amber "reconnecting", then green on their own, with a "new session" notice and a new login prompt.
- [ ] `docker stop ttyd` for ~2.5 minutes: tabs end up red "closed"; `docker start ttyd`, then click the reconnect button: back to green.
- [ ] `exit` in a tab: red "closed", no auto-retry; pressing Enter starts a new session.
- [ ] Reconnect button on an amber tab retries immediately.

## Touch copy / paste / links (phone, ideally over plain http)

- [ ] Key bar: Select, then drag over text selects it; tapping a word selects the word; Copy puts it on the clipboard (toast "Copied") or, if blocked, opens a box with the text selected.
- [ ] Paste without https opens a box: long-press, Paste, Send writes it to the terminal.
- [ ] Links lists the URLs in the output (also ones wrapped over several lines); Open starts a new browser tab, Copy copies.

## Clipboard (must not regress vs stock ttyd)
- [ ] Selecting text copies it (paste it in another app to confirm).
- [ ] Ctrl+Shift+C copies the selection (browser dev-tools must NOT open). Ctrl+C still interrupts.
- [ ] Ctrl+V and Ctrl+Shift+V each paste once (not twice). Ctrl+Alt+V sends a literal ^V (`cat -v`, press it: shows `^V`).
- [ ] Right-click pastes (https/localhost); the browser may ask for clipboard permission the first time.
- [ ] Multi-line paste, raw: run `cat -A`, paste 3 lines, Ctrl+D. Expect `line$` per line, **no `^[[200~`, no `^M`, no blank lines between**.
- [ ] Multi-line paste at a bash prompt: lines are inserted/executed once each, no stray characters.
- [ ] Multi-line paste in `vim` insert mode (`:set paste` off and on): no `200~`/`201~` garbage.
- [ ] Text with tabs, unicode and a trailing newline pastes unchanged.

## Network paths
- [ ] Behind a reverse proxy over https (e.g. Traefik): everything above; the websocket upgrade works.
- [ ] LAN `http://<host-ip>:7681`: loads, connects (relative ws URL), Ctrl+Shift+V works; right-click falls back to the browser menu.
- [ ] Tailscale `http://<tailscale-ip-or-name>:7681`: same as LAN.
- [ ] DevTools Network tab shows no request to any external host.

## Heavy output
- [ ] `seq 1 5000000` and `yes | head -c 200M`: the page stays responsive, output finishes, the other tab stays usable.

## Phone (real device)
- [ ] Tab bar scrolls horizontally with a swipe; `+` stays visible at the right; the active tab is scrolled into view.
- [ ] Terminal fills the screen without page scrolling; opening the on-screen keyboard shrinks the terminal (it does not hide the prompt).
- [ ] Buttons (+, x, reconnect) are easy to tap; double-tap on a title renames.
- [ ] Rotate the device: terminal refits.
- [ ] Switching to another app and back: dropped tabs reconnect.
- [ ] Note: no Alt key on mobile; use the buttons. The on-screen key bar (Phase 4a) covers Esc/Ctrl/Tab/arrows.

# Phase 2 manual checklist (persistence)

Run after `docker compose up -d --build ttyd` (this ends open sessions once).

## Persistence
- [ ] Open 2-3 tabs, log in to each (`login as:` then the SSH password), run `echo $$` in each and start `top` in one.
- [ ] Reload the page (F5): the same tabs, titles and active tab come back, **no login prompt**, `top` is still running,
      `echo $$` gives the same PID as before.
- [ ] Close the browser completely, reopen the URL: same result.
- [ ] Phone: lock the screen for a few minutes / switch apps, return: the tab reconnects (amber, then green) to the same shell.
- [ ] Pull the network (Wi-Fi off 20 s, on): tabs go amber, then green, same shell.
- [ ] Rename a tab, reload: the name is kept.

## Closing and orphans
- [ ] Close a tab with `x`: confirm dialog; afterwards `docker exec ttyd tmux -L ttyd ls` no longer lists it and its command is gone.
- [ ] Open a tab, then clear site data (or use a private window) and open the URL: the new window has a fresh tab; the `=` button
      lists the old sessions. **Attach** brings one back (same shell); **Kill** removes one.
- [ ] `exit` in a tab: "closed", no auto-retry; Enter starts a fresh session (new `login as:`).

## Takeover
- [ ] Open the same URL on a second device/window: it attaches the same sessions; the first window shows
      "closed - press Enter to reattach"; Enter there takes it back.

## Container restart
- [ ] `docker restart ttyd`: all tabs go amber then green on their own, each with a fresh `login as:` (sessions were lost, as documented).
      Reload afterwards still restores all tabs.

## tmux transparency (all of these must look the same as without tmux)
- [ ] No tmux status bar, no green bar, no unexpected key handling (C-b works inside an inner tmux/readline).
- [ ] Tab titles follow the terminal title (`user@host: ~/dir` after `cd`, and e.g. vim's title).
- [ ] `printf '\033[38;2;255;100;0mTRUECOLOR\033[0m\n'` is orange.
- [ ] `vim`, `htop`, `less`: draw correctly, resize correctly, colours right; Esc is instant in vim.
- [ ] Mouse wheel scrolls history (`seq 1 500`), stops at the bottom by itself; typing returns to the prompt, nothing leaks
      into the command line.
- [ ] Mouse wheel inside `less`/`man`/`vim` scrolls the application (arrow keys), not tmux history; it never leaves stray
      characters in the shell afterwards.
- [ ] Selecting text copies it; Ctrl+Shift+C / Ctrl+Shift+V work; multi-line paste: run `cat -A`, paste 3 lines, press Ctrl+D twice:
      `line$` per line, **no `^[[200~`, no `^M`, no blank lines**.
- [ ] Large paste (a few hundred lines of text into `cat > /tmp/x`): `wc` matches the source.
- [ ] https only: `printf '\033]52;c;%s\a' "$(printf hello | base64)"` puts `hello` on your clipboard (also from inside `ssh host` + tmux/vim).

## Security spot checks
- [ ] `curl -s "http://<host>:7681/token"` works; opening `ws://<host>:7681/ws?arg=attach&arg=x;id` (or any invalid argument)
      shows `ttyd-session: invalid request` and creates nothing (`docker exec ttyd tmux -L ttyd ls`).

# Automated tests (Phases 1-3a)
`sh test/run-p3.sh` runs everything below plus the Phase 3a browser test (34 checks) and `e2e-p3b.mjs` (30 checks: saved hosts menu, key-only protocol, persistence, hosts file edits, attacks on the host argument). 3a: (links, badges, scrollback search incl. XSS and result cap,
capture whitelist; wrapper whitelist is now 43 cases), 3b is `e2e-p3b.mjs` and 3c is `e2e-p3c.mjs` (62 checks: split right/down, directional focus, limit, divider drag + refit, reload keeps layout and shells, close pane/tab kills the right sessions, search per pane, tab state, badges, hostile saved layouts, host inheritance, phone width). `e2e-p4.mjs` (49 checks: key bar bytes/modifiers/touch layout, palette, snippets incl. corrupt storage, broadcast). `e2e-p4b.mjs` (11 checks, trzsz upload/download through tmux with stubbed pickers; skipped unless `TRZSZ_DIR` points at a directory holding the trz and tsz binaries). Last run: 43/43, 39/39, 51/51, 34/34, 30/30, 62/62, 49/49, 11/11. Manual only: the real native pickers on desktop Chrome over https, and trz/tsz against a real SSH host. Manual: dividers by touch on a real phone, Alt+\\ / Alt+- / Alt+Shift+Arrows on your keyboard layout and browsers (some browsers or layouts may claim them). Manual: hover/click a
link on a real device, bell badge from a real `printf '\a'` or build tool, Ctrl+Shift+F not intercepted by your browser.

`sh test/run-p2.sh` (from the `ttyd` directory containing the Dockerfile): builds the image, starts a throwaway container on
127.0.0.1:7683 with `/login.sh` replaced by a plain shell (so no SSH), runs the wrapper whitelist test (24 cases) and the
browser test (51 checks: persistence, takeover, orphans, kill-on-close, titles/truecolor/OSC52/wheel/paste through tmux, large
pastes, container restart with concurrent reattach, corrupt localStorage, whitelist driven through the real websocket path).
It needs `node` >= 18 and playwright-core with chromium resolvable from `ttyd-ui/` (`npm i playwright-core && npx playwright-core install chromium`).
It never touches the real `ttyd` service. Last run: 24/24 and 51/51, repeated, plus the 39 Phase 1 checks on the same stack.

# Phase 1 automated run (optional)
The browser test used during development (39 checks: tabs, independence, shortcuts, rename, fit, paste,
close-confirm, container-restart reconnect, exit handling, mobile layout) runs against a throwaway ttyd:
```
docker run -d --rm --name ttyd-ui-test -p 127.0.0.1:7682:7682 -v "%CD%\dist:/ui:ro" tsl0922/ttyd:1.7.7 ttyd -W -p 7682 -I /ui/index.html bash
npm i playwright-core && npx playwright-core install chromium
SHOT_DIR=. node test/e2e.mjs
docker stop ttyd-ui-test
```
(Replace `%CD%` with `$PWD` on Linux.) It uses a bash container, so it does not exercise `/login.sh`/SSH.

## UI polish (themes, close button, tab bar)
Automated: `test/e2e-p5.mjs` (part of `run-p3.sh`). By eye:
- [ ] Alt+P, "theme": pick each preset; the bar, tabs, terminal and scrollbar all change together, no white scrollbar on dark themes.
- [ ] Reload: the theme stays. A second browser keeps its own theme.
- [ ] Split a tab: each pane's x sits beside the scrollbar, not on top of it. Single pane: no extra gap on the right.
- [ ] Double-click the empty part of the tab bar: new tab. Double-click a tab: rename, no new tab.
