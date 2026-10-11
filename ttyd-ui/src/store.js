'use strict';
/* Tab list persistence (localStorage). Tab ids double as tmux session names on the server. */

const STORE_KEY = 'ttyd-ui.tabs.v1';
const ID_RE = /^t[0-9a-f]{10}$/; // must match the whitelist in the server-side ttyd-session wrapper
const HOST_RE = /^[a-z0-9_-]{1,32}$/; // saved-host key, same rule as the wrapper
const validHost = (h) => typeof h === 'string' && HOST_RE.test(h);   // (RegExp.test(undefined) would match 'undefined')

const Store = {
  /** @returns {{tabs: {id,title,userRenamed,host,layout,focus}[], active: string|null}} */
  load() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY));
      if (v && Array.isArray(v.tabs)) {
        const tabs = v.tabs
          .filter((t) => t && ID_RE.test(t.id))
          .map((t) => {
            const host = validHost(t.host) ? t.host : '';
            // v1 tabs had no layout: they are a single pane whose session id is the tab id
            const layout = Layout.validate(t.layout) || { id: t.id, host };
            const focus = Layout.leaves(layout).some((l) => l.id === t.focus) ? t.focus : Layout.leaves(layout)[0].id;
            return { id: t.id, title: String(t.title || ''), userRenamed: !!t.userRenamed, host, layout, focus };
          });
        return { tabs, active: v.active };
      }
    } catch (e) { /* corrupt or unavailable: start fresh */ }
    return { tabs: [], active: null };
  },

  save(tabs, active) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        tabs: tabs.map((t) => ({ id: t.id, title: t.title, userRenamed: t.userRenamed, host: t.host || '', layout: t.layout, focus: t.focus })),
        active,
      }));
    } catch (e) { /* storage full/blocked: persistence is best-effort */ }
  },
};
