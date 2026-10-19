'use strict';
/*
 * Touch helpers for the key bar: copy to the clipboard (also over plain http), a paste box for when the browser
 * will not let a page read the clipboard, and a list of the links found in the terminal output (open / copy).
 * Over http the async clipboard API does not exist, so copying falls back to execCommand('copy') from a real tap
 * and, if even that is refused, to a box with the text selected for the browser's own Copy menu.
 */
const TouchTools = (() => {
  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.readOnly = true;
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* refused */ }
    ta.remove();
    return ok;
  }

  /** Resolves true when the text is on the clipboard. Call it straight from a tap handler. */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
  }

  // ---- bottom sheet ----------------------------------------------------------------------------
  let box = null;
  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const onEsc = (e) => { if (e.key === 'Escape') closeSheet(); };

  let onClose = null;
  function closeSheet() {
    if (!box) return;
    box.remove();
    box = null;
    document.removeEventListener('keydown', onEsc, true);
    const cb = onClose;
    onClose = null;
    if (cb) cb();
  }

  /** onDismiss runs whenever the sheet closes, however it was closed. */
  function openSheet(title, onDismiss) {
    closeSheet();
    onClose = onDismiss || null;
    box = h('div');
    box.id = 'sheet-box';
    box.addEventListener('pointerdown', (e) => { if (e.target === box) closeSheet(); });
    const card = h('div', 'sh-card');
    card.appendChild(h('div', 'sh-title', title));
    box.appendChild(card);
    document.body.appendChild(box);
    document.addEventListener('keydown', onEsc, true);
    return card;
  }

  const button = (label, onClick, primary) => {
    const b = h('button', primary ? 'sh-btn primary' : 'sh-btn', label);
    b.addEventListener('click', onClick);
    return b;
  };

  /** The browser refused to copy: show the text selected so a long-press offers the native Copy. */
  function showCopySheet(text) {
    const card = openSheet('Copy');
    card.appendChild(h('div', 'sh-hint', 'Automatic copy is blocked here (it needs https). Press and hold the text, then choose Copy.'));
    const ta = h('textarea', 'sh-text');
    ta.value = text;
    ta.readOnly = true;
    card.appendChild(ta);
    const row = h('div', 'sh-row');
    row.appendChild(button('Close', closeSheet));
    card.appendChild(row);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
  }

  /** The page cannot read the clipboard: let the user paste into a box, then send it to the terminal. */
  function showPasteSheet(send) {
    const card = openSheet('Paste');
    card.appendChild(h('div', 'sh-hint', 'Press and hold in the box, choose Paste, then tap Send.'));
    const ta = h('textarea', 'sh-text');
    ta.placeholder = 'Paste here';
    card.appendChild(ta);
    const row = h('div', 'sh-row');
    row.appendChild(button('Cancel', closeSheet));
    row.appendChild(button('Send', () => { const v = ta.value; closeSheet(); if (v) send(v); }, true));
    card.appendChild(row);
    ta.focus();
  }

  // ---- links in the terminal -------------------------------------------------------------------
  const URL_RE = /https?:\/\/[^\s<>"'`\\^{}|]+/g;

  function cleanUrl(u) {
    for (;;) {
      const last = u[u.length - 1];
      if (/[.,;:!?'"*]/.test(last)) u = u.slice(0, -1);
      else if ((last === ')' && !u.includes('(')) || (last === ']' && !u.includes('['))) u = u.slice(0, -1);
      else return u;
    }
  }

  /**
   * http(s) links in the last lines of the buffer, newest first, without duplicates. Lines the terminal wrapped are
   * joined; so is a full-width line that ends inside a link (tmux does not always mark its wraps).
   */
  function findLinks(term, maxLines = 1500) {
    const buf = term.buffer.active;
    const cols = term.cols;
    const logical = [];
    let cur = '';
    for (let y = Math.max(0, buf.length - maxLines); y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const trimmed = line.translateToString(true);
      const next = buf.getLine(y + 1);
      const nextText = next ? next.translateToString(true) : '';
      const cont = !!next && (next.isWrapped || (trimmed.length >= cols && /https?:\/\/\S*$/.test(trimmed) && /^\S/.test(nextText)));
      cur += cont ? line.translateToString(false) : trimmed;
      if (!cont) { logical.push(cur); cur = ''; }
    }
    if (cur) logical.push(cur);
    const seen = new Set();
    const out = [];
    for (let i = logical.length - 1; i >= 0; i--) {
      const m = logical[i].match(URL_RE);
      if (!m) continue;
      for (let j = m.length - 1; j >= 0; j--) {
        const u = cleanUrl(m[j]);
        if (u.length > 8 && !seen.has(u)) { seen.add(u); out.push(u); }
      }
    }
    return out;
  }

  function showLinks(term) {
    const links = findLinks(term).slice(0, 40);
    const card = openSheet('Links in the terminal');
    if (!links.length) card.appendChild(h('div', 'sh-hint', 'No links found in the terminal output.'));
    const list = h('div', 'sh-list');
    for (const u of links) {
      const row = h('div', 'sh-link');
      row.appendChild(h('div', 'sh-url', u));
      const acts = h('div', 'sh-row');
      const a = h('a', 'sh-btn primary', 'Open');
      a.href = u;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      acts.appendChild(a);
      const c = button('Copy', () => copyText(u).then((ok) => {
        if (ok) { c.textContent = 'Copied'; setTimeout(() => { c.textContent = 'Copy'; }, 1500); } else showCopySheet(u);
      }));
      acts.appendChild(c);
      row.appendChild(acts);
      list.appendChild(row);
    }
    card.appendChild(list);
    const row = h('div', 'sh-row');
    row.appendChild(button('Close', closeSheet));
    card.appendChild(row);
  }

  return { copyText, showCopySheet, showPasteSheet, showLinks, findLinks, closeSheet, openSheet, button, h };
})();
