// Builds dist/index.html: one self-contained file (no runtime requests). No dependencies; Node >= 18.
//   node build.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

// 1. Verify vendored libs against the pinned checksums.
for (const line of read('vendor', 'SHA256SUMS').trim().split('\n')) {
  const [sum, name] = line.trim().split(/\s+/);
  const actual = createHash('sha256').update(readFileSync(join(root, 'vendor', name))).digest('hex');
  if (actual !== sum) throw new Error(`vendor/${name}: checksum mismatch (expected ${sum}, got ${actual})`);
}

// 2. Assemble. Strip sourcemap comments; neutralise anything that could close the inline tag.
const stripMap = (s) => s.replace(/^\s*\/\/# sourceMappingURL=.*$/gm, '').replace(/\/\*# sourceMappingURL=.*?\*\//g, '');
const safeJs = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const safeCss = (s) => s.replace(/<\/(style)/gi, '<\\/$1');

const css = [stripMap(read('vendor', 'xterm.css')), read('src', 'app.css')].map(safeCss).join('\n');
const js = [
  stripMap(read('vendor', 'xterm.js')),
  stripMap(read('vendor', 'addon-fit.js')),
  stripMap(read('vendor', 'addon-webgl.js')),
  stripMap(read('vendor', 'addon-web-links.js')),
  stripMap(read('vendor', 'trzsz.js')),
  read('src', 'themes.js'),
  read('src', 'session.js'),
  read('src', 'layout.js'),
  read('src', 'store.js'),
  read('src', 'control.js'),
  read('src', 'search.js'),
  read('src', 'hosts.js'),
  read('src', 'keybar.js'),
  read('src', 'palette.js'),
  read('src', 'tabs.js'),
  read('src', 'main.js'),
].map(safeJs).join(';\n');

// Function replacers: "$&" etc. in the minified libs must not be interpreted as replacement patterns.
const html = read('src', 'index.template.html')
  .replace('/*INLINE_CSS*/', () => css)
  .replace('/*INLINE_JS*/', () => js);

if (/<(script|link)[^>]+(src|href)=["']https?:/i.test(html)) throw new Error('external resource reference found');

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'index.html'), html);
console.log(`dist/index.html written (${(html.length / 1024).toFixed(0)} KiB)`);
