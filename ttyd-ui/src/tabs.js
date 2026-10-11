'use strict';
/* Tab manager: tab bar, panes, shortcuts. One tab = one Session = one tmux session on the server (ttyd-<id>). */

const STATE_LABEL = { connecting: 'connecting', connected: 'connected', reconnecting: 'reconnecting', closed: 'closed' };

function newId() {
  // getRandomValues works on insecure origins too (randomUUID does not). 't' + 10 hex = the tmux session name
  // suffix, and exactly what the server-side wrapper whitelists.
  const b = crypto.getRandomValues(new Uint8Array(5));
  return 't' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

class Tabs {
  constructor(barEl, panesEl, toastEl) {
    this.barEl = barEl;     // scrollable container for tab elements
    this.panesEl = panesEl;
    this.toastEl = toastEl;
    this.tabs = [];         // { id, title, userRenamed, session, el, paneEl, titleEl, dotEl, reconnectEl }
    this.activeId = null;
    this.counter = 0;
    this._bindGlobal();
    // Double-click on the empty part of the tab bar opens a new tab (double-click on a tab still renames it).
    barEl.addEventListener('dblclick', (e) => { if (e.target === barEl) this.newTab(); });
  }

  /** Apply a colour theme to the page and to every open terminal; it is remembered in this browser. */
  setTheme(id) {
    const term = Themes.set(id);
    for (const t of this.tabs) for (const p of t.panes) p.session.setTheme(term);
  }

  get active() { return this.tabs.find((t) => t.id === this.activeId); }

  // ---- lifecycle ------------------------------------------------------------------------

  /** Restore the tabs saved by this browser (reattaching their tmux sessions), or open one fresh tab. */
  restore() {
    const saved = Store.load();
    for (const t of saved.tabs) this.newTab({ ...t, activate: false });
    if (!this.tabs.length) { this.newTab(); return; }
    const want = this.tabs.find((t) => t.id === saved.active) || this.tabs[0];
    this.activate(want.id);
  }

  _save() { Store.save(this.tabs, this.activeId); }

  /** Session ids of every pane in every tab (the Sessions panel lists the server sessions NOT in this set). */
  openIds() { return new Set(this.tabs.flatMap((t) => t.panes.map((p) => p.id))); }

  /**
   * @param {{id?, title?, userRenamed?, host?, layout?, focus?, activate?}} [opts]
   *   id given = attach to that existing server session; host = saved-host key (used only when the session is
   *   created, remembered per pane); layout = saved split tree
   */
  newTab(opts = {}) {
    const host = validHost(opts.host) ? opts.host : '';
    const layout = Layout.validate(opts.layout) || { id: opts.id || newId(), host };
    const ids = Layout.leaves(layout).map((l) => l.id);
    const open = this.openIds();
    const dup = ids.find((i) => open.has(i));
    if (dup) { this.activate(this.tabs.find((t) => t.panes.some((p) => p.id === dup)).id); return undefined; }
    const id = opts.id && ID_RE.test(opts.id) && !this.tabs.some((t) => t.id === opts.id) ? opts.id : ids[0];
    const n = ++this.counter;
    const paneEl = document.createElement('div');
    paneEl.className = 'pane';
    this.panesEl.appendChild(paneEl);

    const el = document.createElement('div');
    el.className = 'tab';
    el.setAttribute('role', 'tab');
    el.innerHTML =
      '<span class="dot"></span><span class="title"></span>' +
      '<button class="reconnect" title="Reconnect" hidden>↻</button>' +
      '<button class="close" title="Close tab (Alt+W)">×</button>';
    this.barEl.appendChild(el);

    const tab = {
      id, title: opts.title || 'Terminal ' + n, userRenamed: !!opts.userRenamed, host, el, paneEl,
      titleEl: el.querySelector('.title'), dotEl: el.querySelector('.dot'),
      reconnectEl: el.querySelector('.reconnect'),
      layout, panes: [], focus: ids.includes(opts.focus) ? opts.focus : ids[0], dividers: new Map(),
    };
    // tab.session = the focused pane's session (what single-pane code, search and the tests talk to)
    Object.defineProperty(tab, 'session', { get: () => this._pane(tab, tab.focus).session });
    for (const leaf of Layout.leaves(layout)) this._makePane(tab, leaf);
    this.tabs.push(tab);
    this._layout(tab);

    el.addEventListener('click', (e) => {
      if (e.target.closest('.close')) this.closeTab(id);
      else if (e.target.closest('.reconnect')) {
        for (const p of tab.panes) if (p.session.state !== 'connected' && p.session.state !== 'connecting') p.session.reconnectNow();
        tab.session.term.focus();
      } else this.activate(id);
    });
    this._bindRename(tab);

    this._render(tab);
    this._renderState(tab);
    if (opts.activate !== false) this.activate(id);
    this._save();
    for (const p of tab.panes) p.session.connect();
    return tab;
  }

  _pane(tab, paneId) { return tab.panes.find((p) => p.id === paneId) || tab.panes[0]; }

  _makePane(tab, leaf) {
    const leafEl = document.createElement('div');
    leafEl.className = 'leaf';
    const termEl = document.createElement('div');
    termEl.className = 'term';
    const closeEl = document.createElement('button');
    closeEl.className = 'pclose';
    closeEl.title = 'Close pane (Alt+Shift+W)';
    closeEl.textContent = '×';
    leafEl.append(termEl, closeEl);
    tab.paneEl.appendChild(leafEl);
    const pane = { id: leaf.id, host: leaf.host || '', leafEl, title: '', session: null };
    pane.session = new Session(termEl, {
      onState: () => this._renderState(tab),
      onTitle: (t) => {
        pane.title = t;
        if (pane.id === tab.focus && !tab.userRenamed) { tab.title = t; this._render(tab); this._save(); }
      },
      onNotice: (m) => this.toast(m),
      onInput: (d) => this._broadcast(tab, pane, d),
      // Badges only for tabs you are not looking at; cleared when the tab is activated.
      onBell: () => this._badge(tab, 'bell'),
      onActivity: () => this._badge(tab, 'activity'),
    }, { fontSize: window.innerWidth < 600 ? 12 : 14, persistent: true, query: '?arg=attach&arg=' + leaf.id + (pane.host ? '&arg=' + pane.host : '') });
    leafEl.addEventListener('pointerdown', () => this.focusPane(tab, pane.id), true);
    closeEl.addEventListener('click', (e) => { e.stopPropagation(); this.closePane(tab, pane.id); });
    tab.panes.push(pane);
    return pane;
  }

  closeTab(id) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tab = this.tabs[idx];
    if (tab.panes.some((p) => p.session.state === 'connected') &&
        !confirm('Close "' + tab.title + '"?\nThis kills its tmux session' + (tab.panes.length > 1 ? 's' : '') + ' and any running command.')) {
      return;
    }
    for (const p of tab.panes) {
      p.session.dispose();
      // Closing a tab ends its server sessions. (Reloading the page or closing the browser does not.)
      killSession(p.id).catch(() => this.toast('Could not end the session on the server; find it under Sessions.'));
    }
    tab.el.remove();
    tab.paneEl.remove();
    this.tabs.splice(idx, 1);
    if (!this.tabs.length) { this.newTab(); return; }       // never leave the page empty
    if (this.activeId === id) this.activate(this.tabs[Math.min(idx, this.tabs.length - 1)].id);
    this._save();
  }

  activate(id) {
    const next = this.tabs.find((t) => t.id === id);
    if (!next) return;
    for (const t of this.tabs) {
      const on = t === next;
      t.el.classList.toggle('active', on);
      t.el.setAttribute('aria-selected', on ? 'true' : 'false');
      t.paneEl.classList.toggle('active', on);
      if (on) { t.badge = ''; delete t.el.dataset.badge; }
      else for (const p of t.panes) if (p.session.active) p.session.setActive(false);
    }
    this.activeId = id;
    for (const p of next.panes) p.session.setActive(true, p.id === next.focus);
    this._markFocus(next);
    next.el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    document.title = next.title;
    this._save();
  }

  // ---- split panes ----------------------------------------------------------------------

  /** dir 'h' = new pane to the right, 'v' = new pane below. The new pane inherits the saved host of the one it splits. */
  split(dir) {
    const tab = this.active;
    if (!tab) return;
    if (tab.panes.length >= MAX_PANES) { this.toast('At most ' + MAX_PANES + ' panes per tab.'); return; }
    const leaf = { id: newId(), host: this._pane(tab, tab.focus).host };
    tab.layout = Layout.split(tab.layout, tab.focus, dir, leaf);
    const pane = this._makePane(tab, leaf);
    this._layout(tab);
    for (const p of tab.panes) p.session.setActive(true, false);
    this.focusPane(tab, pane.id);
    pane.session.connect();
  }

  closePane(tab, paneId) {
    if (tab.panes.length === 1) { this.closeTab(tab.id); return; }
    const pane = this._pane(tab, paneId);
    if (pane.session.state === 'connected' && !confirm('Close this pane?\nIt kills its tmux session and any running command.')) return;
    const order = tab.panes.map((p) => p.id);
    const i = order.indexOf(pane.id);
    pane.session.dispose();
    pane.leafEl.remove();
    killSession(pane.id).catch(() => this.toast('Could not end the session on the server; find it under Sessions.'));
    tab.layout = Layout.remove(tab.layout, pane.id);
    tab.panes.splice(i, 1);
    this._layout(tab);
    if (tab.focus === pane.id) this.focusPane(tab, tab.panes[Math.max(0, i - 1)].id);
    else this._save();
    for (const p of tab.panes) p.session.fit();
  }

  focusPane(tab, paneId) {
    if (!tab.panes.some((p) => p.id === paneId)) return;
    tab.focus = paneId;
    const pane = this._pane(tab, paneId);
    for (const p of tab.panes) p.session.focused = p.id === paneId;
    this._markFocus(tab);
    if (tab.id === this.activeId) {
      pane.session.term.focus();
      if (!tab.userRenamed && pane.title) { tab.title = pane.title; this._render(tab); }
    }
    this._save();
  }

  /** Move focus to the neighbouring pane: dir 'left' | 'right' | 'up' | 'down'. */
  moveFocus(dir) {
    const tab = this.active;
    if (!tab || tab.panes.length < 2) return;
    const to = Layout.neighbor(Layout.rects(tab.layout), tab.focus, dir);
    if (to) this.focusPane(tab, to);
  }

  _markFocus(tab) {
    tab.paneEl.classList.toggle('multi', tab.panes.length > 1);
    for (const p of tab.panes) p.leafEl.classList.toggle('focused', p.id === tab.focus);
  }

  /** Rebuild the dividers for the tab's current tree and place everything. */
  _layout(tab) {
    for (const d of tab.dividers.values()) d.remove();
    tab.dividers.clear();
    for (const { node } of Layout.splits(tab.layout)) {
      const d = document.createElement('div');
      d.className = 'divider ' + node.dir;
      this._bindDivider(tab, d, node);
      tab.paneEl.appendChild(d);
      tab.dividers.set(node, d);
    }
    this._place(tab);
    this._markFocus(tab);
  }

  /** Position panes and dividers from the tree (no DOM moves: terminals keep their elements). */
  _place(tab) {
    const rects = Layout.rects(tab.layout);
    for (const p of tab.panes) {
      const r = rects[p.id];
      Object.assign(p.leafEl.style, { left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%' });
    }
    for (const { node, rect } of Layout.splits(tab.layout)) {
      const d = tab.dividers.get(node);
      if (!d) continue;
      if (node.dir === 'h') Object.assign(d.style, { left: (rect.x + rect.w * node.ratio) * 100 + '%', top: rect.y * 100 + '%', height: rect.h * 100 + '%' });
      else Object.assign(d.style, { top: (rect.y + rect.h * node.ratio) * 100 + '%', left: rect.x * 100 + '%', width: rect.w * 100 + '%' });
    }
  }

  _bindDivider(tab, d, node) {
    d.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      d.setPointerCapture(e.pointerId);
      const area = tab.paneEl.getBoundingClientRect();
      const rect = Layout.splits(tab.layout).find((s) => s.node === node).rect;
      const move = (ev) => {
        const frac = node.dir === 'h' ? (ev.clientX - area.left) / area.width : (ev.clientY - area.top) / area.height;
        const span = node.dir === 'h' ? rect.w : rect.h;
        const start = node.dir === 'h' ? rect.x : rect.y;
        node.ratio = Math.min(1 - RATIO_MIN, Math.max(RATIO_MIN, (frac - start) / span));
        this._place(tab);
      };
      const up = () => {
        d.removeEventListener('pointermove', move);
        d.removeEventListener('pointerup', up);
        d.removeEventListener('pointercancel', up);
        this._save();
      };
      d.addEventListener('pointermove', move);
      d.addEventListener('pointerup', up);
      d.addEventListener('pointercancel', up);
    });
  }

  // ---- broadcast input ------------------------------------------------------------------
  // Tabs marked for broadcast mirror what you type (or paste, or send from the key bar / a snippet) in any of
  // their panes to every pane of every marked tab. Never saved: it is off again after a reload.

  toggleBroadcast(tab = this.active) {
    if (!tab) return;
    if (!tab.bcast) {
      if (!confirm('Broadcast input?\nEverything you type in a marked tab is sent to ALL panes of ALL marked tabs.\nMark "' + tab.title + '".')) return;
      tab.bcast = true;
    } else tab.bcast = false;
    this._renderBcast(tab);
    const n = this.tabs.filter((t) => t.bcast).length;
    this.toast(tab.bcast ? 'Broadcast ON for this tab (' + n + ' marked)' + (n < 2 ? ' - mark another tab to mirror to it' : '') : 'Broadcast off for this tab');
  }

  _renderBcast(tab) {
    tab.el.classList.toggle('bcast', !!tab.bcast);
    tab.paneEl.classList.toggle('bcast', !!tab.bcast);
    tab.el.title = tab.title + (tab.bcast ? ' (broadcasting)' : '');
  }

  _broadcast(tab, from, d) {
    if (!tab.bcast) return;
    for (const t of this.tabs) {
      if (!t.bcast) continue;
      for (const p of t.panes) if (p !== from) p.session.sendInput(d);
    }
  }

  _badge(tab, kind) {
    if (tab.id === this.activeId || tab.badge === 'bell' || tab.badge === kind) return;
    tab.badge = kind;     // a bell outranks plain activity
    tab.el.dataset.badge = kind;
  }

  step(delta) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length].id);
  }

  jump(n) { if (this.tabs[n - 1]) this.activate(this.tabs[n - 1].id); }

  // ---- rendering ------------------------------------------------------------------------

  _render(tab) {
    tab.titleEl.textContent = tab.title;
    tab.el.title = tab.title;
    if (tab.id === this.activeId) {
      document.title = tab.title;
      tab.el.scrollIntoView({ inline: 'nearest', block: 'nearest' }); // title width changed
    }
  }

  /** Tab state = worst pane state: reconnecting > connecting > connected (some live) > closed (all ended). */
  _renderState(tab) {
    const st = tab.panes.map((p) => p.session.state);
    const state = st.includes('reconnecting') ? 'reconnecting' : st.includes('connecting') ? 'connecting'
      : st.includes('connected') ? 'connected' : 'closed';
    tab.state = state;
    tab.el.dataset.state = state;
    tab.dotEl.title = STATE_LABEL[state];
    tab.reconnectEl.hidden = st.every((x) => x === 'connected' || x === 'connecting');
  }

  toast(msg) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 3500);
  }

  // ---- rename (double-click, or double-tap on touch) --------------------------------------

  _bindRename(tab) {
    const start = () => this._rename(tab);
    tab.titleEl.addEventListener('dblclick', start);
    let last = 0;
    tab.titleEl.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'touch') return;
      const now = Date.now();
      if (now - last < 350) { last = 0; start(); } else last = now;
    });
  }

  _rename(tab) {
    const input = document.createElement('input');
    input.className = 'rename';
    input.value = tab.title;
    tab.titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save) {
        if (v) { tab.title = v; tab.userRenamed = true; }
        else tab.userRenamed = false;   // empty = go back to following the terminal title
      }
      input.replaceWith(tab.titleEl);
      this._render(tab);
      this._save();
      if (tab.id === this.activeId) tab.session.term.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ---- global shortcuts / unload guard ----------------------------------------------------

  _bindGlobal() {
    // Capture phase on window: runs before xterm sees the key, so Alt combos never reach the shell.
    window.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      let handled = true;
      if (e.shiftKey) {
        // Alt+Shift+Arrows move between panes, Alt+Shift+W closes the focused pane
        const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.code];
        if (dir) this.moveFocus(dir);
        else if (e.code === 'KeyW') { const t = this.active; if (t && t.panes.length > 1) this.closePane(t, t.focus); }
        else handled = false;
      } else if (e.code === 'KeyT') this.newTab();
      else if (e.code === 'KeyW') { if (this.activeId) this.closeTab(this.activeId); }
      else if (e.code === 'ArrowLeft') this.step(-1);
      else if (e.code === 'ArrowRight') this.step(1);
      else if (e.code === 'KeyB') this.toggleBroadcast();
      else if (e.code === 'Backslash') this.split('h');
      else if (e.code === 'Minus') this.split('v');
      else if (/^Digit[1-9]$/.test(e.code)) this.jump(Number(e.code.slice(5)));
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }
}
