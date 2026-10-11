# ttyd-ui: multi-tab, persistent web terminal on top of ttyd

A single self-contained `index.html` that replaces ttyd's stock frontend, plus a small server-side wrapper.
ttyd stays the backend (websocket + one process per connection); the ttyd binary is untouched.

- **Phase 1:** tabs, each with its own xterm.js and websocket = an independent session.
- **Phase 2:** each tab is a **tmux session** in the container. Reload the page, lose the network, put the
  phone to sleep: the tab comes back attached to the same shell. Closing a tab kills its session. A Sessions view
  lists and re-attaches orphans.
- **Phase 3:** bell/activity badges, clickable links, tmux scrollback search; saved hosts (`hosts.conf`); split panes.
- **Phase 4:** touch key bar, command palette + snippets, broadcast input, trzsz file transfer (with limits, see below).
- **UI polish:** colour themes (8 presets, command palette), scrollbars that follow the theme, split-pane close button beside the scrollbar, double-click on the empty tab bar opens a tab.
- Not built: Phase 5, `docker exec` hosts (needs a decision: docker socket vs. ssh to the host).

Git tags (roll back / compare with `git diff <tag> <tag>`): `ttyd-ui-phase2` (phases 1+2),
`-phase3a`, `-phase3b`, `-phase3c`, `-phase4a`, `-phase4b`, `-phase4` (= 4a+4b), and `ttyd-ui-v1` (the deployed release).

Versions: ttyd `tsl0922/ttyd:1.7.7` (pinned), xterm.js 5.5.0, addon-fit 0.10.0, addon-webgl 0.18.0, addon-web-links 0.11.0, trzsz.js 1.1.6 (vendored in
`vendor/`, checksums in `vendor/SHA256SUMS`, verified by the build). tmux is the Ubuntu 20.04 package (3.0a).
No runtime CDN; all URLs are relative, so domain, LAN and Tailscale all work.

## How it fits together
```
browser tab  --ws /ws?arg=attach&arg=<id>-->  ttyd -a  -->  ttyd-session attach <id>
                                                              -> tmux -L ttyd new-session (if missing) + attach -d
                                                                   -> /login.sh  (asks "login as:", then ssh to the host)
Sessions panel / tab close --ws ?arg=list | ?arg=kill&arg=<id> --> ttyd-session list | kill <id>
```
- Tab id = `t` + 10 hex chars, kept in localStorage (`ttyd-ui.tabs.v1`) and used as tmux session `ttyd-<id>`.
- tmux runs on its **own socket** (`-L ttyd`) with its own config, so it never touches other tmux servers.
- tmux is invisible: no status bar, **no prefix key** (so C-b etc. reach nested tmux/vim untouched), `escape-time 0`,
  mouse off (native selection and copy), titles passed through, truecolor, OSC 52 clipboard, 50000-line history.

## Files
```
ttyd/Dockerfile            pinned ttyd + openssh-client + tmux + the three files below
ttyd/login.sh              unchanged: "login as:" then ssh to the host
ttyd/ttyd-session          the ONLY thing ttyd runs: whitelisted attach / kill / capture / hosts / list
ttyd/ttyd-tmux.conf        the invisible-tmux config
ttyd/hosts.conf            saved hosts (mounted at /etc/ttyd-hosts)
ttyd/ttyd-ui/
  src/session.js           one xterm + one websocket (the only file that knows the ttyd protocol)
  src/layout.js            split-pane tree (pure functions: validate, split, remove, rects, neighbour)
  src/themes.js            colour presets (terminal colours + page chrome as CSS variables)
  src/store.js             saved tab list + layouts (localStorage)
  src/control.js           list/kill/capture/hosts over a short websocket + the Sessions panel
  src/search.js, hosts.js  scrollback search panel, "+" host menu
  src/keybar.js, palette.js  touch key bar; command palette + snippets
  src/tabs.js, main.js, app.css, index.template.html
  vendor/, build.mjs       pinned libs; inlines everything into dist/index.html
  dist/index.html          GENERATED, mounted into the container at /ui
  test/                    automated tests (see TESTING.md)
```

## Security: the wrapper is a whitelist
With `ttyd -a`, **anyone who can reach port 7681 can pass arbitrary `?arg=` values** (ttyd appends them to argv).
`ttyd-session` therefore accepts exactly these forms and rejects everything else with exit 2 and no output:
`attach <id> [host]`, `kill <id>`, `capture <id>`, `hosts`, `list`, where `<id>` is exactly `t` + 10 lowercase hex digits. Input is only matched
by `case` patterns and, once validated, used as an argv element for tmux (no shell, no `eval`).
`test/wrapper-whitelist.sh` and the browser test attack it with `;`, `$()`, backticks, newlines, `..`, globs,
extra arguments and over/under-long ids.

Unchanged and worth knowing: port 7681 is published on the host with no ttyd-level auth. The SSH login inside the
session is the only gate to your host, as before. A visitor who can reach the port can also `list`/`kill` tmux
sessions, and can attach to / read the scrollback (`capture`) of a session whose id they know (ids are 40-bit random,
but `list` shows them to anyone who can reach the port, so treat this as: anyone who can reach port 7681 can use your sessions). If that matters, put auth in front (Traefik forward-auth) or stop publishing the port.

## Build (Node >= 18, no npm install)
Linux: `cd ttyd-ui && node build.mjs`  Windows CMD: `cd /d C:\path\to\ttyd-ui` then `node build.mjs`.
Output: `dist/index.html` (~557 KiB).

## Deploy and rollback
The published image has the UI baked in (see the top-level README). To run your own build: `docker build -t ttyd-tabs .` in the repo root.
Recreating the container ends every open session (tmux lives inside it). While developing the UI you can instead mount
the built file over the baked one: `-v $PWD/ttyd-ui/dist:/ui:ro`, run `node ttyd-ui/build.mjs` after each change and reload the
page; no container restart needed.

To go back to an earlier version, check out its git tag and rebuild the image.

## Usage
| Action | Keys / UI |
|---|---|
| New tab | Alt+T, or `+` |
| Close tab (kills its session) | Alt+W, or `x` on the tab (asks first if connected) |
| Jump to tab N | Alt+1..9 |
| Previous / next | Alt+Left / Alt+Right |
| New tab | also: double-click the empty part of the tab bar |
| Colour theme | Alt+P, type `theme`: Dracula (default), Tokyo Night, Nord, Gruvbox Dark, One Dark, Solarized Dark / Light, GitHub Light. Saved per browser (`ttyd-ui.theme.v1`), applied to all open terminals at once |
| Rename | double-click the title (double-tap on touch); empty = follow the terminal title again |
| Copy | select text (copies on select), or Ctrl+Shift+C |
| Paste | Ctrl+V, Ctrl+Shift+V, or right-click |
| Literal `^V` (shell quoted-insert, vim visual-block) | Ctrl+Alt+V |
| Scroll history | mouse wheel (scrolls tmux's history; any key returns to the prompt) |
| New tab on a saved host | `+` (menu appears when `hosts.conf` has entries; Alt+T always opens the default login) |
| Search scrollback | Ctrl+Shift+F, or the magnifier button: greps the active tab's tmux history (snapshot, newest first, max 300 shown); Esc closes |
| Open a link | click an http(s) URL in the terminal (opens a new tab, no opener) |
| Split pane right / down | Alt+\\ / Alt+- , or the two split buttons (max 4 panes per tab) |
| Move between panes | click, or Alt+Shift+Arrows |
| Close the focused pane | Alt+Shift+W, or the x in its corner (Alt+W / the tab x closes the whole tab) |
| Resize panes | drag the divider (kept between 10% and 90%, saved) |
| Command palette | Alt+P or the command button: actions, hosts, tabs, snippets; type to filter, Enter runs |
| Broadcast input | Alt+B marks/unmarks the tab (red); typing in any marked tab goes to every pane of every marked tab |
| Key bar | keyboard button (auto-shown on touch screens): Esc Tab Ctrl Alt arrows Home End PgUp PgDn | ~ / \ - _ ` : Paste |
| Reconnect | the reconnect button on the tab, or Enter in an ended tab |
| Sessions on the server not open here | the `=` button (top right): Attach or Kill |

Tab dot: green = connected, amber = connecting/reconnecting, red = closed.
Background-tab badge after the title: amber = new output, red pulsing = bell. Cleared when you open the tab. Output in the
first 1.5 s after (re)attach is not counted (it is tmux repainting the screen).

Why search is server-side: under tmux the browser's own scrollback is empty, so `addon-search` would find nothing.
`ttyd-session capture <id>` dumps `tmux capture-pane` (history + screen, plain text) over the same control websocket as `list`.
Vendored: fit 0.10.0, webgl 0.18.0, web-links 0.11.0, trzsz.js 1.1.6 (checksummed in `vendor/SHA256SUMS`).

## Behaviour you should know about
- **Reload / reconnect reattaches.** The tab list, titles and active tab are restored from localStorage and each tab
  re-attaches to its tmux session (same shell, same running programs, screen repainted). No password prompt, since the
  SSH connection inside tmux stayed up.
- **Closing a tab kills its session** (and its running command). Closing the browser/page does not.
- **Container restart or redeploy ends all sessions** (tmux lives in the container). Tabs reconnect on their own and
  get fresh sessions with a new `login as:`. The localStorage tab list is per origin: tabs opened via the domain, the
  LAN IP and Tailscale are separate lists; the Sessions panel lets any of them pick up the others' sessions.
- **Takeover:** attaching a session from a second window detaches the first, which shows "closed - press Enter to
  reattach" (Enter takes it back). Newest window wins and gets its full size.
- **Shell exit** (`exit`, or the SSH session ending) ends the session: the tab shows "closed", no auto-retry, Enter starts
  a new one. A dropped network connection auto-reconnects (backoff 1s..15s, 10 tries, then use the reconnect button).
- **Scrolling:** tmux uses the alternate screen, so the browser's own scrollback is empty. The wheel is turned into
  keys that tmux interprets (3 lines per step, paced 8 ms apart): on the normal shell screen it enters tmux copy-mode and
  scrolls the 50000-line history (leaves by itself at the bottom; typing also returns you to the prompt); while a
  full-screen app owns the screen (`less`, `man`, `vim`...) it sends that app Up/Down arrows, as plain xterm.js would.
  Scrollback search therefore asks the server (`capture`) instead of using xterm's search addon.
- **No tmux prefix key** by design; tmux windows/panes are not available (splits are done by the UI, one tmux session per pane).
- **Right-click paste** needs a secure context (https or localhost); on plain-http LAN/Tailscale it falls back to the
  browser's own menu, and Ctrl+Shift+V works everywhere. **OSC 52 remote copy** (e.g. vim/tmux `set-clipboard`) also needs
  https; programs can only *write* the clipboard, never read it.
- **Alt+Left/Right and Alt+1..9** are captured by the page and no longer reach the shell/readline.
- Only the visible tab uses WebGL; background tabs use the DOM renderer and keep receiving output.
- Port 7681 auth: see Security above.

## Two upstream quirks the design works around (so you don't re-discover them)
1. **ttyd 1.7.7 sometimes reports a clean exit as an abnormal close** (it reads the exit status before the reaper thread
   stores it). With tmux that hit ~1 in 4. `ttyd-session` closes its stdio and lingers 0.3 s before exiting, so ttyd sees
   EOF while the process is still running; measured 40/40 clean exits afterwards. The same linger lets `list` finish
   printing before the socket closes.
2. **tmux 3.0a mishandles escape sequences that arrive back-to-back** (only the first ~2 are treated as keys, the rest
   leak into the shell as text, e.g. `;3~;3~`). The wheel keys are therefore queued 8 ms apart (2 ms is enough).
   `escape-time` stays 0; a 20-59 KB bracketed paste through tmux was tested repeatedly with no stray `200~`/`201~`.

## Saved hosts (Phase 3b)
`ttyd/hosts.conf` is mounted read-only at `/etc/ttyd-hosts` (compose volume). One host per line: `key | label | command`
(see the file for the rules and examples). The `+` button shows a menu: "Default (login)" (= `/login.sh`, as before) plus
your hosts. The page learns only `key` and `label` (`ttyd-session hosts`); a new tab sends `attach <id> <key>` and the
wrapper runs the command it finds in the file, so a visitor to port 7681 can run only what you wrote there. Keys are
`[a-z0-9_-]{1,32}` and must exist in the file; anything else exits 2. The key is only used when the tmux session is
*created*; reattaching an existing session ignores it (but an unknown key is still refused). Edit the file and the next
menu open picks it up (no rebuild, no restart). The host is stored with the tab, so reloads reattach to the same session;
if the container restarted and you later removed that key from the file, the tab cannot start again: close it.
Commands run through `sh -c` inside tmux as the container user, so for SSH hosts either type the password in the tab or
mount a key into the container (not done here). `docker exec` hosts are deliberately not offered (see Phase 5 in the roadmap:
needs a decision about the docker socket vs. ssh to the host).

## Split panes (Phase 3c)
Each pane is its own `Session` and its own tmux session (`ttyd-<id>`), so everything from Phase 2 applies per pane: reload
reattaches every pane to its own shell, closing a pane kills only its session, a tab with N panes holds N server sessions.
tmux itself is still invisible and never splits anything: the layout is a small tree (`src/layout.js`) kept in the browser
(localStorage, validated on load with the same id/host rules as the server whitelist, max 4 panes, max depth 3). The tab
title follows the focused pane, the tab dot shows the worst pane state, the tab badge fires for output/bell in any pane of
a background tab, and scrollback search covers the focused pane. A new pane inherits the saved host of the pane you split.
The Sessions panel counts panes of open tabs as open (never as orphans). Only the active tab's panes use WebGL.
Layouts are per browser origin, like the tab list, so the domain, LAN and Tailscale URLs each have their own.

## Phase 4a: key bar, palette + snippets, broadcast
- **Key bar:** buttons never take focus, so the phone keyboard stays up. Ctrl and Alt are one-shot (tap, then press one key; tap again to cancel).
  Arrows follow the app's cursor-key mode. Keys go through the same path as the keyboard (so tmux maps them like real keys, e.g. Home -> `ESC[1~`).
  On phone widths the split/search/key-bar buttons are hidden from the top bar and live in the palette.
- **Snippets** are stored in this browser (`ttyd-ui.snippets.v1`, per origin). Choosing one *pastes* it into the focused pane; "run" snippets also press Enter.
  Add/delete from the palette (`Snippet: add...` uses simple prompts). Nothing is sent unless you pick it. Max 100 snippets, 20 kB each.
- **Broadcast** is never saved (off after reload) and asks for confirmation when you mark a tab. It mirrors typed text, paste, snippets and key-bar keys,
  not mouse-wheel scrolling. Marked tabs have a red underline and a red frame around their panes.

## Phase 4b: trzsz file transfer (`trz` upload / `tsz` download)
Each session passes its websocket traffic through trzsz.js's `TrzszFilter` (vendored 1.1.6, MIT). It does nothing until a
`trz`/`tsz` command on the server prints its marker; then the browser asks for files and speeds the transfer over the same
websocket (no extra endpoint, ttyd unchanged). **Read the limits before relying on it:**
- **Browser:** trzsz.js uses the File System Access API (`showOpenFilePicker` / `showDirectoryPicker`): desktop Chrome/Edge, and
  only on https or localhost. Plain-http LAN/Tailscale URLs, Firefox, Safari and phones get trzsz's own error message
  ("requires HTTPS" / "doesn't support"), and the shell keeps working. Your public https domain is the place to use it.
- **Server:** `trz`/`tsz` ([trzsz-go](https://github.com/trzsz/trzsz-go/releases)) must exist where you run them. They are *not* in the
  image (the default login just ssh-es away). Install them on the machines you SSH into, or add the binaries to `ttyd/Dockerfile`.
- **tmux in the middle:** tmux re-renders pane output, so trzsz needs to know about it (it reads `$TMUX` and calls `tmux`). Measured
  here: run **inside the container's own shell** (where `$TMUX` is set) upload (700 kB) and download (300 kB) are byte-exact (sha256),
  12/12 runs. Run on an **SSH host** (no `$TMUX` there) a simulation gave a good upload but a corrupted download (a Go panic in
  `tsz`, `-B` chunk sizes did not help). That case is NOT solved; I have not tried it against a real SSH host. If you need
  downloads from SSH hosts, the dependable route is a different path for the file (scp/sftp), or stop using the tmux layer for that host.
- Dragging files onto the terminal is not wired up (it would type into whatever is running).

## Themes
Each preset in `src/themes.js` has the terminal's 16 colours plus the page chrome (bar, tabs, accent...), which become CSS variables on `<html>`;
`color-scheme` is set per theme so the native scrollbar matches. To add one, copy an entry in `THEMES` (the palette lists them automatically).
The `-t theme=` flag in compose is ignored by this client: it owns theme and font.
