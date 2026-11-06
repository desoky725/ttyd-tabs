'use strict';
/*
 * Touch text selection: double-tap a word to select it, drag the two handles to extend the selection, then tap Copy in
 * the bar at the top of the terminal. Nothing is copied until Copy is tapped.
 * xterm draws its own text, so there are no native selection handles; these are drawn over the terminal instead.
 *
 * Two surfaces: the live screen (xterm does the highlighting) and the scroll layer of smoothscroll.js (rows of text in a
 * div; the highlight is drawn here). A selection moves between them as the layer opens and closes, so you can select,
 * swipe to scroll back to where the selection should end, and carry on; dragging a handle to the top or bottom edge of
 * the layer scrolls it.
 */
class TouchSelect {
  constructor(session) {
    this.s = session;
    this.mode = 'live';       // 'live' | 'layer': where a and b live
    this.a = null;            // selection start, { col, row }: live = absolute buffer row, layer = row of the history
    this.b = null;            // selection end (inclusive)
    this.down = null;         // a finger that has not moved yet: { x, y, t, ov }
    this.last = null;         // the previous tap
    this.swallowUntil = 0;    // until then, the mouse events a touch produces afterwards are dropped (they would focus the terminal)
    this.closeTimer = 0;
    this.plain = null;        // layer rows without colour codes (made when first needed)
    this.hl = null;           // highlight rectangles inside the layer
    this.hs = null;           // handle elements
    this.he = null;
    this.bar = null;
    this.txt = null;
    const el = session.el;
    el.addEventListener('touchstart', (e) => this._down(e), { passive: true });
    el.addEventListener('touchmove', (e) => this._move(e), { passive: true });
    el.addEventListener('touchend', (e) => this._up(e), { passive: false });
    el.addEventListener('touchcancel', () => { this.down = null; }, { passive: true });
    for (const type of ['mousedown', 'mouseup', 'click']) {
      el.addEventListener(type, (e) => {
        if (performance.now() >= this.swallowUntil || (this.bar && this.bar.contains(e.target))) return;
        e.preventDefault();
        e.stopPropagation();
      }, true);
    }
    session.term.onSelectionChange(() => {
      if (this.a && this.mode === 'live' && !session.term.hasSelection()) this.clear();   // xterm dropped it (new output, reset)
    });
    session.term.onScroll(() => this._place());
    session.term.onResize(() => this._place());   // e.g. the keyboard opened: keep the selection, move the handles
  }

  get active() { return !!this.a; }

  /** True just after a double-tap: the browser's own follow-up (context menu, focus) is to be ignored. */
  busy() { return performance.now() < this.swallowUntil; }

  get sm() { return this.s._smooth; }

  // ---- taps -------------------------------------------------------------------------------

  _down(e) {
    this.down = null;
    if (this.s.selectMode || e.touches.length !== 1) { this.last = null; return; }
    const t = e.touches[0];
    this.down = { x: t.clientX, y: t.clientY, t: performance.now(), ov: this.sm.state !== 'idle' };   // ov: the tap lands on the scroll layer
  }

  _move(e) {
    const t = e.touches[0];
    if (this.down && t && Math.hypot(t.clientX - this.down.x, t.clientY - this.down.y) > 10) { this.down = null; this.last = null; }
  }

  /** A tap on the scroll layer: back to the live screen, unless a second tap follows (that selects) or a selection is shown. */
  layerTap() {
    clearTimeout(this.closeTimer);
    if (this.a) return;
    this.closeTimer = setTimeout(() => { if (!this.a && this.sm.active) this.sm.close(); }, 380);
  }

  _up(e) {
    const d = this.down;
    this.down = null;
    if (!d || performance.now() - d.t > 300) { this.last = null; return; }   // a swipe or a long touch is not a tap
    const now = performance.now();
    const l = this.last;
    if (l && now - l.t < 500) {
      // a second tap: keep the browser's follow-up mouse events (xterm would select a word and copy it) away from the terminal
      this.last = null;
      clearTimeout(this.closeTimer);
      this.swallowUntil = now + 700;
      if (e.cancelable) e.preventDefault();
      if (Math.hypot(d.x - l.x, d.y - l.y) < 40 && this.sm.state !== 'loading') this._select(d);
      return;
    }
    this.last = { x: d.x, y: d.y, t: now };
    if (this.a) { this.swallowUntil = now + 700; if (e.cancelable) e.preventDefault(); this.clear(); }   // a tap elsewhere ends the selection
  }

  // ---- the two surfaces -------------------------------------------------------------------

  _plain() {
    if (!this.plain) this.plain = this.sm.lines.map((l) => l.replace(/\x1b\[[0-9;:]*[A-Za-z]|\x1b[^[]?/g, ''));
    return this.plain;
  }

  /** Cell under a point on the active surface. */
  _cell(p) {
    if (this.mode !== 'layer') return this.s._cellAt(p);
    const ov = this.sm.ov;
    const r = ov.getBoundingClientRect();
    const cw = this.sm.cellW, ch = this.sm.cellH;
    const clamp = (v, max) => Math.max(0, Math.min(max, v));
    return {
      col: clamp(Math.floor((p.clientX - r.left) / cw), this.s.term.cols - 1),
      row: clamp(Math.floor((p.clientY - r.top + ov.scrollTop) / ch), this.sm.lines.length - 1),
    };
  }

  _word(c) {
    if (this.mode !== 'layer') return this.s._wordAt(c);
    const text = this._plain()[c.row];
    if (!text || !text[c.col] || /\s/.test(text[c.col])) return null;
    let s = c.col, e = c.col;
    while (s > 0 && !/\s/.test(text[s - 1])) s--;
    while (e < text.length - 1 && !/\s/.test(text[e + 1])) e++;
    return { s, e, row: c.row };
  }

  _text() {
    if (this.mode !== 'layer') return this.s.term.getSelection();
    const p = this._plain();
    const out = [];
    for (let r = this.a.row; r <= this.b.row; r++) {
      const t = p[r] || '';
      out.push((r === this.a.row ? t.slice(this.a.col) : t).slice(0, r === this.b.row ? this.b.col + 1 - (r === this.a.row ? this.a.col : 0) : undefined).replace(/\s+$/, ''));
    }
    return out.join('\n');
  }

  _select(p) {
    this.mode = this.sm.active ? 'layer' : 'live';
    if (this.mode === 'layer') this.plain = null;
    const c = this._cell({ clientX: p.x, clientY: p.y });
    const w = this._word(c);
    if (!w) return;
    this.a = { col: w.s, row: w.row };
    this.b = { col: w.e, row: w.row };
    if (navigator.vibrate) navigator.vibrate(10);
    this._ensureUi();
    this._apply();
  }

  /** Show a..b without moving anything: the page, the terminal and the keyboard stay as they are. */
  _apply() {
    if (this.mode === 'layer') { this._drawLayer(); this._place(); return; }
    const vp = this.s.el.querySelector('.xterm-viewport');
    const keep = { x: window.scrollX, y: window.scrollY, v: vp ? vp.scrollTop : 0 };
    this.s._selectRange(this.a, this.b);
    this._place();
    const restore = () => {
      if (window.scrollX !== keep.x || window.scrollY !== keep.y) window.scrollTo(keep.x, keep.y);
      if (vp && vp.scrollTop !== keep.v) vp.scrollTop = keep.v;
    };
    restore();
    requestAnimationFrame(() => { restore(); requestAnimationFrame(restore); });
  }

  /** Highlight rectangles inside the layer (they scroll with it): the first row, the last row and the rows between. */
  _drawLayer() {
    const ov = this.sm.ov;
    if (!ov) return;
    if (!this.hl || this.hl.parentNode !== ov) {
      this.hl = document.createElement('div');
      this.hl.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;';
      ov.appendChild(this.hl);
    }
    const cw = this.sm.cellW, ch = this.sm.cellH, cols = this.s.term.cols;
    const rect = (row, c0, c1) => {
      const d = document.createElement('div');
      d.style.cssText = 'position:absolute;background:rgba(77,159,255,.38);left:' + (c0 * cw) + 'px;top:' + (row * ch) + 'px;width:' + ((c1 - c0) * cw) + 'px;height:' + ch + 'px;';
      return d;
    };
    const a = this.a, b = this.b;
    this.hl.textContent = '';
    if (a.row === b.row) { this.hl.appendChild(rect(a.row, a.col, b.col + 1)); return; }
    this.hl.appendChild(rect(a.row, a.col, cols));
    if (b.row - a.row > 1) {
      const mid = rect(a.row + 1, 0, cols);
      mid.style.height = ((b.row - a.row - 1) * ch) + 'px';
      this.hl.appendChild(mid);
    }
    this.hl.appendChild(rect(b.row, 0, b.col + 1));
  }

  clear() {
    clearTimeout(this.closeTimer);
    if (!this.a) return;
    this.a = this.b = null;
    if (this.mode === 'layer') { if (this.hl) this.hl.textContent = ''; }
    else this.s.term.clearSelection();
    for (const n of [this.hs, this.he, this.bar]) if (n) n.hidden = true;
  }

  /** The scroll layer just opened: carry a live selection over (live row r is row N - rows + r of the history). */
  attach(sm) {
    this.plain = null;
    if (!this.a || this.mode !== 'live') return;
    const term = this.s.term;
    const off = sm.lines.length - term.rows - term.buffer.active.viewportY;
    this.a = { col: this.a.col, row: this.a.row + off };
    this.b = { col: this.b.col, row: this.b.row + off };
    this.mode = 'layer';
    this.s.term.clearSelection();
    this._drawLayer();
    this._place();
  }

  /** The scroll layer is closing: what is still on the live screen stays selected, the rest is dropped. */
  detach(sm) {
    if (!this.a || this.mode !== 'layer') return;
    this.mode = 'live';
    const term = this.s.term;
    const off = sm.lines.length - term.rows - term.buffer.active.viewportY;
    const top = off;                                   // first layer row that is on the live screen
    if (this.b.row < top) { this.a = this.b = null; this.s.term.clearSelection(); for (const n of [this.hs, this.he, this.bar]) if (n) n.hidden = true; return; }
    const a = this.a.row < top ? { col: 0, row: top } : this.a;
    this.a = { col: a.col, row: a.row - off };
    this.b = { col: this.b.col, row: this.b.row - off };
    this.hl = null;
    this._apply();
  }

  // ---- handles and the bar ----------------------------------------------------------------

  _ensureUi() {
    if (this.bar) return;
    const el = this.s.el;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const mk = (cls) => { const d = document.createElement('div'); d.className = cls; el.appendChild(d); return d; };
    this.hs = mk('ts-handle');
    this.he = mk('ts-handle');
    this.bar = mk('ts-bar');
    this.txt = document.createElement('span');
    this.txt.className = 'ts-text';
    this.bar.appendChild(this.txt);
    const btn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
      b.addEventListener('mousedown', (e) => e.preventDefault());   // keep the focus where it is
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
      this.bar.appendChild(b);
    };
    btn('Copy', () => {
      const text = this._text();
      this.s.copyText(text).then((ok) => {
        if (this.s.cb.onNotice) this.s.cb.onNotice(ok ? 'Copied' : 'Copy failed: the browser refused clipboard access');
      });
      this.clear();
    });
    btn('Select all', () => {
      if (this.mode === 'layer') {
        const ov = this.sm.ov, ch = this.sm.cellH;
        this.a = { col: 0, row: Math.max(0, Math.floor(ov.scrollTop / ch)) };
        this.b = { col: this.s.term.cols - 1, row: Math.min(this.sm.lines.length - 1, Math.ceil((ov.scrollTop + ov.clientHeight) / ch) - 1) };
      } else {
        const t = this.s.term, b = t.buffer.active;
        this.a = { col: 0, row: b.viewportY };
        this.b = { col: t.cols - 1, row: b.viewportY + t.rows - 1 };
      }
      this._apply();
    });
    btn('✕', () => this.clear());
    this.bar.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    this._drag(this.hs, true);
    this._drag(this.he, false);
  }

  _drag(h, isStart) {
    let on = false;
    let pt = null;        // last finger position
    let raf = 0;
    const aim = () => {
      // the handle hangs below the text: aim at the row above the finger
      const c = this._cell({ clientX: pt.x, clientY: pt.y - this.cellH() * 1.2 });
      const before = (x, y) => x.row < y.row || (x.row === y.row && x.col <= y.col);
      if (isStart) { if (before(c, this.b)) this.a = c; } else if (before(this.a, c)) this.b = c;
      this._apply();
    };
    const edge = () => {
      raf = 0;
      if (!on || this.mode !== 'layer' || !this.sm.ov) return;
      const r = this.sm.ov.getBoundingClientRect();
      const zone = 56;
      const v = pt.y < r.top + zone ? -(r.top + zone - pt.y) / zone : pt.y > r.bottom - zone ? (pt.y - (r.bottom - zone)) / zone : 0;
      if (v !== 0) {
        this.sm._by(Math.max(-1, Math.min(1, v)) * 14);
        if (this.mode !== 'layer') return;               // reached the live screen: the layer closed
        aim();
      }
      raf = requestAnimationFrame(edge);
    };
    h.addEventListener('touchstart', (e) => { e.stopPropagation(); e.preventDefault(); on = true; }, { passive: false });
    h.addEventListener('touchmove', (e) => {
      if (!on) return;
      e.stopPropagation();
      e.preventDefault();
      const t = e.touches[0];
      pt = { x: t.clientX, y: t.clientY };
      aim();
      if (!raf && this.mode === 'layer') raf = requestAnimationFrame(edge);
    }, { passive: false });
    const end = (e) => { on = false; e.stopPropagation(); };
    h.addEventListener('touchend', end, { passive: true });
    h.addEventListener('touchcancel', end, { passive: true });
  }

  cellH() {
    return this.s.el.querySelector('.xterm-screen').getBoundingClientRect().height / this.s.term.rows;
  }

  _place() {
    if (!this.a || !this.hs) return;
    const s = this.s, el = s.el, term = s.term;
    const er = el.getBoundingClientRect();
    if (this.mode === 'layer' && this.sm.ov) {
      const ov = this.sm.ov, r = ov.getBoundingClientRect();
      const ox = r.left - er.left - el.clientLeft, oy = r.top - er.top - el.clientTop - ov.scrollTop;   // layer content origin in el
      const cw = this.sm.cellW, ch = this.sm.cellH;
      const vis = (row) => row * ch >= ov.scrollTop - ch && (row + 1) * ch <= ov.scrollTop + ov.clientHeight + ch;
      this._pos(this.hs, ox + this.a.col * cw, oy + (this.a.row + 1) * ch, vis(this.a.row));
      this._pos(this.he, ox + (this.b.col + 1) * cw, oy + (this.b.row + 1) * ch, vis(this.b.row));
    } else {
      const sr = el.querySelector('.xterm-screen').getBoundingClientRect();
      const ox = sr.left - er.left - el.clientLeft, oy = sr.top - er.top - el.clientTop;
      const cw = sr.width / term.cols, ch = sr.height / term.rows;
      const vy = term.buffer.active.viewportY;
      const ar = this.a.row - vy, br = this.b.row - vy;
      this._pos(this.hs, ox + this.a.col * cw, oy + (ar + 1) * ch, ar >= 0 && ar < term.rows);
      this._pos(this.he, ox + (this.b.col + 1) * cw, oy + (br + 1) * ch, br >= 0 && br < term.rows);
    }
    // the bar stays at the very top of the terminal; it shows what is selected
    const text = this._text().replace(/\s+/g, ' ').trim();
    this.txt.textContent = text.length > 60 ? text.slice(0, 57) + '…' : text;
    this.bar.hidden = false;
  }

  _pos(n, x, y, vis) { n.hidden = !vis; n.style.left = x + 'px'; n.style.top = y + 'px'; }
}
