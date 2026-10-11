'use strict';
/*
 * Colour themes (presets). Each one gives the terminal's 16 colours (`term`) and the page chrome (`ui`); the chrome
 * becomes CSS variables on <html>. The choice is kept in this browser (localStorage). Default: Dracula.
 *   ui: bg bar tab tabActive fg muted accent hover border input dim  (+ optional green amber red; default from term)
 */
const THEME_KEY = 'ttyd-ui.theme.v1';

const THEMES = {
  dracula: {
    name: 'Dracula', dark: true,
    term: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
    ui: { bg: '#1e1f29', bar: '#191a22', tab: '#21222c', tabActive: '#282a36', fg: '#f8f8f2', muted: '#6272a4', accent: '#bd93f9', hover: '#44475a', border: '#000000', input: '#000000', dim: '#9aa0c0' },
  },
  tokyonight: {
    name: 'Tokyo Night', dark: true,
    term: {
      background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#1a1b26', selectionBackground: '#33467c',
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
    ui: { bg: '#16161e', bar: '#101014', tab: '#16161e', tabActive: '#1a1b26', fg: '#c0caf5', muted: '#565f89', accent: '#7aa2f7', hover: '#2f334d', border: '#0b0b10', input: '#101014', dim: '#787c99' },
  },
  nord: {
    name: 'Nord', dark: true,
    term: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#434c5e',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
    ui: { bg: '#242933', bar: '#242933', tab: '#2b303b', tabActive: '#2e3440', fg: '#d8dee9', muted: '#616e88', accent: '#88c0d0', hover: '#434c5e', border: '#1c2028', input: '#1c2028', dim: '#9aa5b8' },
  },
  gruvbox: {
    name: 'Gruvbox Dark', dark: true,
    term: {
      background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: '#504945',
      black: '#3c3836', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
    ui: { bg: '#1d2021', bar: '#1d2021', tab: '#232323', tabActive: '#282828', fg: '#ebdbb2', muted: '#7c6f64', accent: '#fabd2f', hover: '#504945', border: '#141414', input: '#1d2021', dim: '#a89984', green: '#b8bb26', amber: '#fabd2f', red: '#fb4934' },
  },
  onedark: {
    name: 'One Dark', dark: true,
    term: {
      background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', cursorAccent: '#282c34', selectionBackground: '#3e4451',
      black: '#3f4451', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
    ui: { bg: '#21252b', bar: '#21252b', tab: '#24282f', tabActive: '#282c34', fg: '#abb2bf', muted: '#5c6370', accent: '#61afef', hover: '#3e4451', border: '#181a1f', input: '#181a1f', dim: '#8b92a0' },
  },
  solarizeddark: {
    name: 'Solarized Dark', dark: true,
    term: {
      background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#0b4655',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
    ui: { bg: '#00212b', bar: '#00212b', tab: '#00252f', tabActive: '#002b36', fg: '#93a1a1', muted: '#586e75', accent: '#268bd2', hover: '#0b4655', border: '#001a21', input: '#001a21', dim: '#839496' },
  },
  solarizedlight: {
    name: 'Solarized Light', dark: false,
    term: {
      background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', cursorAccent: '#fdf6e3', selectionBackground: '#d9d2bc',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
    ui: { bg: '#eee8d5', bar: '#eee8d5', tab: '#e6dfc8', tabActive: '#fdf6e3', fg: '#586e75', muted: '#93a1a1', accent: '#268bd2', hover: '#d9d2bc', border: '#cfc8b0', input: '#fdf6e3', dim: '#657b83' },
  },
  githublight: {
    name: 'GitHub Light', dark: false,
    term: {
      background: '#ffffff', foreground: '#24292f', cursor: '#0969da', cursorAccent: '#ffffff', selectionBackground: '#b6d6fb',
      black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
    },
    ui: { bg: '#f6f8fa', bar: '#f6f8fa', tab: '#eaeef2', tabActive: '#ffffff', fg: '#24292f', muted: '#6e7781', accent: '#0969da', hover: '#d0d7de', border: '#d0d7de', input: '#ffffff', dim: '#57606a', green: '#1a7f37', amber: '#bf8700', red: '#cf222e' },
  },
};
const DEFAULT_THEME = 'dracula';

const Themes = {
  /** Id saved in this browser, or the default when missing/unknown. */
  currentId() {
    try {
      const id = localStorage.getItem(THEME_KEY);
      if (Object.prototype.hasOwnProperty.call(THEMES, id)) return id;
    } catch (e) { /* storage blocked */ }
    return DEFAULT_THEME;
  },

  current() { return THEMES[this.currentId()]; },

  /** Apply the page chrome of a theme (CSS variables, native widgets, browser UI colour). Terminals: Tabs.setTheme. */
  applyChrome(id) {
    const t = THEMES[id];
    const ui = { green: t.term.green, amber: t.term.yellow, red: t.term.red, ...t.ui };
    const s = document.documentElement.style;
    const vars = { bg: 'bg', bar: 'bar', tab: 'tab', tabActive: 'tab-active', fg: 'fg', muted: 'muted', accent: 'accent', hover: 'hover',
      border: 'border', input: 'input', dim: 'dim', green: 'green', amber: 'amber', red: 'red' };
    for (const k of Object.keys(vars)) s.setProperty('--' + vars[k], ui[k]);
    s.setProperty('--term-bg', t.term.background);
    s.colorScheme = t.dark ? 'dark' : 'light';   // native widgets, including the terminal's scrollbar
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = ui.bg;
  },

  /** Remember the choice and apply the chrome. @returns {object} the theme's terminal colours */
  set(id) {
    if (!Object.prototype.hasOwnProperty.call(THEMES, id)) return this.current().term;
    try { localStorage.setItem(THEME_KEY, id); } catch (e) { /* best effort */ }
    this.applyChrome(id);
    return THEMES[id].term;
  },
};
