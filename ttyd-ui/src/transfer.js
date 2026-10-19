'use strict';
/*
 * File transfer without https. trzsz.js (trz / tsz) is hard-wired to the browser's File System Access API
 * (showOpenFilePicker / showDirectoryPicker), which only exists in desktop Chromium over https. Where it is missing
 * we install small stand-ins with the same shape:
 *   - upload: a sheet with a normal <input type=file> (the tap on it is the user gesture a file chooser needs)
 *   - download: a directory whose files are collected in memory and handed to the browser as a normal download
 * Dropping files onto a pane is handled in Session (uploadFiles), which needs neither.
 */
const Transfer = (() => {
  const MAX_DOWNLOAD = 1024 * 1024 * 1024;   // downloads are held in memory until the file is complete

  const abort = () => new DOMException('cancelled', 'AbortError');

  /** Sheet with a file input; resolves the chosen File list, or null when dismissed. */
  function chooseFiles({ directory, multiple }) {
    return new Promise((resolve) => {
      const card = TouchTools.openSheet(directory ? 'Upload a folder' : 'Upload files', () => resolve(null));
      card.appendChild(TouchTools.h('div', 'sh-hint', 'Choose what to send to the server.'));
      const input = document.createElement('input');
      input.type = 'file';
      input.className = 'sh-file';
      if (multiple) input.multiple = true;
      if (directory) input.webkitdirectory = true;
      input.addEventListener('change', () => {
        const files = [...input.files];
        resolve(files.length ? files : null);
        TouchTools.closeSheet();
      });
      card.appendChild(input);
      const row = TouchTools.h('div', 'sh-row');
      row.appendChild(TouchTools.button('Cancel', TouchTools.closeSheet));
      card.appendChild(row);
    });
  }

  const fileHandle = (file, name) => ({ kind: 'file', name: name || file.name, getFile: async () => file });

  /** Read-only directory handles built from <input webkitdirectory> results (webkitRelativePath = "dir/sub/file"). */
  function buildTree(files) {
    const root = { dirs: new Map(), files: new Map() };
    for (const f of files) {
      const parts = f.webkitRelativePath.split('/');
      let node = root;
      for (const p of parts.slice(0, -1)) {
        if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: new Map() });
        node = node.dirs.get(p);
      }
      node.files.set(parts[parts.length - 1], f);
    }
    return root;
  }
  function toHandle(name, node) {
    const kids = new Map();
    for (const [n, d] of node.dirs) kids.set(n, toHandle(n, d));
    for (const [n, f] of node.files) kids.set(n, fileHandle(f, n));
    return {
      kind: 'directory',
      name,
      async *values() { yield* kids.values(); },
      async getFileHandle(n) { return kids.get(n); },
      async getDirectoryHandle(n) { return kids.get(n); },
    };
  }

  function saveBlob(name, parts) {
    const url = URL.createObjectURL(new Blob(parts));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /** A "directory" that turns every file written into a browser download. */
  function downloadDir(name, prefix) {
    return {
      kind: 'directory',
      name,
      async *values() { /* nothing exists yet, so trzsz never has to rename */ },
      async getDirectoryHandle(n) { return downloadDir(n, prefix + n + '_'); },
      async getFileHandle(n) {
        return {
          kind: 'file',
          name: n,
          async createWritable() {
            const parts = [];
            let size = 0;
            return {
              async write(chunk) {
                size += chunk.byteLength;
                if (size > MAX_DOWNLOAD) throw new Error('File too large for a browser download (limit 1 GiB); use https + Chromium, or scp.');
                parts.push(new Uint8Array(chunk));   // copy: the sender may reuse its buffer
              },
              async close() { saveBlob(prefix + n, parts); },
            };
          },
        };
      },
    };
  }

  function install() {
    if (typeof window.showOpenFilePicker !== 'function') {
      window.showOpenFilePicker = async (opts) => {
        const files = await chooseFiles({ directory: false, multiple: !opts || opts.multiple !== false });
        if (!files) throw abort();
        return files.map((f) => fileHandle(f));
      };
    }
    if (typeof window.showDirectoryPicker !== 'function') {
      window.showDirectoryPicker = async (opts) => {
        if (opts && opts.mode === 'readwrite') return downloadDir('browser downloads', '');   // tsz
        const files = await chooseFiles({ directory: true, multiple: true });   // trz -d
        if (!files) throw abort();
        const top = files[0].webkitRelativePath.split('/')[0];
        return toHandle(top, buildTree(files).dirs.get(top));
      };
    }
  }

  return { install };
})();
