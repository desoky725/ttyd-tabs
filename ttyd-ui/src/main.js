'use strict';

Themes.applyChrome(Themes.currentId());
Transfer.install();   // file pickers for trz/tsz where the browser has none (plain http, phones, Firefox, Safari)

const tabs = new Tabs(
  document.getElementById('tabs'),
  document.getElementById('panes'),
  document.getElementById('toast')
);

new SessionsPanel(document.getElementById('sessions-panel'), document.getElementById('sessions'), tabs);
document.getElementById('split-h').addEventListener('click', () => tabs.split('h'));
document.getElementById('split-v').addEventListener('click', () => tabs.split('v'));
const search = new ScrollbackSearch(document.getElementById('search-panel'), document.getElementById('search'), tabs);

// Mobile: the on-screen keyboard shrinks the visual viewport but not the layout viewport on iOS.
// Track it so the terminal fits above the keyboard.
if (window.visualViewport) {
  const setH = () => document.documentElement.style.setProperty('--app-h', window.visualViewport.height + 'px');
  window.visualViewport.addEventListener('resize', setH);
  setH();
}

const hostMenu = new HostMenu(document.getElementById('hosts-menu'), document.getElementById('new'), tabs);
const keybar = new KeyBar(document.getElementById('keybar'), document.getElementById('keybar-toggle'), tabs);
const palette = new Palette(document.getElementById('palette-box'), document.getElementById('palette'), { tabs, keybar, hostMenu, search });
tabs.restore();
Object.assign(window, { hostMenu, keybar, palette });
window.tabs = tabs; // handy for debugging in the console
