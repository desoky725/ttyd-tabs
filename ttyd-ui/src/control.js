'use strict';
/*
 * Server-side session management through ttyd itself: a short-lived websocket whose ?arg= values run
 * one of the whitelisted modes of the ttyd-session wrapper ('list' / 'kill <id>'). No extra endpoint,
 * no change to ttyd. Output comes back as normal terminal output frames.
 */

function ttydControl(args, timeoutMs = 6000, endMarker = 'TTYD-LIST-END') {
  return new Promise((resolve, reject) => {
    const query = '?' + args.map((a) => 'arg=' + encodeURIComponent(a)).join('&');
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let ws;
    let out = '';
    let done = false;
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) { /* ignore */ }
      if (err) reject(err); else resolve(out);
    }
    (async () => {
      let token = '';
      try {
        const r = await fetch(ttydUrls().token, { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok) token = (await r.json()).token || '';
      } catch (e) { /* ignore: the socket attempt reports failure */ }
      if (done) return;
      try { ws = new WebSocket(ttydUrls(query).ws, ['tty']); } catch (e) { finish(e); return; }
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(enc.encode(JSON.stringify({ AuthToken: token, columns: 200, rows: 24 })));
      ws.onmessage = (ev) => {
        const b = new Uint8Array(ev.data);
        if (b[0] === 0x30 /* '0' = output */) {
          out += dec.decode(b.subarray(1), { stream: true });
          if (out.slice(-(endMarker.length + 600)).includes(endMarker)) finish();   // tail only: captures can be MBs
        }
      };
      ws.onclose = () => finish();
      ws.onerror = () => finish(new Error('connection failed'));
    })();
  });
}

/** @returns {Promise<{id,created,activity,attached,title}[]>} (created/activity are epoch seconds) */
async function listSessions() {
  let m = null;
  for (let attempt = 0; attempt < 2 && !m; attempt++) {   // one retry: a reply can still be cut short
    const out = (await ttydControl(['list'])).replace(/\r/g, '');
    m = out.match(/TTYD-LIST-BEGIN\n([\s\S]*?)TTYD-LIST-END/);
  }
  if (!m) throw new Error('unexpected reply from server');
  return m[1].split('\n').filter(Boolean).map((line) => {
    const [name, created, activity, attached, ...title] = line.split(' ');
    return { id: String(name).replace(/^ttyd-/, ''), created: +created, activity: +activity, attached: +attached, title: title.join(' ') };
  }).filter((s) => ID_RE.test(s.id));
}

const killSession = (id) => ttydControl(['kill', id]);

/** Saved hosts from the server's hosts file: [{key, label}] (the built-in default login is not included). */
async function listHosts() {
  let m = null;
  for (let attempt = 0; attempt < 2 && !m; attempt++) {
    const out = (await ttydControl(['hosts'], 6000, 'TTYD-HOSTS-END')).replace(/\r/g, '');
    m = out.match(/TTYD-HOSTS-BEGIN\n([\s\S]*?)TTYD-HOSTS-END/);
  }
  if (!m) throw new Error('unexpected reply from server');
  return m[1].split('\n').filter(Boolean).map((line) => {
    const i = line.indexOf(' ');
    return { key: line.slice(0, i), label: line.slice(i + 1) };
  }).filter((h) => HOST_RE.test(h.key) && h.label);
}

/** Plain-text scrollback (tmux history + screen) of a session, as an array of lines. */
async function captureSession(id) {
  let m = null;
  for (let attempt = 0; attempt < 2 && !m; attempt++) {
    const out = (await ttydControl(['capture', id], 20000, 'TTYD-CAP-END')).replace(/\r/g, '');
    m = out.match(/TTYD-CAP-BEGIN\n([\s\S]*)TTYD-CAP-END/);
  }
  if (!m) throw new Error('unexpected reply from server');
  return m[1].split('\n').map((l) => l.replace(/\s+$/, ''));   // tmux pads lines with spaces
}

function ago(epochSec) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
}

/** Dropdown listing server sessions that are not open as a tab in this browser (orphans). */
class SessionsPanel {
  constructor(panelEl, buttonEl, tabs) {
    this.panelEl = panelEl;
    this.tabs = tabs;
    buttonEl.addEventListener('click', () => (this.panelEl.hidden ? this.open() : this.close()));
    document.addEventListener('click', (e) => {
      if (!this.panelEl.hidden && !this.panelEl.contains(e.target) && !buttonEl.contains(e.target)) this.close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.panelEl.hidden) this.close(); });
  }

  close() { this.panelEl.hidden = true; }

  open() {
    this.panelEl.hidden = false;
    this.refresh();
  }

  async refresh() {
    this._render('Loading...');
    let list;
    try { list = await listSessions(); } catch (e) { this._render('Could not list sessions: ' + e.message, true); return; }
    const open = new Set(this.tabs.tabs.flatMap((t) => t.panes.map((p) => p.id)));
    this._render(null, list.filter((s) => !open.has(s.id)));
  }

  _render(message, orphans) {
    const p = this.panelEl;
    p.textContent = '';
    const head = document.createElement('div');
    head.className = 'sp-head';
    const h = document.createElement('span');
    h.textContent = 'Sessions on server not open here';
    const r = document.createElement('button');
    r.textContent = '↻';
    r.title = 'Refresh';
    r.addEventListener('click', () => this.refresh());
    head.append(h, r);
    p.appendChild(head);

    if (message || !orphans.length) {
      const m = document.createElement('div');
      m.className = 'sp-empty';
      m.textContent = message || 'No orphaned sessions.';
      p.appendChild(m);
      return;
    }
    for (const s of orphans) {
      const row = document.createElement('div');
      row.className = 'sp-row';
      const info = document.createElement('div');
      info.className = 'sp-info';
      const t = document.createElement('div');
      t.className = 'sp-title';
      t.textContent = s.title || s.id;
      const sub = document.createElement('div');
      sub.className = 'sp-sub';
      sub.textContent = s.id + ' · active ' + ago(s.activity) + (s.attached ? ' · open in another browser' : '');
      info.append(t, sub);
      const attach = document.createElement('button');
      attach.textContent = 'Attach';
      attach.addEventListener('click', () => { this.close(); this.tabs.newTab({ id: s.id, title: s.title }); });
      const kill = document.createElement('button');
      kill.textContent = 'Kill';
      kill.className = 'danger';
      kill.addEventListener('click', async () => {
        if (!confirm('Kill session "' + (s.title || s.id) + '"? Any running command in it is terminated.')) return;
        try { await killSession(s.id); } catch (e) { this.tabs.toast('Kill failed: ' + e.message); }
        this.refresh();
      });
      row.append(info, attach, kill);
      p.appendChild(row);
    }
  }
}
