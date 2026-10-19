'use strict';
/*
 * On-screen key bar for touch screens: the keys a phone keyboard lacks (Esc, Tab, Ctrl, arrows, | ~ / ...).
 * Shown by default on coarse-pointer devices; the keyboard button in the top bar (or the palette) toggles it.
 * Buttons never take focus away from the terminal, so the soft keyboard stays up. Ctrl and Alt are one-shot:
 * tap, then type one key on the soft keyboard (or tap a bar key).
 */
const KEYBAR_KEY = 'ttyd-ui.keybar.v1';

class KeyBar {
  constructor(el, buttonEl, tabs) {
    this.el = el;
    this.tabs = tabs;
    let on;
    try { on = localStorage.getItem(KEYBAR_KEY); } catch (e) { on = null; }
    this.setVisible(on === null ? window.matchMedia('(pointer: coarse)').matches : on === '1', false);
    buttonEl.addEventListener('click', () => this.toggle());
    window.addEventListener('ttyd:mods', () => this._syncMods());
    this._build();
  }

  toggle() { this.setVisible(this.el.hidden); }

  setVisible(v, save = true) {
    this.el.hidden = !v;
    if (save) { try { localStorage.setItem(KEYBAR_KEY, v ? '1' : '0'); } catch (e) { /* best effort */ } }
  }

  _build() {
    const A = (s) => () => { const t = this.tabs.active; return '\x1b' + (t && t.session.term.modes.applicationCursorKeysMode ? 'O' : '[') + s; };
    const keys = [
      ['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl', 'mod:ctrl'], ['Alt', 'mod:alt'],
      ['←', A('D')], ['↓', A('B')], ['↑', A('A')], ['→', A('C')],
      ['Home', '\x1b[H'], ['End', '\x1b[F'], ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~'],
      ['|', '|'], ['~', '~'], ['/', '/'], ['\\', '\\'], ['-', '-'], ['_', '_'], ['`', '`'], [':', ':'],
      ['Paste', 'paste'], ['Select', 'select'], ['Copy', 'copy'], ['Links', 'links'],
    ];
    for (const [label, val] of keys) {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.key = label;
      if (typeof val === 'string' && val.startsWith('mod:')) b.dataset.mod = val.slice(4);
      // pointerdown + preventDefault: the button never becomes the focused element
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => this._press(val, b));
      this.el.appendChild(b);
    }
  }

  _press(val, btn) {
    const tab = this.tabs.active;
    if (!tab) return;
    const s = tab.session;
    if (btn.dataset.mod) {
      s.setMod(btn.dataset.mod, !s.mods[btn.dataset.mod]);
    } else if (val === 'paste') {
      if (navigator.clipboard && navigator.clipboard.readText) s.pasteFromClipboard();
      else { TouchTools.showPasteSheet((text) => { s.term.paste(text); s.term.focus(); }); return; }
    } else if (val === 'select') {
      s.setSelectMode(!s.selectMode);
      if (s.selectMode) this.tabs.toast('Drag over text to select it, or tap a word. Then tap Copy.');
      return;   // leave the soft keyboard as it is
    } else if (val === 'copy') {
      const text = s.term.getSelection();
      if (!text) { this.tabs.toast('Nothing selected. Tap Select, then drag over the text.'); return; }
      s.setSelectMode(false);
      TouchTools.copyText(text).then((ok) => { if (ok) this.tabs.toast('Copied'); else TouchTools.showCopySheet(text); });
    } else if (val === 'links') {
      TouchTools.showLinks(s.term);
      return;
    } else {
      s.type(typeof val === 'function' ? val() : val);
    }
    s.term.focus();
  }

  _syncMods() {
    const t = this.tabs.active;
    for (const b of this.el.querySelectorAll('button[data-mod]')) {
      b.classList.toggle('armed', !!(t && t.session.mods[b.dataset.mod]));
      b.setAttribute('aria-pressed', b.classList.contains('armed') ? 'true' : 'false');
    }
    const sel = this.el.querySelector('button[data-key="Select"]');
    if (sel) {
      sel.classList.toggle('armed', !!(t && t.session.selectMode));
      sel.setAttribute('aria-pressed', sel.classList.contains('armed') ? 'true' : 'false');
    }
  }
}
