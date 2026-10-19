'use strict';
/*
 * Command palette (Alt+P, or the top-bar button) with user snippets.
 * Type to filter, Up/Down to move, Enter to run, Esc to close. Snippets are kept in this browser (localStorage,
 * per origin like the tab list): inserting one pastes its text into the focused pane; a snippet marked "run"
 * also presses Enter. Nothing from a snippet is ever sent without you choosing it.
 */
const SNIPPETS_KEY = 'ttyd-ui.snippets.v1';
const MAX_SNIPPETS = 100;

const Snippets = {
  load() {
    try {
      const v = JSON.parse(localStorage.getItem(SNIPPETS_KEY));
      if (Array.isArray(v)) {
        return v.filter((s) => s && typeof s.name === 'string' && typeof s.text === 'string' && s.name.trim() && s.text.length <= 20000)
          .slice(0, MAX_SNIPPETS).map((s) => ({ name: s.name.trim().slice(0, 80), text: s.text, run: !!s.run }));
      }
    } catch (e) { /* corrupt: start empty */ }
    return [];
  },
  save(list) { try { localStorage.setItem(SNIPPETS_KEY, JSON.stringify(list)); } catch (e) { /* best effort */ } },
};

class Palette {
  constructor(boxEl, buttonEl, ctx) {
    this.box = boxEl;
    this.ctx = ctx;   // { tabs, keybar, hostMenu, search }
    this.items = [];
    this.sel = 0;
    boxEl.innerHTML = '<div class="pl-card"><input type="text" placeholder="Type a command or snippet..." aria-label="Command palette" autocomplete="off" spellcheck="false"><div class="pl-list" role="listbox"></div></div>';
    this.input = boxEl.querySelector('input');
    this.listEl = boxEl.querySelector('.pl-list');
    buttonEl.addEventListener('click', () => (this.box.hidden ? this.open() : this.close()));
    boxEl.addEventListener('pointerdown', (e) => { if (e.target === boxEl) this.close(); });
    this.input.addEventListener('input', () => { this.sel = 0; this.render(); });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); this.run(this.sel); }
    });
    window.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && e.code === 'KeyP') {
        e.preventDefault(); e.stopPropagation();
        if (this.box.hidden) this.open(); else this.close();
      }
    }, true);
  }

  commands() {
    const { tabs, keybar, hostMenu, search } = this.ctx;
    const t = tabs.active;
    const c = [
      { name: 'New tab', hint: 'Alt+T', run: () => tabs.newTab() },
      { name: 'Close tab', hint: 'Alt+W', run: () => tabs.closeTab(tabs.activeId) },
      { name: 'Split pane right', hint: 'Alt+\\', run: () => tabs.split('h') },
      { name: 'Split pane down', hint: 'Alt+-', run: () => tabs.split('v') },
      { name: 'Close pane', hint: 'Alt+Shift+W', run: () => t && tabs.closePane(t, t.focus) },
      { name: 'Search scrollback', hint: 'Ctrl+Shift+F', run: () => search.open() },
      { name: (t && t.bcast ? 'Stop broadcasting from this tab' : 'Broadcast input: mark this tab'), hint: 'Alt+B', run: () => tabs.toggleBroadcast() },
      { name: 'Paste from clipboard', hint: 'Ctrl+V', run: () => {
        if (!t) return;
        if (navigator.clipboard && navigator.clipboard.readText) t.session.pasteFromClipboard();
        else tabs.toast('Paste from the palette needs https; use Ctrl+V or the browser paste menu instead.');
      } },
      { name: 'Send literal ^V (quoted insert)', hint: 'Ctrl+Alt+V', run: () => t && t.session.type('\x16') },
      { name: 'Links in the terminal (open / copy)', run: () => t && TouchTools.showLinks(t.session.term) },
      { name: keybar.el.hidden ? 'Show key bar' : 'Hide key bar', run: () => keybar.toggle() },
      { name: 'Snippet: add...', run: () => this.addSnippet() },
    ];
    const cur = Themes.currentId();
    for (const id of Object.keys(THEMES)) c.push({ name: 'Theme: ' + THEMES[id].name, hint: id === cur ? 'current' : '', run: () => tabs.setTheme(id) });
    tabs.tabs.forEach((x, i) => c.push({ name: 'Go to tab ' + (i + 1) + ': ' + x.title, run: () => tabs.activate(x.id) }));
    for (const h of hostMenu.hosts) c.push({ name: 'New tab on ' + h.label, run: () => tabs.newTab({ host: h.key, title: h.label }) });
    for (const s of Snippets.load()) {
      c.push({ name: '▶ ' + s.name, hint: (s.run ? 'run: ' : '') + s.text.replace(/\s+/g, ' ').slice(0, 50), snippet: s, run: () => this.insert(s) });
    }
    for (const s of Snippets.load()) c.push({ name: 'Snippet: delete ' + s.name, run: () => this.deleteSnippet(s) });
    return c;
  }

  open() {
    this.box.hidden = false;
    this.input.value = '';
    this.sel = 0;
    this.items = this.commands();
    this.render();
    this.input.focus();
  }

  close() {
    this.box.hidden = true;
    const t = this.ctx.tabs.active;
    if (t) t.session.term.focus();
  }

  filtered() {
    const words = this.input.value.toLowerCase().split(/\s+/).filter(Boolean);
    return this.items.filter((it) => words.every((w) => (it.name + ' ' + (it.hint || '')).toLowerCase().includes(w)));
  }

  move(d) {
    const n = this.filtered().length;
    if (!n) return;
    this.sel = (this.sel + d + n) % n;
    this.render();
  }

  render() {
    const list = this.filtered();
    this.sel = Math.min(this.sel, Math.max(0, list.length - 1));
    this.listEl.textContent = '';
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'pl-empty';
      e.textContent = 'No match';
      this.listEl.appendChild(e);
      return;
    }
    list.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'pl-row' + (i === this.sel ? ' sel' : '');
      row.setAttribute('role', 'option');
      const n = document.createElement('span');
      n.className = 'pl-name';
      n.textContent = it.name;
      const h = document.createElement('span');
      h.className = 'pl-hint';
      h.textContent = it.hint || '';
      row.append(n, h);
      row.addEventListener('click', () => this.run(i));
      this.listEl.appendChild(row);
      if (i === this.sel) row.scrollIntoView({ block: 'nearest' });
    });
  }

  run(i) {
    const it = this.filtered()[i];
    if (!it) return;
    this.box.hidden = true;
    // let the pane regain focus before the command acts on it
    it.run();
    const t = this.ctx.tabs.active;
    if (t && !it.keepClosed) t.session.term.focus();
  }

  insert(s) {
    const t = this.ctx.tabs.active;
    if (!t) return;
    t.session.pasteText(s.text);
    if (s.run) t.session.type('\r');
  }

  addSnippet() {
    const name = (prompt('Snippet name:') || '').trim();
    if (!name) return;
    const text = prompt('Text to insert (use \\n for a new line):');
    if (!text) return;
    const run = confirm('Press Enter after inserting it ("run")?\nOK = run immediately, Cancel = only insert.');
    const list = Snippets.load().filter((s) => s.name !== name);
    list.push({ name: name.slice(0, 80), text: text.replace(/\\n/g, '\n'), run });
    Snippets.save(list.slice(-MAX_SNIPPETS));
    this.ctx.tabs.toast('Snippet "' + name + '" saved');
  }

  deleteSnippet(s) {
    if (!confirm('Delete snippet "' + s.name + '"?')) return;
    Snippets.save(Snippets.load().filter((x) => x.name !== s.name));
    this.ctx.tabs.toast('Snippet deleted');
  }
}
