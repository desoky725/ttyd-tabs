'use strict';
/*
 * Session = one xterm.js terminal + one websocket to ttyd (= one independent process/SSH session).
 * This is the ONLY file that knows the ttyd wire protocol (verified against ttyd 1.7.7,
 * html/src/components/terminal/xterm/index.ts and src/protocol.c):
 *
 *   handshake (client -> server, text frame): {"AuthToken": <token>, "columns": c, "rows": r}
 *   client -> server frames: '0'+input  '1'+{"columns","rows"}  '2' pause  '3' resume
 *   server -> client frames: '0'+output '1'+title              '2'+{prefs JSON} (ignored here)
 */

const CMD = { OUTPUT: '0', TITLE: '1', PREFS: '2', INPUT: '0', RESIZE: '1', PAUSE: '2', RESUME: '3' };
// Same numbers as stock ttyd.
const FLOW = { limit: 100000, highWater: 10, lowWater: 4 };
// Keys bound in ttyd-tmux.conf (Alt+PageUp / Alt+PageDown / Alt+End), see _onWheel.
const TMUX_KEY = { up: '\x1b[5;3~', down: '\x1b[6;3~', cancel: '\x1b[1;3F' };
const RETRY = { baseMs: 1000, maxMs: 15000, maxAttempts: 10 };

const FONT = '"JetBrains Mono","Fira Code","Cascadia Mono",Consolas,"Liberation Mono",Menlo,monospace';

// All URLs are relative to the page, so domain / LAN / Tailscale / a Traefik sub-path all work.
function ttydUrls(query) {
  const path = location.pathname.replace(/\/+$/, '');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return { ws: proto + '//' + location.host + path + '/ws' + (query || ''), token: path + '/token' };
}

class Session {
  /**
   * @param {HTMLElement} el   container the terminal is opened in (must be in the DOM)
   * @param {object} cb        { onState(state), onTitle(title), onNotice(text) }
   * @param {object} [opts]    { query: '?arg=..' (passed to the ttyd-session wrapper via ttyd -a),
   *                           persistent: true when the server keeps the session in tmux, fontSize }
   * state: 'connecting' | 'connected' | 'reconnecting' | 'closed'
   */
  constructor(el, cb, opts = {}) {
    this.el = el;
    this.cb = cb;
    this.query = opts.query || '';
    this.persistent = !!opts.persistent;
    this.wheelAcc = 0;
    this.mods = { ctrl: false, alt: false };  // one-shot modifiers armed from the on-screen key bar
    this.keyQueue = [];  // pending scroll key sequences, see _drainKeys
    this.keyTimer = null;
    this.scrolled = false; // we sent a wheel-scroll into tmux copy-mode and have not cancelled it
    this.state = 'connecting';
    this.active = false;   // visible (its tab is the active tab)
    this.focused = true;   // the focused pane of its tab (gets keyboard focus)
    this.ws = null;
    this.gen = 0; // bumped on every connect/close; events from older sockets are ignored
    this.attempt = 0;
    this.timer = null;
    this.opened = false; // has this session ever connected?
    this.openedAt = 0;
    this.token = '';
    this.written = 0;
    this.pending = 0;
    this.webgl = null;
    this.webglFailed = false;
    this.enc = new TextEncoder();

    this.term = new Terminal({
      fontSize: opts.fontSize || 14,
      fontFamily: FONT,
      theme: Themes.current().term,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
    });
    this.fitAddon = new FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);
    // Clickable links: http(s) only, opened in a new tab without access to this page.
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon((ev, uri) => {
      if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
    }));
    this.term.open(el);

    const term = this.term;
    // OSC 52 = "set clipboard" (e.g. vim/tmux copy). Own handler instead of xterm's clipboard addon, because
    // tmux sends an EMPTY selection field ("52;;<base64>") which that addon ignores. Writes only: a request
    // to READ the clipboard ("?") is never answered, so programs in the terminal cannot read it.
    term.parser.registerOscHandler(52, (data) => {
      const pd = data.slice(data.indexOf(';') + 1);
      if (data.indexOf(';') < 0 || !pd || pd === '?' || pd.length > 1400000) return true;
      try {
        const text = new TextDecoder().decode(Uint8Array.from(atob(pd), (c) => c.charCodeAt(0)));
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
        else this.cb.onNotice('Remote copy needs https (clipboard API unavailable here).');
      } catch (e) { /* bad base64 */ }
      return true;
    });
    // trzsz (trz / tsz file transfer): a filter between the websocket and the terminal. Normal output and input pass
    // straight through; only a trz/tsz run on the server (its marker text) switches it to transfer mode.
    this.trzsz = new TrzszFilter({
      writeToTerminal: (d) => this._termWrite(typeof d === 'string' ? d : new Uint8Array(d)),
      sendToServer: (d) => (typeof d === 'string' ? this._send(CMD.INPUT, d) : this._sendBytes(CMD.INPUT, new Uint8Array(d))),
      terminalColumns: term.cols,
    });
    term.onData((d) => {
      if (this.state === 'closed') {
        if (d === '\r') this.reconnectNow(); // Enter restarts an ended session, like stock ttyd
        return;
      }
      this.keyQueue.length = 0; // typing wins over scrolling still in flight
      if (this.scrolled) { this.scrolled = false; this._send(CMD.INPUT, TMUX_KEY.cancel); } // leave scrollback first
      d = this._applyMods(d);
      const transferring = this.trzsz.isTransferringFiles();
      this.trzsz.processTerminalInput(d);          // = send to the server, except while a file transfer owns the input
      if (this.cb.onInput && !transferring) this.cb.onInput(d);   // broadcast mirrors typed/pasted input from here
    });
    term.onBinary((s) => this.trzsz.processBinaryInput(s));
    term.onResize(({ cols, rows }) => this.trzsz.setTerminalColumns(cols));
    term.onResize(({ cols, rows }) => this._send(CMD.RESIZE, JSON.stringify({ columns: cols, rows })));
    term.onBell(() => this.cb.onBell && this.cb.onBell());
    term.onTitleChange((t) => t && this.cb.onTitle(t));
    // Copy-on-select, same mechanism as stock ttyd (xterm mirrors the selection into its textarea).
    term.onSelectionChange(() => {
      if (!term.hasSelection()) return;
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    });
    term.attachCustomKeyEventHandler((e) => this._onKey(e));
    term.attachCustomWheelEventHandler((e) => this._onWheel(e));

    // Right-click paste. Needs the async clipboard API (secure context). Without it we leave
    // xterm's own handler alone, which opens the native menu with a working "Paste".
    el.addEventListener('contextmenu', (e) => {
      if (!navigator.clipboard || !navigator.clipboard.readText) return;
      e.preventDefault();
      e.stopPropagation();
      this.pasteFromClipboard();
    }, true);

    // Touch select mode (key bar "Select"): xterm draws its own text, so there are no native selection handles.
    // While the mode is on, a finger drag selects text and a tap selects the word under it.
    this.selectMode = false;
    this._sel = null;
    const selEv = (fn) => (e) => {
      if (!this.selectMode || e.pointerType === 'mouse') return;
      e.preventDefault();
      e.stopPropagation();
      fn(e);
    };
    el.addEventListener('pointerdown', selEv((e) => {
      el.setPointerCapture(e.pointerId);
      const c = this._cellAt(e);
      this._sel = { from: c, x: e.clientX, y: e.clientY, moved: false };
    }), true);
    el.addEventListener('pointermove', selEv((e) => {
      const s = this._sel;
      if (!s) return;
      if (!s.moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 8) return;
      s.moved = true;
      this._selectRange(s.from, this._cellAt(e));
    }), true);
    const selEnd = selEv((e) => {
      const s = this._sel;
      this._sel = null;
      if (s && !s.moved && e.type === 'pointerup') this._selectWord(s.from);
    });
    el.addEventListener('pointerup', selEnd, true);
    el.addEventListener('pointercancel', selEnd, true);

    // Drop files on the pane = upload them with trzsz (types `trz` for you; the server needs trz installed).
    // Needs no file-picker API, so it works over plain http.
    const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const paneEl = () => el.closest('.leaf');
    let dragDepth = 0;
    const endDrag = () => { dragDepth = 0; const p = paneEl(); if (p) p.classList.remove('dropping'); };
    el.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; const p = paneEl(); if (p) p.classList.add('dropping'); });
    el.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    el.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) endDrag(); });
    el.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      endDrag();
      if (this.state !== 'connected') { this.cb.onNotice('Not connected.'); return; }
      this.trzsz.uploadFiles(e.dataTransfer.items).catch((err) => this.cb.onNotice('Upload failed: ' + ((err && err.message) || err)));
    });

    this.ro = new ResizeObserver(() => {
      cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(() => this.fit());
    });
    this.ro.observe(el);
  }

  /** Arm/disarm a one-shot modifier ('ctrl' | 'alt') for the next input (on-screen Ctrl/Alt keys). */
  setMod(name, on) {
    this.mods[name] = !!on;
    window.dispatchEvent(new CustomEvent('ttyd:mods'));
  }

  _applyMods(d) {
    const { ctrl, alt } = this.mods;
    if (!ctrl && !alt) return d;
    this.mods.ctrl = this.mods.alt = false;
    window.dispatchEvent(new CustomEvent('ttyd:mods'));
    if (ctrl && d.length === 1) {
      const c = d.toLowerCase().charCodeAt(0);
      if (c >= 97 && c <= 122) d = String.fromCharCode(c - 96);                 // Ctrl+A..Z
      else if (d === ' ' || d === '@') d = '\x00';
      else if (d === '[') d = '\x1b';
      else if (d === '\\') d = '\x1c';
      else if (d === ']') d = '\x1d';
      else if (d === '^') d = '\x1e';
      else if (d === '_' || d === '-') d = '\x1f';
    }
    return alt ? '\x1b' + d : d;
  }

  /** Send as if typed (goes through the same path as the keyboard: modifiers, scroll-cancel, broadcast). */
  type(text) { this.term.input(text, true); }

  /** Paste text like Ctrl+Shift+V does (bracketed paste if the app asked for it). */
  pasteText(text) { this.term.paste(text); }

  // ---- keyboard / clipboard -------------------------------------------------------------

  _onKey(e) {
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
      if (e.code === 'KeyC') {
        if (e.type === 'keydown') { e.preventDefault(); this.copySelection(); }
        return false;
      }
      // Ctrl+Shift+V: do NOT preventDefault. The browser then fires a native paste event on
      // xterm's textarea and xterm pastes it once (works on plain-HTTP origins too).
      if (e.code === 'KeyV') return false;
    }
    if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.code === 'KeyV') return false;   // Ctrl+V: native paste, same as above
    if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && e.code === 'KeyV') {
      // Ctrl+Alt+V sends the literal ^V (shell quoted-insert, vim visual-block), which plain Ctrl+V no longer does.
      if (e.type === 'keydown') { e.preventDefault(); this.term.input('\x16'); }
      return false;
    }
    return true;
  }

  // tmux runs on the alternate screen, so the browser's scrollback is empty and the wheel would be turned
  // into arrow keys. Instead, send the stateless keys bound in ttyd-tmux.conf to scroll tmux's history.
  _onWheel(e) {
    if (!this.persistent || this.term.buffer.active.type !== 'alternate' || this.term.modes.mouseTrackingMode !== 'none') return true;
    // deltaMode 0 = pixels (~17px per line), 1 = lines, 2 = pages
    const lines = e.deltaMode === 0 ? e.deltaY / 17 : e.deltaMode === 1 ? e.deltaY : e.deltaY * this.term.rows;
    this.wheelAcc += lines;
    // Each key sequence = 3 lines (see ttyd-tmux.conf). They are released one by one, 8 ms apart (see _queueKeys).
    const n = Math.min(Math.trunc(Math.abs(this.wheelAcc) / 3), 8);
    if (n === 0) return false;
    const up = this.wheelAcc < 0;
    this.wheelAcc %= 3; // keep only the sub-step remainder; distance beyond the cap is dropped
    if (up) this.scrolled = true;
    for (let i = 0; i < n; i++) this.keyQueue.push(up ? TMUX_KEY.up : TMUX_KEY.down);
    if (!this.keyTimer) this._drainKeys();
    return false;
  }

  // tmux 3.0a mishandles several escape sequences that arrive back-to-back: in a tight burst only the first
  // ~2 are treated as keys and the rest are forwarded to the shell as text (";3~;3~..."). Measured: no
  // problem from 2 ms spacing up, so scroll keys are paced at 8 ms.
  _drainKeys() {
    const k = this.keyQueue.shift();
    if (k === undefined) { this.keyTimer = null; return; }
    this._send(CMD.INPUT, k);
    this.keyTimer = setTimeout(() => this._drainKeys(), 8);
  }

  setSelectMode(on) {
    this.selectMode = !!on;
    this._sel = null;
    this.el.classList.toggle('selecting', this.selectMode);
    window.dispatchEvent(new CustomEvent('ttyd:mods'));
  }

  /** Buffer cell under a pointer event (row is an absolute buffer row, as term.select wants). */
  _cellAt(e) {
    const term = this.term;
    const r = this.el.querySelector('.xterm-screen').getBoundingClientRect();
    const clamp = (v, max) => Math.max(0, Math.min(max, v));
    return {
      col: clamp(Math.floor((e.clientX - r.left) / (r.width / term.cols)), term.cols - 1),
      row: clamp(Math.floor((e.clientY - r.top) / (r.height / term.rows)), term.rows - 1) + term.buffer.active.viewportY,
    };
  }

  _selectRange(a, b) {
    const [s, e] = a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
    this.term.select(s.col, s.row, (e.row - s.row) * this.term.cols + e.col - s.col + 1);
  }

  _selectWord(c) {
    const line = this.term.buffer.active.getLine(c.row);
    if (!line) return;
    const text = line.translateToString(false);
    if (!text[c.col] || /\s/.test(text[c.col])) return;
    let s = c.col, e = c.col;
    while (s > 0 && !/\s/.test(text[s - 1])) s--;
    while (e < text.length - 1 && !/\s/.test(text[e + 1])) e++;
    this.term.select(s, c.row, e - s + 1);
  }

  copySelection() {
    const text = this.term.getSelection();
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => document.execCommand('copy'));
    } else {
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    }
  }

  pasteFromClipboard() {
    navigator.clipboard.readText().then(
      // term.paste() normalises newlines to \r and only adds bracketed-paste markers when the
      // running app asked for them (DECSET 2004), so there are no stray characters.
      (text) => { if (text) this.term.paste(text); },
      () => this.cb.onNotice('Clipboard access denied. Use Ctrl+Shift+V to paste.')
    );
    this.term.focus();
  }

  // ---- connection -----------------------------------------------------------------------

  async connect() {
    clearTimeout(this.timer);
    const gen = ++this.gen;
    this._dropSocket();
    this._setState(this.opened ? 'reconnecting' : 'connecting');

    try {
      const r = await fetch(ttydUrls().token, { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) this.token = (await r.json()).token || '';
    } catch (e) { /* server may be down; the socket attempt below will fail and back off */ }
    if (gen !== this.gen) return;

    let ws;
    try { ws = new WebSocket(ttydUrls(this.query).ws, ['tty']); } catch (e) { this._scheduleRetry(gen); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { if (gen === this.gen) this._onOpen(); };
    ws.onmessage = (ev) => { if (gen === this.gen) this._onMessage(ev.data); };
    ws.onclose = (ev) => { if (gen === this.gen) this._onClose(ev); };
    ws.onerror = () => {}; // close always follows; handled there
  }

  _onOpen() {
    this.fit();
    if (this.opened) {
      this.term.reset(); // fresh screen: tmux repaints it on attach (or it is a new process, as in stock ttyd)
      if (!this.persistent) this.term.write('\x1b[2m[reconnected - this is a new session]\x1b[0m\r\n');
    }
    this.opened = true;
    this.openedAt = Date.now();
    this.scrolled = false;
    this.attempt = 0;
    this.written = 0;
    this.pending = 0;
    this.ws.send(this.enc.encode(JSON.stringify({ AuthToken: this.token, columns: this.term.cols, rows: this.term.rows })));
    this._setState('connected');
    if (this.active && this.focused) this.term.focus();
  }

  _onMessage(data) {
    const bytes = new Uint8Array(data);
    if (!bytes.length) return;
    const cmd = String.fromCharCode(bytes[0]);
    const payload = bytes.subarray(1);
    if (cmd === CMD.OUTPUT) this._writeOutput(payload);
    else if (cmd === CMD.TITLE) this.cb.onTitle(new TextDecoder().decode(payload));
    // CMD.PREFS ignored: the client owns theme/font.
  }

  // Flow control: identical algorithm to stock ttyd so heavy output cannot freeze the page.
  _writeOutput(data) {
    this.trzsz.processServerOutput(data);   // calls _termWrite for everything that is not file-transfer protocol
  }

  _termWrite(data) {
    // Activity = output well after (re)attach; the repaint tmux sends on attach is not "new activity".
    if (this.cb.onActivity && Date.now() - this.openedAt > 1500) this.cb.onActivity();
    this.written += data.length;
    if (this.written > FLOW.limit) {
      this.term.write(data, () => {
        this.pending = Math.max(this.pending - 1, 0);
        if (this.pending < FLOW.lowWater) this._send(CMD.RESUME, '');
      });
      this.pending++;
      this.written = 0;
      if (this.pending > FLOW.highWater) this._send(CMD.PAUSE, '');
    } else {
      this.term.write(data);
    }
  }

  _onClose(ev) {
    this.ws = null;
    if (ev.code === 1000 || this.stopped) {
      // 1000 = the process exited cleanly: the shell ended, or (persistent) another browser took this
      // session over. Do not auto-restart.
      this.term.write(this.persistent
        ? '\r\n\x1b[2m[session ended or taken over by another browser - press Enter to start/reattach]\x1b[0m\r\n'
        : '\r\n\x1b[2m[session ended - press Enter to start a new one]\x1b[0m\r\n');
      this._setState('closed');
    } else {
      if (this.attempt === 0) this.term.write('\r\n\x1b[33m[connection lost - reconnecting...]\x1b[0m\r\n');
      this._scheduleRetry(this.gen);
    }
  }

  _scheduleRetry(gen) {
    if (this.attempt >= RETRY.maxAttempts) {
      this.term.write('\r\n\x1b[31m[gave up reconnecting - use the reconnect button]\x1b[0m\r\n');
      this._setState('closed');
      return;
    }
    const delay = Math.min(RETRY.maxMs, RETRY.baseMs * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
    this.attempt++;
    this._setState('reconnecting');
    this.timer = setTimeout(() => { if (gen === this.gen) this.connect(); }, delay);
  }

  /** Manual reconnect / retry-now. Always starts a NEW process on the server. */
  reconnectNow() {
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  _dropSocket() {
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(1000); } catch (e) { /* ignore */ } }
  }

  _send(cmd, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(this.enc.encode(cmd + payload));
  }

  _sendBytes(cmd, bytes) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const out = new Uint8Array(bytes.length + 1);
    out[0] = cmd.charCodeAt(0);
    out.set(bytes, 1);
    this.ws.send(out);
  }

  /** Send text as keyboard input to this session (used by later phases: key bar, broadcast, snippets). */
  sendInput(text) { this._send(CMD.INPUT, text); }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.cb.onState(s);
  }

  // ---- display --------------------------------------------------------------------------

  /** Switch the terminal colours live. */
  setTheme(term) { this.term.options.theme = term; }

  fit() {
    if (!this.el.clientWidth || !this.el.clientHeight) return;
    try { this.fitAddon.fit(); } catch (e) { /* ignore */ }
  }

  /** Called when the tab becomes visible/hidden. Only the visible tab uses WebGL (browsers cap contexts). */
  setActive(active, focused = true) {
    this.active = active;
    this.focused = focused;
    if (active) {
      // WebGL first: its whole-pixel cell size differs from the DOM renderer's, so fit after it.
      this._enableWebgl();
      this.fit();
      requestAnimationFrame(() => { if (this.active) this.fit(); });
      if (focused) this.term.focus();
    } else {
      this._disableWebgl();
    }
  }

  _enableWebgl() {
    if (this.webgl || this.webglFailed) return;
    try {
      const w = new WebglAddon.WebglAddon();
      w.onContextLoss(() => this._disableWebgl());
      this.term.loadAddon(w);
      this.webgl = w;
    } catch (e) {
      this.webglFailed = true; // stay on the DOM renderer
    }
  }

  _disableWebgl() {
    if (!this.webgl) return;
    try { this.webgl.dispose(); } catch (e) { /* ignore */ }
    this.webgl = null;
  }

  /** Close for good: ends the server process (socket close -> ttyd kills it). */
  dispose() {
    this.stopped = true;
    this.gen++;
    clearTimeout(this.timer);
    clearTimeout(this.keyTimer);
    cancelAnimationFrame(this._raf);
    this.ro.disconnect();
    this._dropSocket();
    this._disableWebgl();
    this.term.dispose();
  }
}
