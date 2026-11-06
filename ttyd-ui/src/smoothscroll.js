'use strict';
/*
 * Pixel-smooth touch scrolling of a tmux session.
 *
 * tmux redraws the screen in whole lines, so scrolling it with keys can only ever move line by line. Instead, the
 * first upward swipe fetches the pane's history (with colours) and shows it in a layer laid exactly over the terminal.
 * The layer is scrolled by pixel straight from the finger (and from the fling after it), which the browser draws at
 * the display's frame rate. Scrolling back down to the bottom, typing, or a tap removes the layer; its last rows are
 * the live screen, so the hand-over is not visible.
 *
 * Not used (the caller falls back to tmux keys) when an app owns the alternate screen (vim, less) or mouse reporting
 * is on, or when the history is no longer than the screen.
 */
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

class SmoothScroll {
  constructor(session) {
    this.s = session;
    this.state = 'idle';     // 'idle' | 'loading' | 'active'
    this.ov = null;
    this.cellH = 17;
    this.pending = 0;        // lines swiped while the history is still loading
    this.seq = 0;
    this.pre = null;         // { p, at, seq } history fetched ahead
    this.outSeq = 0;         // bumped on every terminal output: a fetched history is exact while it is unchanged
    this.warmTimer = 0;
    this.skipUntil = 0;      // after a failed/unsuitable load, use the key-based scroll for a while
  }

  get active() { return this.state === 'active'; }

  _eligible() {
    const s = this.s;
    return !!s.id && s.persistent && s.state === 'connected' && s.term.buffer.active.type === 'alternate' &&
      s.term.modes.mouseTrackingMode === 'none' && performance.now() >= this.skipUntil;
  }

  /** Terminal output arrived. Once it goes quiet, fetch the history ahead so the first swipe finds it ready. */
  noteOutput(data) {
    // tmux repaints its status line (clock) every so often: small writes without a line break leave the history as is
    if (data && data.length < 200 && !(typeof data === 'string' ? /[\r\n]/.test(data) : data.includes(10) || data.includes(13))) return;
    this.outSeq++;
    this.warm(400);
  }

  /** Fetch the history ahead after ms (on a touch screen), e.g. after connecting or switching to the tab. */
  warm(ms) {
    if (!COARSE) return;
    clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => this.prefetch(), ms);
  }

  /** Fetch the history ahead (when a finger lands, or after output went quiet) unless a current copy exists. */
  prefetch() {
    if (this.state !== 'idle' || !this._eligible()) return;
    if (this.pre && this.pre.seq === this.outSeq) return;
    if (this.pre && performance.now() - this.pre.at < 2000) return;
    const p = captureAnsi(this.s.id);
    p.catch(() => {});
    this.pre = { p, at: performance.now(), seq: this.outSeq };
  }

  /** True while swipes drive the history layer (open, loading, or about to open): scroll 1:1 with the finger. */
  wanted() { return this.state !== 'idle' || this._eligible(); }

  /** @param d lines to move: negative = towards older output (finger moving down). @returns true when handled here */
  scroll(d) {
    if (this.state === 'active') { this._by(d * this.cellH); return true; }
    if (this.state === 'loading') { this.pending += d; return true; }
    if (d >= 0 || !this._eligible()) return false;
    this._open(d);
    return true;
  }

  async _open(d) {
    this.state = 'loading';
    this.pending = d;
    const seq = ++this.seq;
    let data = null;
    const pre = this.pre && (this.pre.seq === this.outSeq || performance.now() - this.pre.at < 2000) ? this.pre.p : null;
    if (!pre) this.pre = { p: captureAnsi(this.s.id), at: performance.now(), seq: this.outSeq };   // kept: the next swipe can reuse it
    try { data = await (pre || this.pre.p); } catch (e) { this.pre = null; /* fall back below */ }
    if (seq !== this.seq || this.state !== 'loading') return;
    const rows = this.s.term.rows;
    const pending = this.pending;
    if (!data || data.alt || data.lines.length <= rows + 1) {
      this.state = 'idle';
      this.pending = 0;
      this.skipUntil = performance.now() + 2500;
      this.s._scrollTmux(pending);      // the swipe so far still counts
      return;
    }
    const tb = performance.now();
    this._build(data.lines);
    this.state = 'active';
    this.pending = 0;
    this.ov.scrollTop = this.ov.scrollHeight;
    if (this.s._touchSel) this.s._touchSel.attach(this);   // a selection made on the live screen carries over
    this._by(pending * this.cellH);
  }

  _by(px) {
    const ov = this.ov;
    if (!ov) return;
    ov.scrollTop += px;
    if (this.s._touchSel && this.s._touchSel.active) this.s._touchSel._place();
    if (px > 0 && ov.scrollTop >= ov.scrollHeight - ov.clientHeight - 0.5) this.close();   // back at the live screen
  }

  close() {
    if (this.ov && this.s._touchSel) this.s._touchSel.detach(this);   // a selection goes back to the live screen
    this.seq++;
    this.pending = 0;
    this.state = 'idle';
    if (this.ov) { this.ov.remove(); this.ov = null; }
  }

  _build(lines) {
    const s = this.s;
    const term = s.term;
    const el = s.el;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const screen = el.querySelector('.xterm-screen');
    const r = screen.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    this.cellH = r.height / term.rows;
    const cellW = r.width / term.cols;
    this.lines = lines;
    this.cellW = cellW;
    const theme = term.options.theme || {};
    const family = term.options.fontFamily;
    const size = term.options.fontSize;
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = size + 'px ' + family;
    const advance = ctx.measureText('0').width;

    const ov = document.createElement('div');
    ov.className = 'smooth-scroll';
    ov.style.cssText = 'position:absolute;z-index:3;overflow:hidden;pointer-events:none;white-space:pre;' +
      'left:' + (r.left - er.left - el.clientLeft) + 'px;top:' + (r.top - er.top - el.clientTop) + 'px;' +
      'width:' + r.width + 'px;height:' + r.height + 'px;' +
      'background:' + (theme.background || '#000') + ';color:' + (theme.foreground || '#ddd') + ';' +
      'font:' + size + 'px/' + this.cellH + 'px ' + family + ';letter-spacing:' + (cellW - advance) + 'px;' +
      'font-variant-ligatures:none;font-kerning:none;';
    const pal = ansiPalette(theme);
    const st = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };
    // Only the newest rows are built now so the layer opens at once; older chunks are inserted above them in the
    // background. A spacer stands in for the rows not built yet, so the height and every position stay the same.
    const CHUNK = 150;
    const starts = [];                                   // starts[k] = style state at the beginning of chunk k
    for (let i = 0; i < lines.length; i++) {
      if (i % CHUNK === 0) starts.push(Object.assign({}, st));
      lines[i].replace(/\x1b\[([0-9;:]*)m/g, (m0, p) => { applySgr(st, p, pal); return ''; });
    }
    const spacer = document.createElement('div');
    ov.appendChild(spacer);
    el.appendChild(ov);
    this.ov = ov;
    let k = starts.length;
    let top = lines.length;                              // rows [top, end) are built
    const buildChunk = () => {
      k--;
      const from = k * CHUNK;
      const frag = document.createDocumentFragment();
      const cs = Object.assign({}, starts[k]);
      for (let i = from; i < top; i++) frag.appendChild(ansiRow(lines[i], cs, pal, theme, this.cellH));
      top = from;
      spacer.style.height = (top * this.cellH) + 'px';
      spacer.after(frag);
    };
    spacer.style.height = (lines.length * this.cellH) + 'px';
    buildChunk();                                        // the newest (partial) chunk
    if (k > 0) buildChunk();                             // and one more, so a full screen is always there
    const fill = () => {
      if (this.ov !== ov || k === 0) return;
      buildChunk();
      setTimeout(fill, 16);
    };
    setTimeout(fill, 16);
    this.ov = ov;
  }
}

const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
const ANSI_FALLBACK = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];

/** 256-colour palette; the first 16 follow the terminal's theme. */
function ansiPalette(theme) {
  const pal = ANSI_NAMES.map((n, i) => theme[n] || ANSI_FALLBACK[i]);
  const lv = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) pal.push('rgb(' + lv[Math.floor(i / 36)] + ',' + lv[Math.floor(i / 6) % 6] + ',' + lv[i % 6] + ')');
  for (let i = 0; i < 24; i++) { const g = 8 + i * 10; pal.push('rgb(' + g + ',' + g + ',' + g + ')'); }
  return pal;
}

/** Apply the parameters of one SGR sequence (ESC [ ... m) to the running style. */
function applySgr(st, params, pal) {
  const p = params === '' ? [0] : params.split(/[;:]/).map((x) => (x === '' ? 0 : parseInt(x, 10)));
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === 0) { st.fg = st.bg = null; st.bold = st.dim = st.italic = st.underline = st.inverse = st.strike = false; }
    else if (c === 1) st.bold = true;
    else if (c === 2) st.dim = true;
    else if (c === 3) st.italic = true;
    else if (c === 4) st.underline = true;
    else if (c === 7) st.inverse = true;
    else if (c === 9) st.strike = true;
    else if (c === 22) st.bold = st.dim = false;
    else if (c === 23) st.italic = false;
    else if (c === 24) st.underline = false;
    else if (c === 27) st.inverse = false;
    else if (c === 29) st.strike = false;
    else if (c >= 30 && c <= 37) st.fg = pal[c - 30];
    else if (c === 39) st.fg = null;
    else if (c >= 40 && c <= 47) st.bg = pal[c - 40];
    else if (c === 49) st.bg = null;
    else if (c >= 90 && c <= 97) st.fg = pal[c - 90 + 8];
    else if (c >= 100 && c <= 107) st.bg = pal[c - 100 + 8];
    else if (c === 38 || c === 48) {
      let col = null;
      if (p[i + 1] === 5) { col = pal[p[i + 2]] || null; i += 2; }
      else if (p[i + 1] === 2) { col = 'rgb(' + (p[i + 2] | 0) + ',' + (p[i + 3] | 0) + ',' + (p[i + 4] | 0) + ')'; i += 4; }
      if (c === 38) st.fg = col; else st.bg = col;
    }
  }
}

/** One captured line as a fixed-height row: runs of text styled by the SGR state (which carries over between lines). */
function ansiRow(text, st, pal, theme, height) {
  const row = document.createElement('div');
  row.style.height = height + 'px';
  const re = /\x1b\[([0-9;:]*)([A-Za-z])|\x1b[^[]?/g;   // CSI sequences; anything else starting with ESC is dropped
  let last = 0;
  let m;
  const run = (str) => {
    if (!str) return;
    const sp = document.createElement('span');
    let fg = st.fg, bg = st.bg;
    if (st.inverse) { const f = fg || theme.foreground || '#ddd'; fg = bg || theme.background || '#000'; bg = f; }
    if (fg) sp.style.color = fg;
    if (bg) sp.style.backgroundColor = bg;
    if (st.bold) sp.style.fontWeight = 'bold';
    if (st.dim) sp.style.opacity = '.6';
    if (st.italic) sp.style.fontStyle = 'italic';
    if (st.underline || st.strike) sp.style.textDecoration = (st.underline ? 'underline ' : '') + (st.strike ? 'line-through' : '');
    sp.textContent = str;
    row.appendChild(sp);
  };
  while ((m = re.exec(text))) {
    run(text.slice(last, m.index));
    if (m[2] === 'm') applySgr(st, m[1], pal);
    last = re.lastIndex;
  }
  run(text.slice(last));
  return row;
}
