'use strict';
/*
 * Scrollback search. Under tmux the browser's own scrollback is empty (tmux owns the history), so xterm's
 * search addon would find nothing. Instead the server dumps the active session's tmux history as plain text
 * (ttyd-session capture <id>) and this panel greps that snapshot: a list of matching lines, newest first.
 * It is a snapshot taken when the panel opens (or on refresh), not a live view.
 */
const SEARCH_MAX_RESULTS = 300;

class ScrollbackSearch {
  constructor(panelEl, buttonEl, tabs) {
    this.panelEl = panelEl;
    this.tabs = tabs;
    this.lines = [];
    this.tabId = null;
    this.seq = 0;

    panelEl.innerHTML =
      '<div class="ss-head"><input type="search" placeholder="Search scrollback of this tab" aria-label="Search scrollback">' +
      '<button class="ss-refresh" title="Reload history">&#8635;</button><button class="ss-close" title="Close (Esc)">&times;</button></div>' +
      '<div class="ss-info"></div><div class="ss-results"></div>';
    this.input = panelEl.querySelector('input');
    this.info = panelEl.querySelector('.ss-info');
    this.results = panelEl.querySelector('.ss-results');

    buttonEl.addEventListener('click', () => (this.panelEl.hidden ? this.open() : this.close()));
    panelEl.querySelector('.ss-close').addEventListener('click', () => this.close());
    panelEl.querySelector('.ss-refresh').addEventListener('click', () => this.load());
    let t;
    this.input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => this.render(), 150); });
    panelEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } });
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyF') {
        e.preventDefault(); e.stopPropagation();
        this.open();
      }
    }, true);
  }

  open() {
    if (!this.tabs.active) return;
    this.panelEl.hidden = false;
    this.input.focus();
    this.input.select();
    this.load();
  }

  close() {
    this.panelEl.hidden = true;
    this.seq++;
    if (this.tabs.active) this.tabs.active.session.term.focus();
  }

  async load() {
    const tab = this.tabs.active;
    if (!tab) return;
    const seq = ++this.seq;
    this.tabId = tab.focus;   // the focused pane of the tab
    this.lines = [];
    this.info.textContent = 'Loading history...';
    this.results.textContent = '';
    try {
      const lines = await captureSession(tab.focus);
      if (seq !== this.seq) return;
      this.lines = lines;
    } catch (e) {
      if (seq === this.seq) this.info.textContent = 'Could not load history: ' + e.message;
      return;
    }
    this.render();
  }

  render() {
    const q = this.input.value.toLowerCase();
    this.results.textContent = '';
    if (!this.lines.length) { this.info.textContent = 'No history.'; return; }
    if (!q) { this.info.textContent = this.lines.length + ' lines loaded. Type to search.'; return; }
    let total = 0;
    const frag = document.createDocumentFragment();
    for (let i = this.lines.length - 1; i >= 0; i--) {     // newest first
      const line = this.lines[i];
      const at = line.toLowerCase().indexOf(q);
      if (at < 0) continue;
      total++;
      if (total > SEARCH_MAX_RESULTS) continue;            // keep counting, stop rendering
      const row = document.createElement('div');
      row.className = 'ss-row';
      const no = document.createElement('span');
      no.className = 'ss-no';
      no.textContent = String(i + 1);
      const text = document.createElement('span');
      text.className = 'ss-text';
      const mark = document.createElement('mark');
      mark.textContent = line.slice(at, at + q.length);
      text.append(line.slice(0, at), mark, line.slice(at + q.length));
      row.append(no, text);
      row.addEventListener('click', () => {
        const sel = window.getSelection();
        sel.selectAllChildren(text);
      });
      frag.appendChild(row);
    }
    this.results.appendChild(frag);
    this.info.textContent = total
      ? total + (total === 1 ? ' match' : ' matches') + (total > SEARCH_MAX_RESULTS ? ' (showing the newest ' + SEARCH_MAX_RESULTS + ')' : '')
      : 'No matches.';
  }
}
