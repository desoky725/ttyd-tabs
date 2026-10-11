'use strict';
/*
 * Split-pane layout of one tab: a binary tree.
 *   leaf  : { id, host }                  id = tmux session id of that pane, host = saved-host key or ''
 *   split : { dir, ratio, a, b }          dir 'h' = a left | b right, 'v' = a above / b below; ratio = share of a
 * Pure functions on plain JSON (the tree is what gets saved in localStorage). Positions are fractions 0..1 of the tab area.
 */
const MAX_PANES = 4;
const RATIO_MIN = 0.1;

const Layout = {
  isLeaf: (n) => !!n && typeof n.id === 'string',

  leaves(n) { return Layout.isLeaf(n) ? [n] : [...Layout.leaves(n.a), ...Layout.leaves(n.b)]; },

  /** Untrusted (localStorage) JSON -> a clean tree, or null. Ids/hosts must satisfy the same rules as the server whitelist. */
  validate(n, depth = 0, seen = new Set()) {
    if (!n || typeof n !== 'object' || depth > 3) return null;
    if (typeof n.id === 'string') {
      if (!ID_RE.test(n.id) || seen.has(n.id) || seen.size >= MAX_PANES) return null;
      seen.add(n.id);
      return { id: n.id, host: validHost(n.host) ? n.host : '' };
    }
    if (n.dir !== 'h' && n.dir !== 'v') return null;
    const a = Layout.validate(n.a, depth + 1, seen);
    const b = a && Layout.validate(n.b, depth + 1, seen);
    if (!a || !b) return null;
    const r = Number(n.ratio);
    return { dir: n.dir, ratio: r >= RATIO_MIN && r <= 1 - RATIO_MIN ? r : 0.5, a, b };
  },

  /** Replace leaf `id` by a split holding the old leaf and `newLeaf`. */
  split(n, id, dir, newLeaf) {
    if (Layout.isLeaf(n)) return n.id === id ? { dir, ratio: 0.5, a: n, b: newLeaf } : n;
    return { ...n, a: Layout.split(n.a, id, dir, newLeaf), b: Layout.split(n.b, id, dir, newLeaf) };
  },

  /** Remove leaf `id`; its sibling takes the parent's place. Returns null if it was the only leaf. */
  remove(n, id) {
    if (Layout.isLeaf(n)) return n.id === id ? null : n;
    const a = Layout.remove(n.a, id);
    const b = Layout.remove(n.b, id);
    if (!a) return b;
    if (!b) return a;
    return { ...n, a, b };
  },

  /** Map leaf id -> {x,y,w,h}. */
  rects(n, r = { x: 0, y: 0, w: 1, h: 1 }, out = {}) {
    if (Layout.isLeaf(n)) { out[n.id] = r; return out; }
    const [ra, rb] = Layout.cut(n, r);
    Layout.rects(n.a, ra, out);
    Layout.rects(n.b, rb, out);
    return out;
  },

  cut(n, r) {
    return n.dir === 'h'
      ? [{ ...r, w: r.w * n.ratio }, { ...r, x: r.x + r.w * n.ratio, w: r.w * (1 - n.ratio) }]
      : [{ ...r, h: r.h * n.ratio }, { ...r, y: r.y + r.h * n.ratio, h: r.h * (1 - n.ratio) }];
  },

  /** All split nodes with the area they divide: [{node, rect}] (for the draggable dividers). */
  splits(n, r = { x: 0, y: 0, w: 1, h: 1 }, out = []) {
    if (Layout.isLeaf(n)) return out;
    out.push({ node: n, rect: r });
    const [ra, rb] = Layout.cut(n, r);
    Layout.splits(n.a, ra, out);
    Layout.splits(n.b, rb, out);
    return out;
  },

  /** Nearest pane from `from` in direction 'left'|'right'|'up'|'down' that overlaps it on the other axis, or null. */
  neighbor(rects, from, dir) {
    const f = rects[from];
    const eps = 1e-6;
    let best = null;
    for (const [id, r] of Object.entries(rects)) {
      if (id === from) continue;
      let gap; let overlap;
      if (dir === 'left') { gap = f.x - (r.x + r.w); overlap = Math.min(f.y + f.h, r.y + r.h) - Math.max(f.y, r.y); }
      else if (dir === 'right') { gap = r.x - (f.x + f.w); overlap = Math.min(f.y + f.h, r.y + r.h) - Math.max(f.y, r.y); }
      else if (dir === 'up') { gap = f.y - (r.y + r.h); overlap = Math.min(f.x + f.w, r.x + r.w) - Math.max(f.x, r.x); }
      else { gap = r.y - (f.y + f.h); overlap = Math.min(f.x + f.w, r.x + r.w) - Math.max(f.x, r.x); }
      if (gap < -eps || overlap <= eps) continue;
      if (!best || gap < best.gap - eps || (Math.abs(gap - best.gap) <= eps && overlap > best.overlap)) best = { id, gap, overlap };
    }
    return best && best.id;
  },
};
