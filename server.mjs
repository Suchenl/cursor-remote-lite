import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import qrcode from 'qrcode-terminal';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3939);
const HOST = process.env.HOST || '0.0.0.0';
const CDP_URL = (process.env.CDP_URL || 'http://127.0.0.1:9222').replace(/\/$/, '');
const TUNNEL = process.argv.includes('--tunnel');
const DATA_DIR = path.join(os.homedir(), '.cursor-remote-lite');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const APP_DIR = path.join(__dirname, 'app');
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const MIN_PASSWORD_LEN = 10;

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const CONFIG = loadConfig();
const PUBLISH_REPO = process.argv.find(a => a.startsWith('--publish='))?.slice('--publish='.length) || process.env.CR_PUBLISH_REPO || CONFIG.publishRepo || '';
const APP_ORIGIN = PUBLISH_REPO ? `https://${PUBLISH_REPO.split('/')[0].toLowerCase()}.github.io` : '';
const ALLOWED_ORIGINS = new Set([APP_ORIGIN, ...(process.env.CR_ALLOWED_ORIGINS || '').split(',')].filter(Boolean));
const PASSWORD = loadPassword();
const sessions = loadSessions();

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function loadPassword() {
  if (process.env.CR_PASSWORD) return process.env.CR_PASSWORD;
  const file = path.join(DATA_DIR, 'password');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const pw = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(file, pw, { mode: 0o600 });
    return pw;
  }
}

function loadSessions() {
  try {
    const now = Date.now();
    return new Map(Object.entries(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))).filter(([, exp]) => exp > now));
  } catch {
    return new Map();
  }
}

function saveSessions() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// Only token hashes are stored on disk.
const tokenKey = token => crypto.createHash('sha256').update(String(token)).digest('hex');

function issueToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(tokenKey(token), Date.now() + SESSION_TTL);
  saveSessions();
  return token;
}

function tokenValid(token) {
  const exp = token && sessions.get(tokenKey(token));
  return Boolean(exp && exp > Date.now());
}

function bearer(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return m ? m[1] : '';
}

// Behind cloudflared every request arrives from loopback; only then trust its client-IP header.
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return (loopback && req.headers['cf-connecting-ip']) || remote;
}

const failures = new Map();
let globalFailures = [];
const PER_IP_LIMIT = 5, GLOBAL_LIMIT = 20, LOCK_MS = 15 * 60 * 1000;

function lockedOut(ip) {
  const now = Date.now();
  globalFailures = globalFailures.filter(t => now - t < LOCK_MS);
  const mine = (failures.get(ip) || []).filter(t => now - t < LOCK_MS);
  failures.set(ip, mine);
  return mine.length >= PER_IP_LIMIT || globalFailures.length >= GLOBAL_LIMIT;
}

function recordFailure(ip) {
  const now = Date.now();
  failures.set(ip, [...(failures.get(ip) || []), now]);
  globalFailures.push(now);
  console.log(`!! 登录失败 ip=${ip}（15 分钟内：本 IP ${failures.get(ip).length} 次，总计 ${globalFailures.length} 次）`);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Same-origin (app served by this relay) or the user's own GitHub Pages app.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function listWindows() {
  const res = await fetch(`${CDP_URL}/json/list`).catch(() => {
    throw new Error('连不上 Cursor：Cursor 没有用 start-cursor.sh 启动（调试端口未开启）');
  });
  const targets = await res.json();
  return targets
    .filter(t => t.type === 'page' && /workbench/.test(t.url))
    .map(t => ({
      id: t.id,
      title: t.title,
      ws: t.webSocketDebuggerUrl,
      kind: t.title === 'Cursor Agents' ? 'agents' : /\[SSH: /.test(t.title) ? 'ssh' : 'local',
    }));
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.onclose = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`CDP connect failed: ${this.wsUrl}`));
      ws.onclose = () => {
        for (const { reject } of this.pending.values()) reject(new Error('CDP closed'));
        this.pending.clear();
        this.onclose?.();
      };
      ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        } else if (msg.method) {
          this.handlers.get(msg.method)?.(msg.params);
        }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    this.handlers.set(method, fn);
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result.value;
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

const MOD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
const NAMED_KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Tab: { code: 'Tab', vk: 9 },
  Delete: { code: 'Delete', vk: 46 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
};

// Cursor's chat composer is a ProseMirror contenteditable; selectors ordered from most to least specific.
const FOCUS_COMPOSER = `(() => {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const selectors = ['.aislash-editor-input[contenteditable="true"]', '.ui-prompt-input-editor__input[contenteditable="true"]', '.composer-bar [contenteditable="true"]', '.auxiliarybar [contenteditable="true"]'];
  let eds = [];
  for (const s of selectors) { eds = [...document.querySelectorAll(s)].filter(visible); if (eds.length) break; }
  if (!eds.length) return null;
  const el = eds.find(e => e.contains(document.activeElement)) || eds[eds.length - 1];
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
})()`;

// Runs inside Cursor's renderer (injected via toString). Emits only whitelisted tags with escaped text, never raw DOM HTML.
function pageHelpers() {
  const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const SKIP = /ui-collapsible-header|md-clickable-code|output-preview|codicon-find|widget-close|model-picker/;
  const ACTION = /^(run|skip|allow|accept|reject|deny|approve|keep|undo|continue|stop|cancel|build|retry|yes|no\b|运行|跳过|允许|接受|拒绝|继续|停止|取消)/i;
  const BLOCK = new Set(['P', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'DIV']);
  const INLINE = new Set(['STRONG', 'B', 'EM', 'I', 'CODE', 'DEL']);
  const CODE_BLOCK = '.composer-code-block-container, .composer-message-codeblock, .ui-code-block, pre';

  const findPanel = () => {
    for (const ed of [...document.querySelectorAll('.aislash-editor-input, .ui-prompt-input-editor__input')].filter(vis)) {
      let p = ed;
      while (p && !p.querySelector('[data-flat-index]')) p = p.parentElement;
      if (p) return p;
    }
    const f = [...document.querySelectorAll('[data-flat-index]')].find(vis);
    return f ? f.closest('.composer-bar') || f.parentElement : null;
  };

  const buttonsIn = (root, strict) => [...root.querySelectorAll('button, [role=button], .anysphere-button, .anysphere-secondary-button, .composer-run-button, .composer-skip-button')]
    .filter(b => vis(b) && !SKIP.test(b.className) && !b.parentElement.closest('button, [role=button]'))
    .map(b => ({ el: b, label: ((b.innerText || '').trim() || b.getAttribute('aria-label') || b.title || '').split('\n')[0].slice(0, 30) }))
    .filter(x => x.label && x.label !== 'Shell command options' && (!strict || ACTION.test(x.label)));

  const codeText = n => {
    const lines = n.querySelectorAll('.view-line');
    return lines.length ? [...lines].map(l => l.innerText).join('\n') : n.innerText;
  };

  const clean = node => {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += esc(n.textContent); continue; }
      if (n.nodeType !== 1) continue;
      if (n.matches(CODE_BLOCK)) { out += `<pre>${esc(codeText(n).replace(/\n$/, ''))}</pre>`; continue; }
      const tag = n.tagName;
      if (['STYLE', 'SCRIPT', 'BUTTON', 'svg', 'SVG', 'IMG'].includes(tag)) continue;
      if (tag === 'BR') { out += '<br>'; continue; }
      if (tag === 'HR') { out += '<hr>'; continue; }
      const inner = clean(n);
      const t = tag.toLowerCase();
      out += BLOCK.has(tag) || INLINE.has(tag) ? `<${t}>${inner}</${t}>` : inner;
    }
    return out;
  };

  const summary = el => {
    const head = el.querySelector('.ui-tool-call-card__header, .ui-collapsible-header, [class*="header"]') || el;
    return head.innerText.trim().replace(/\s*\n\s*/g, ' · ').slice(0, 240);
  };

  const topItems = panel => [...panel.querySelectorAll('[data-flat-index]')].filter(e => !e.parentElement.closest('[data-flat-index]'));

  const extract = () => {
    const panel = findPanel();
    if (!panel) return null;
    const r = panel.getBoundingClientRect();
    const items = topItems(panel).map(el => {
      const kindEl = el.matches('[data-message-kind]') ? el : el.querySelector('[data-message-kind]');
      const k = kindEl?.dataset.messageKind || (el.querySelector('.composer-human-message, .aislash-editor-input-readonly') ? 'human' : 'other');
      const item = { i: el.dataset.flatIndex, k };
      if (k === 'human') item.t = (el.querySelector('.aislash-editor-input-readonly, .composer-human-message') || el).innerText.trim();
      else if (k === 'assistant') { const md = el.querySelector('.markdown-root'); item.h = md ? clean(md) : esc(el.innerText); }
      else item.t = summary(el);
      const b = buttonsIn(el, false);
      if (b.length) item.b = b.map(x => x.label);
      return item;
    });
    const global = buttonsIn(panel, true).filter(x => !x.el.closest('[data-flat-index]')).map(x => x.label);
    const modeEl = [...document.querySelectorAll('.composer-unified-dropdown[data-mode]')].find(vis);
    const modelEl = [...document.querySelectorAll('.ui-model-picker__trigger, .composer-unified-dropdown-model')].find(vis);
    return {
      rect: [r.x, r.y, r.width, r.height].map(Math.round),
      items,
      global,
      mode: modeEl ? modeEl.innerText.trim() || modeEl.dataset.mode : null,
      model: modelEl ? modelEl.innerText.trim() : null,
    };
  };

  // Named controls in Cursor's UI; each entry lists fallbacks from newest to oldest Cursor layouts.
  const CONTROLS = {
    mode: () => [...document.querySelectorAll('.composer-unified-dropdown[data-mode]')].find(vis),
    model: () => [...document.querySelectorAll('.ui-model-picker__trigger, .composer-unified-dropdown-model')].find(vis),
    history: () => [...document.querySelectorAll('[aria-label^="Show Chat History"], [aria-label^="Show Agent History"]')].find(vis),
    newChat: () => [...document.querySelectorAll('[aria-label^="New Agent"], [aria-label^="New Chat"]')].find(vis),
    agentsWindow: () => [...document.querySelectorAll('.open-agents-window-button, .titlebar-right .action-label')].find(e => vis(e) && /Agents Window/.test(e.innerText || e.getAttribute('aria-label') || '')),
  };

  const center = el => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };

  const control = name => {
    const el = CONTROLS[name]?.();
    return el ? center(el) : null;
  };

  const MENU_ITEMS = {
    mode: () => [...document.querySelectorAll('.composer-unified-context-menu-item')].map(e => ({ el: e, label: e.innerText.trim().split('\n')[0], checked: !!e.querySelector('.codicon-check') })),
    model: () => [...document.querySelectorAll('.ui-menu__row')].filter(e => e.querySelector('.ui-model-picker__item-content-name')).map(e => ({ el: e, label: e.querySelector('.ui-model-picker__item-content-name').innerText.trim(), checked: !!e.querySelector('.codicon-check, .ui-model-picker__item-right-section [class*=check]') })),
    history: () => {
      const rows = [...document.querySelectorAll('.composer-history-hover-menu .ui-menu__row')];
      if (rows.length) return rows.map(e => ({ el: e, label: (e.querySelector('.compact-agent-history-react-menu-label, .ui-menu__item-content') || e).innerText.trim().split('\n')[0].slice(0, 80), checked: e.getAttribute('aria-checked') === 'true' || /\b(selected|active|current)\b/.test(e.className) }));
      return [...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map(e => ({ el: e, label: (e.getAttribute('aria-label') || e.innerText).trim().split('\n')[0].slice(0, 80), checked: e.classList.contains('focused') }));
    },
  };

  const menuItems = kind => (MENU_ITEMS[kind]?.() || []).filter(x => vis(x.el) && x.label).map(({ label, checked }) => ({ label, checked }));

  const menuItem = (kind, label) => {
    const hit = (MENU_ITEMS[kind]?.() || []).find(x => vis(x.el) && x.label === label);
    if (!hit) return null;
    hit.el.scrollIntoView({ block: 'nearest' });
    return center(hit.el);
  };

  // Returns the button's on-screen center so the click goes through real mouse events.
  const locate = (item, n) => {
    const panel = findPanel();
    if (!panel) return null;
    const root = item === 'g' ? panel : panel.querySelector(`[data-flat-index="${CSS.escape(item)}"]`);
    if (!root) return null;
    const list = item === 'g' ? buttonsIn(panel, true).filter(x => !x.el.closest('[data-flat-index]')) : buttonsIn(root, false);
    const b = list[n]?.el;
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };

  const panelRect = () => {
    const p = findPanel();
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map(Math.round);
  };

  return { extract, locate, panelRect, control, menuItems, menuItem };
}

const helpersCall = call => `(${pageHelpers.toString()})().${call}`;

class Session {
  constructor(client) {
    this.client = client;
    this.cdp = null;
    this.viewport = { w: 1000, h: 800 };
    this.screencast = { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 2400 };
    this.awaitingAck = null;
    this.lastFrameAt = 0;
    this.lastHash = '';
    this.mode = 'chat';
    this.lastChat = '';
    this.lastPanel = '';
    this.idleTimer = setInterval(() => this.pollIfIdle(), 2000);
  }

  async setMode(mode) {
    this.mode = mode === 'screen' ? 'screen' : 'chat';
    clearInterval(this.chatTimer);
    if (!this.cdp) return;
    if (this.mode === 'chat') {
      await this.cdp.send('Page.stopScreencast').catch(() => {});
      this.lastChat = '';
      this.chatTimer = setInterval(() => this.pollChat().catch(() => {}), 700);
      await this.pollChat();
    } else {
      this.lastPanel = '';
      await this.sendPanelRect();
      await this.snapshot(true);
      await this.startScreencast();
    }
  }

  async pollChat() {
    if (!this.cdp || this.polling) return;
    this.polling = true;
    try {
      const chat = await this.cdp.evaluate(helpersCall('extract()'));
      const json = JSON.stringify(chat);
      if (json !== this.lastChat) {
        this.lastChat = json;
        this.emit({ t: 'chat', chat });
      }
    } finally {
      this.polling = false;
    }
  }

  async sendPanelRect() {
    const rect = await this.cdp.evaluate(helpersCall('panelRect()')).catch(() => null);
    const json = JSON.stringify(rect);
    if (json !== this.lastPanel) {
      this.lastPanel = json;
      this.emit({ t: 'panel', rect });
    }
  }

  async clickButton(item, n) {
    const pos = await this.cdp.evaluate(helpersCall(`locate(${JSON.stringify(String(item))}, ${Number(n) || 0})`));
    if (!pos) throw new Error('按钮已经不在了，可能状态已变化');
    await this.tapCss(pos.x, pos.y);
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async pressControl(name) {
    const pos = await this.cdp.evaluate(helpersCall(`control(${JSON.stringify(name)})`));
    if (!pos) throw new Error('当前窗口里没有这个按钮（可能是 Cursor 版本或布局不同）');
    await this.tapCss(pos.x, pos.y);
  }

  // Menus are read by opening them in Cursor, then closed again so the desktop UI is left as it was.
  async openMenu(kind) {
    await this.pressControl(kind);
    let items = [];
    for (let i = 0; i < 10 && !items.length; i++) {
      await new Promise(r => setTimeout(r, 150));
      items = await this.cdp.evaluate(helpersCall(`menuItems(${JSON.stringify(kind)})`));
    }
    await this.key('Escape');
    this.emit({ t: 'menu', kind, items });
  }

  async pickMenu(kind, label) {
    await this.pressControl(kind);
    let pos = null;
    for (let i = 0; i < 10 && !pos; i++) {
      await new Promise(r => setTimeout(r, 150));
      pos = await this.cdp.evaluate(helpersCall(`menuItem(${JSON.stringify(kind)}, ${JSON.stringify(String(label))})`));
    }
    if (!pos) {
      await this.key('Escape');
      throw new Error(`没找到选项：${label}`);
    }
    await this.tapCss(pos.x, pos.y);
    setTimeout(() => this.pollChat().catch(() => {}), 500);
  }

  async openAgentsWindow() {
    const existing = (await listWindows()).find(w => w.kind === 'agents');
    if (!existing) {
      await this.pressControl('agentsWindow');
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 300));
        if ((await listWindows()).some(w => w.kind === 'agents')) break;
      }
    }
    const win = (await listWindows()).find(w => w.kind === 'agents');
    if (!win) throw new Error('Agents 窗口没有打开');
    await this.attach(win.id);
  }

  async scrollChat(dy) {
    const rect = await this.cdp.evaluate(helpersCall('panelRect()'));
    if (!rect) return;
    const [x, y, w, h] = rect;
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x + w / 2, y: y + h / 2, deltaX: 0, deltaY: dy });
    setTimeout(() => this.pollChat().catch(() => {}), 400);
  }

  emit(obj) {
    if (this.client.readyState === 1) this.client.send(JSON.stringify(obj));
  }

  async attach(targetId) {
    this.detach();
    const wins = await listWindows();
    const win = wins.find(w => w.id === targetId) || wins[0];
    if (!win) throw new Error('没有找到 Cursor 窗口，确认 Cursor 是以 --remote-debugging-port=9222 启动的');
    const cdp = new Cdp(win.ws);
    await cdp.connect();
    this.cdp = cdp;
    this.targetId = win.id;
    cdp.onclose = () => {
      if (this.cdp === cdp) {
        this.cdp = null;
        this.emit({ t: 'status', ok: false, msg: 'Cursor 窗口连接已断开' });
      }
    };
    cdp.on('Page.screencastFrame', p => this.onFrame(p));
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await this.refreshViewport();
    this.emit({ t: 'attached', id: win.id, title: win.title });
    await this.setMode(this.mode);
  }

  detach() {
    clearInterval(this.chatTimer);
    if (this.cdp) {
      const cdp = this.cdp;
      this.cdp = null;
      cdp.send('Page.stopScreencast').catch(() => {}).finally(() => cdp.close());
    }
  }

  async refreshViewport() {
    const v = await this.cdp.evaluate('({ w: innerWidth, h: innerHeight })');
    if (v) this.viewport = v;
  }

  async startScreencast() {
    await this.cdp.send('Page.startScreencast', { ...this.screencast, everyNthFrame: 1 });
  }

  onFrame({ data, metadata, sessionId }) {
    this.lastFrameAt = Date.now();
    if (metadata?.deviceWidth) this.viewport = { w: metadata.deviceWidth, h: metadata.deviceHeight };
    this.sendFrame(data);
    this.awaitingAck = sessionId;
    // Don't let a slow phone stall the stream forever.
    clearTimeout(this.ackTimer);
    this.ackTimer = setTimeout(() => this.ack(), 1500);
  }

  ack() {
    clearTimeout(this.ackTimer);
    if (this.awaitingAck == null || !this.cdp) return;
    const sessionId = this.awaitingAck;
    this.awaitingAck = null;
    this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  }

  sendFrame(data, force = false) {
    const hash = crypto.createHash('md5').update(data).digest('hex');
    if (!force && hash === this.lastHash) return;
    this.lastHash = hash;
    this.emit({ t: 'frame', data, w: this.viewport.w, h: this.viewport.h });
  }

  // Electron stops painting occluded/minimized windows, so screencast goes quiet; fall back to screenshots.
  async pollIfIdle() {
    if (!this.cdp || this.mode !== 'screen') return;
    await this.sendPanelRect();
    if (Date.now() - this.lastFrameAt < 2000) return;
    await this.snapshot(false).catch(() => {});
  }

  async snapshot(force) {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: this.screencast.quality });
    this.sendFrame(data, force);
  }

  toCss(nx, ny) {
    return { x: Math.round(nx * this.viewport.w), y: Math.round(ny * this.viewport.h) };
  }

  async tap(nx, ny, button = 'left') {
    const { x, y } = this.toCss(nx, ny);
    await this.tapCss(x, y, button);
  }

  async tapCss(x, y, button = 'left') {
    const base = { x, y, button, clickCount: 1 };
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async wheel(nx, ny, dx, dy) {
    const { x, y } = this.toCss(nx, ny);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
  }

  async key(combo) {
    const parts = combo.split('+');
    const name = parts.pop();
    const modifiers = parts.reduce((m, p) => m | (MOD[p] || 0), 0);
    let spec = NAMED_KEYS[name];
    if (!spec && name.length === 1) {
      const up = name.toUpperCase();
      spec = { code: /[A-Z]/.test(up) ? `Key${up}` : /\d/.test(up) ? `Digit${up}` : '', vk: up.charCodeAt(0), text: name };
    }
    if (!spec) throw new Error(`未知按键: ${combo}`);
    const withText = spec.text && !(modifiers & (MOD.Ctrl | MOD.Meta));
    const ev = { key: name, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers };
    await this.cdp.send('Input.dispatchKeyEvent', { type: withText ? 'keyDown' : 'rawKeyDown', ...ev, ...(withText ? { text: spec.text } : {}) });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
  }

  async typeText(text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await this.key('Shift+Enter');
      if (lines[i]) await this.cdp.send('Input.insertText', { text: lines[i] });
    }
  }

  async sendMessage(text, submit) {
    const found = await this.cdp.evaluate(FOCUS_COMPOSER);
    if (!found) throw new Error('没找到可见的聊天输入框：先在画面里打开 Agent 面板（或点「打开聊天」）');
    await this.typeText(text);
    if (submit) await this.key('Enter');
    if (this.mode === 'chat') setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async handle(msg) {
    if (msg.t === 'windows') return this.emit({ t: 'windows', list: (await listWindows()).map(({ id, title, kind }) => ({ id, title, kind })), current: this.targetId });
    if (msg.t === 'attach') return this.attach(msg.id);
    if (msg.t === 'mode') return this.setMode(msg.mode);
    if (!this.cdp) throw new Error('尚未连接到 Cursor 窗口');
    switch (msg.t) {
      case 'openMenu': return this.openMenu(msg.kind);
      case 'pickMenu': return this.pickMenu(msg.kind, msg.label);
      case 'newChat': return this.pressControl('newChat');
      case 'agentsWindow': return this.openAgentsWindow();
      case 'click': return this.clickButton(msg.item, msg.n);
      case 'scrollChat': return this.scrollChat(Number(msg.dy) || 0);
      case 'tap': return this.tap(msg.x, msg.y, msg.button);
      case 'wheel': return this.wheel(msg.x, msg.y, msg.dx || 0, msg.dy || 0);
      case 'key': return this.key(msg.key);
      case 'type': return this.typeText(String(msg.text ?? ''));
      case 'send': return this.sendMessage(String(msg.text ?? ''), msg.submit !== false);
      case 'refresh': return this.snapshot(true);
      case 'quality':
        this.screencast.quality = Math.min(90, Math.max(20, Number(msg.quality) || 60));
        this.screencast.maxWidth = Math.min(2560, Math.max(480, Number(msg.maxWidth) || 1280));
        if (this.mode !== 'screen') return;
        await this.cdp.send('Page.stopScreencast');
        return this.startScreencast();
      default: throw new Error(`未知指令: ${msg.t}`);
    }
  }

  dispose() {
    clearInterval(this.idleTimer);
    clearTimeout(this.ackTimer);
    this.detach();
  }
}

const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !originAllowed(req)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function json(req, res, status, obj) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...corsHeaders(req), 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function serveApp(res, name) {
  const file = path.join(APP_DIR, path.basename(name));
  const type = MIME[path.extname(file)];
  if (!type || !fs.existsSync(file)) return false;
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') {
    res.writeHead(originAllowed(req) ? 204 : 403, corsHeaders(req));
    return res.end();
  }
  // The same app also runs from GitHub Pages; there url.json holds the encrypted relay address instead.
  if (url.pathname === '/url.json') return json(req, res, 200, { self: true });
  if (url.pathname === '/api/me') return json(req, res, 200, { loggedIn: tokenValid(bearer(req)) });
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (!originAllowed(req)) return json(req, res, 403, { error: 'bad origin' });
    if (lockedOut(ip)) return json(req, res, 429, { error: '尝试次数过多，请 15 分钟后再试' });
    let password = '';
    try { password = JSON.parse(await readBody(req)).password; } catch {}
    if (!safeEqual(password || '', PASSWORD)) {
      recordFailure(ip);
      return json(req, res, 401, { error: '密码错误' });
    }
    console.log(`[login] ip=${ip}`);
    return json(req, res, 200, { token: issueToken() });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    sessions.delete(tokenKey(bearer(req)));
    saveSessions();
    return json(req, res, 200, { ok: true });
  }
  if (req.method === 'GET' && serveApp(res, url.pathname === '/' ? 'index.html' : url.pathname)) return;
  res.writeHead(404, SECURITY_HEADERS).end('not found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || !originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

// The token arrives as the first message rather than in the URL, so it never shows up in proxy logs.
wss.on('connection', (ws, req) => {
  let session = null;
  const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 5000);
  let queue = Promise.resolve();
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!session) {
      clearTimeout(authTimer);
      if (msg.t !== 'auth' || !tokenValid(msg.token)) {
        ws.send(JSON.stringify({ t: 'auth', ok: false }));
        return ws.close(4001, 'unauthorized');
      }
      session = new Session(ws);
      ws.send(JSON.stringify({ t: 'auth', ok: true }));
      console.log(`[+] client ${clientIp(req)}`);
      return;
    }
    // Frame acks bypass the queue so a slow command never stalls the stream.
    if (msg.t === 'ack') return session.ack();
    queue = queue.then(async () => {
      try {
        await session.handle(msg);
        if (msg.t === 'send' || msg.t === 'type') session.emit({ t: 'status', ok: true, msg: '已发送' });
      } catch (e) {
        session.emit({ t: 'status', ok: false, msg: e.message });
      }
    });
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    if (!session) return;
    session.dispose();
    console.log(`[-] client ${clientIp(req)}`);
  });
});

function printQr(label, url) {
  console.log(`\n${label}：${url}`);
  qrcode.generate(url, { small: true });
}

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${cmd} exited ${code}`)));
    p.stdin.end(input ?? '');
  });
}

async function waitReachable(url) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${url}/url.json`)).ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

// The repo is public, so the address is encrypted with the login password; app/index.html decrypts it with WebCrypto.
const KDF_ITERATIONS = 300000;

function encryptUrl(url) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(PASSWORD, salt, KDF_ITERATIONS, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({ url }), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return {
    v: 1,
    iter: KDF_ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    updated: new Date().toISOString(),
  };
}

function appUrl() {
  const [owner, repo] = PUBLISH_REPO.split('/');
  return `https://${owner.toLowerCase()}.github.io/${repo}/`;
}

const gitBlobSha = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

async function putFile(name, buf, sha) {
  const body = { message: `update ${name}`, content: buf.toString('base64'), ...(sha ? { sha } : {}) };
  await run('gh', ['api', '-X', 'PUT', `repos/${PUBLISH_REPO}/contents/${name}`, '--input', '-'], JSON.stringify(body));
}

async function remoteShas() {
  const out = await run('gh', ['api', `repos/${PUBLISH_REPO}/contents`, '--jq', '.[] | [.name, .sha] | @tsv']).catch(() => '');
  return new Map(out.split('\n').filter(Boolean).map(l => l.split('\t')));
}

// Keeps the GitHub Pages copy of the app identical to app/, uploading only files that changed.
async function syncApp() {
  const remote = await remoteShas();
  let changed = 0;
  for (const name of fs.readdirSync(APP_DIR)) {
    if (!MIME[path.extname(name)] || name === 'url.json') continue;
    const buf = fs.readFileSync(path.join(APP_DIR, name));
    if (remote.get(name) === gitBlobSha(buf)) continue;
    await putFile(name, buf, remote.get(name));
    changed++;
  }
  if (changed) console.log(`已同步 ${changed} 个 App 文件到 GitHub Pages`);
}

// Writes the current tunnel address (encrypted) to url.json, so the app on GitHub Pages can find this relay.
async function publishUrl(url) {
  try {
    await syncApp();
  } catch (e) {
    console.log(`!! 同步 App 文件失败：${e.message}`);
  }
  if (!await waitReachable(url)) console.log('!! 新地址暂时无法从外网访问，仍然尝试发布');
  try {
    const remote = await remoteShas();
    await putFile('url.json', Buffer.from(JSON.stringify(encryptUrl(url)) + '\n'), remote.get('url.json'));
    console.log('已发布最新地址（GitHub Pages 约 1 分钟后生效）');
    printQr('手机打开这个固定地址，可以「添加到主屏幕」装成 App', appUrl());
  } catch (e) {
    console.log(`!! 发布地址失败：${e.message}`);
  }
}

function startTunnel() {
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let shown = false;
  const scan = buf => {
    const m = !shown && String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      shown = true;
      console.log(`\n公网地址：${m[0]}`);
      if (PUBLISH_REPO) publishUrl(m[0]);
      else printQr('手机打开（每次重启地址会变；运行 npm run setup 可获得固定地址）', m[0]);
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('error', () => console.log('!! 找不到 cloudflared，请先运行：brew install cloudflared'));
  child.on('exit', code => { console.log(`!! cloudflared 已退出 (code ${code})`); process.exit(1); });
  const stop = () => { child.kill(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (TUNNEL && PASSWORD.length < MIN_PASSWORD_LEN) {
  console.log(`!! 公网模式要求密码至少 ${MIN_PASSWORD_LEN} 位，请修改 CR_PASSWORD`);
  process.exit(1);
}

server.listen(PORT, TUNNEL ? '127.0.0.1' : HOST, async () => {
  console.log(`Cursor Remote Lite 已启动，端口 ${PORT}`);
  console.log(`登录密码保存在 ${path.join(DATA_DIR, 'password')}（运行 npm run set-password 修改）`);
  try {
    const wins = await listWindows();
    console.log(`已连上 Cursor，${wins.length} 个窗口：${wins.map(w => w.title).join(' | ')}`);
  } catch {
    console.log(`!! 连不上 ${CDP_URL}。请用 ./start-cursor.sh 重新启动 Cursor（带 --remote-debugging-port=9222）`);
  }
  if (TUNNEL) {
    console.log('正在建立 Cloudflare 公网隧道…');
    startTunnel();
  } else {
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    for (const ip of ips) console.log(`  局域网地址：http://${ip}:${PORT}/`);
    if (ips[0]) printQr('同一 Wi-Fi 下手机扫码打开', `http://${ips[0]}:${PORT}/`);
  }
});
