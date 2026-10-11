'use strict';
/*
 * "+" menu with the saved hosts (server-side file /etc/ttyd-hosts, see hosts.conf). The browser only learns key +
 * label; a new tab sends just the key and the server runs the command saved under it. With no saved hosts the
 * "+" button simply opens a default tab.
 */
class HostMenu {
  constructor(menuEl, buttonEl, tabs) {
    this.menuEl = menuEl;
    this.tabs = tabs;
    this.hosts = [];
    this.refresh();
    buttonEl.addEventListener('click', () => {
      if (!this.menuEl.hidden) { this.close(); return; }
      if (!this.hosts.length) { this.tabs.newTab(); this.refresh(); return; }   // nothing to choose from
      this.open();
    });
    document.addEventListener('click', (e) => {
      if (!this.menuEl.hidden && !this.menuEl.contains(e.target) && !buttonEl.contains(e.target)) this.close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.menuEl.hidden) this.close(); });
  }

  async refresh() {
    try { this.hosts = await listHosts(); } catch (e) { /* keep the previous list; "+" still opens a default tab */ }
  }

  close() { this.menuEl.hidden = true; }

  open() {
    const m = this.menuEl;
    m.textContent = '';
    const add = (label, host) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => {
        this.close();
        this.tabs.newTab(host ? { host, title: label } : {});
      });
      m.appendChild(b);
    };
    add('Default (login)', '');
    for (const h of this.hosts) add(h.label, h.key);
    m.hidden = false;
    this.refresh();   // pick up edits of the hosts file for the next time
  }
}
