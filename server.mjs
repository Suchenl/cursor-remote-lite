import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import qrcode from 'qrcode-terminal';
import { workspaces, workspaceForTitle, fileSize, readFile, parseRef } from './files.mjs';
import {
  DATA_DIR, encryptUrl, createPairing, pairingValid, consumePairing, listDevices, addDevice, findDevice, updateDevice,
  removeDevice, totpConfig, verifyTotp, needsTotp, saveState, appBase,
} from './auth.mjs';
import { pushPublicKey, openEventStream, closeEventStreams, addViewer, removeViewer, deliver, startWatcher } from './notify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3939);
const HOST = process.env.HOST || '0.0.0.0';
const CDP_URL = (process.env.CDP_URL || 'http://127.0.0.1:9222').replace(/\/$/, '');
const TUNNEL = process.argv.includes('--tunnel');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const APP_DIR = path.join(__dirname, 'app');

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const CONFIG = loadConfig();
const PUBLISH_REPO = process.argv.find(a => a.startsWith('--publish='))?.slice('--publish='.length) || process.env.CR_PUBLISH_REPO || CONFIG.publishRepo || '';
const APP_ORIGIN = PUBLISH_REPO ? `https://${PUBLISH_REPO.split('/')[0].toLowerCase()}.github.io` : '';
const ALLOWED_ORIGINS = new Set([APP_ORIGIN, ...(process.env.CR_ALLOWED_ORIGINS || '').split(',')].filter(Boolean));

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

// A device is usable once paired and, when 2FA asks for it, re-verified.
function deviceFor(req) {
  return findDevice(bearer(req));
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
  console.log(`!! 验证失败 ip=${ip}（15 分钟内：本 IP ${failures.get(ip).length} 次，总计 ${globalFailures.length} 次）`);
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

// Cursor accepts images pasted into the composer; a synthetic paste event carrying a File works the same way.
const pasteImage = (b64, name, type) => `(async () => {
  if (!${FOCUS_COMPOSER}) return null;
  const ed = document.activeElement.closest('[contenteditable="true"]') || document.activeElement;
  const pills = () => document.querySelectorAll('.context-pill-image').length;
  const before = pills();
  const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bin], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
  ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  for (let i = 0; i < 20 && pills() <= before; i++) await new Promise(r => setTimeout(r, 100));
  return pills() > before;
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
  const FILE_REF = 'code.md-inline-path-filename-like';

  // Edit/read tool cards keep the absolute path in the header's title; fall back to the shown file name.
  const toolFile = el => {
    const titled = [...el.querySelectorAll('[title]')].map(e => e.getAttribute('title')).find(t => /^(\/|~\/|[A-Za-z]:\\)\S+$/.test(t));
    return titled || el.querySelector('.ui-edit-tool-call__filename')?.innerText.trim() || null;
  };

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
      if (n.matches(FILE_REF)) { out += `<code data-file="${esc(n.innerText.trim())}">${esc(n.innerText.trim())}</code>`; continue; }
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

  // Messages sent while the Agent is running wait in Cursor's queue tray until the current turn ends.
  const QUEUE_ROW = '[data-queue-row], .composer-toolbar-queue-item[data-queue-item-id]';
  const queueRows = () => [...document.querySelectorAll(QUEUE_ROW)].filter(vis);
  const queued = () => queueRows().map(e => ({
    id: e.dataset.queueItemId,
    t: (e.dataset.queueItemQuery || e.innerText || '').trim().slice(0, 4000),
  }));
  const isBusy = () => [...document.querySelectorAll('.composer-button-area .codicon-debug-stop, .send-with-mode .codicon-debug-stop')].some(vis);

  // First call (no action) returns the row center to hover over; hover-only buttons appear after that.
  const queueTarget = (id, action) => {
    const row = queueRows().find(e => e.dataset.queueItemId === id);
    if (!row) return null;
    row.scrollIntoView({ block: 'nearest' });
    if (!action) return center(row);
    const b = row.querySelector(`[data-queue-action="${CSS.escape(action)}"]`)
      || [...row.querySelectorAll('[aria-label]')].find(e => e.getAttribute('aria-label') === { send: 'Send now', remove: 'Remove', edit: 'Edit' }[action]);
    return b && vis(b) ? center(b) : null;
  };

  // Running subagents: task cards in the transcript plus the "N subagents running" tray above the composer.
  // Clicking a tray row opens that subagent's own transcript as a chat-editor tab (no composer there).
  const SUB_ROW = '.composer-toolbar-background-job-item';
  const subRowName = e => e.querySelector('.composer-toolbar-background-job-item-text')?.innerText.trim() || '';
  const subagents = () => {
    const names = new Set();
    for (const h of document.querySelectorAll('.task-tool-call-header')) {
      if (!vis(h) || !h.closest('[data-flat-index]')?.querySelector('.ui-subagent-status-indicator--running-loader, .task-subagent-header-pill-button--stop')) continue;
      const n = h.querySelector('span.truncate')?.childNodes[0]?.textContent.trim();
      if (n) names.add(n);
    }
    for (const r of document.querySelectorAll(SUB_ROW)) if (subRowName(r)) names.add(subRowName(r));
    return [...names];
  };
  const subTrayHeader = () => [...document.querySelectorAll('div')].find(e => vis(e) && [...e.childNodes].some(n => n.nodeType === 3 && /^\d+ subagents? running$/.test(n.textContent.trim())));
  const subTarget = (name, part) => {
    const row = [...document.querySelectorAll(SUB_ROW)].find(r => vis(r) && subRowName(r) === name);
    if (!row) { const h = subTrayHeader(); return h ? { expand: true, ...center(h) } : null; }
    if (part === 'stop') {
      const s = [...row.querySelectorAll('span.truncate')].find(e => e.innerText.trim() === 'Stop');
      return s ? center(s) : null;
    }
    return center(row.querySelector('.composer-toolbar-background-job-item-text') || row);
  };
  const activeChatTab = () => [...document.querySelectorAll('.tab.active')].map(e => e.getAttribute('aria-label') || '').find(l => /Chat Editors/.test(l)) || null;
  const tabTarget = label => {
    const t = [...document.querySelectorAll('.tab')].find(e => vis(e) && e.getAttribute('aria-label') === label);
    return t ? center(t) : null;
  };
  const hasComposer = () => [...document.querySelectorAll('.aislash-editor-input[contenteditable="true"], .ui-prompt-input-editor__input[contenteditable="true"]')].some(vis);

  // Files changed by the Agent: the "N Files" toggle above the composer expands a list with per-file undo / keep.
  const filesToggle = () => [...document.querySelectorAll('span.cursor-pointer')].find(e => vis(e) && /^\d+ Files?$/.test(e.innerText.trim().replace(/\s+/g, ' ')));
  const changedCount = () => parseInt(filesToggle()?.innerText || '0', 10) || 0;
  const changedRows = () => [...document.querySelectorAll('.composer-file-list-item')].filter(vis);
  const changedFiles = () => changedRows().map(r => {
    const stat = [...r.querySelectorAll('.tabular-nums span')].map(s => s.innerText.trim());
    return {
      name: r.querySelector('span[style*="nowrap"]')?.innerText.trim() || r.innerText.trim().split('\n')[0],
      add: stat.find(s => s.startsWith('+')) || '',
      del: stat.find(s => /^[-−]/.test(s)) || '',
    };
  });
  const filesBar = () => {
    let t = filesToggle();
    while (t && !t.querySelector('[data-click-ready]')) t = t.parentElement;
    return t;
  };
  // Bar-level actions besides Stop (handled elsewhere) and Review (desktop-only diff view), e.g. Keep All / Undo All.
  const fileBarButtons = () => [...(filesBar()?.querySelectorAll('[data-click-ready]') || [])].filter(vis)
    .map(e => ({ el: e, label: (e.querySelector('.truncate') || e).innerText.trim() }))
    .filter(x => x.label && !/^(stop|review)$/i.test(x.label));
  const filesState = () => ({ files: changedFiles(), actions: fileBarButtons().map(x => x.label) });
  const fileTarget = (i, name, act) => {
    if (act === 'toggle') { const t = filesToggle(); return t ? center(t) : null; }
    if (act === 'bar') return (b => b ? center(b.el) : null)(fileBarButtons().find(x => x.label === name));
    const row = changedRows()[i];
    if (!row || changedFiles()[i].name !== name) return null;
    row.scrollIntoView({ block: 'nearest' });
    if (act === 'row') return center(row);
    const icon = row.querySelector(act === 'undo' ? '.codicon-x-two' : '.codicon-check-two');
    return icon ? center(icon.closest('.anysphere-icon-button') || icon) : null;
  };

  // Editing a queued message loads it into the main composer, which is tagged with the item id until saved.
  const focusQueueEdit = id => {
    const bar = [...document.querySelectorAll('[data-editing-queue-item-id]')].find(e => vis(e) && e.dataset.editingQueueItemId === id);
    const ed = bar && [...bar.querySelectorAll('[contenteditable="true"]')].find(vis);
    if (!ed) return false;
    ed.focus();
    return true;
  };

  const stopTarget = () => {
    const icon = [...document.querySelectorAll('.composer-button-area .codicon-debug-stop, .send-with-mode .codicon-debug-stop')].find(vis);
    if (!icon) return null;
    return center(icon.closest('button, [role=button], .anysphere-icon-button') || icon);
  };

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
      if (k === 'tool') { const f = toolFile(el); if (f) item.f = f; }
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
      busy: isBusy(),
      queued: queued(),
      subagents: subagents(),
      changed: changedCount(),
      readonly: !hasComposer(),
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
    model: () => [...document.querySelectorAll('.ui-menu__row')].filter(e => e.querySelector('.ui-model-picker__item-content-name')).map(e => ({ el: e, id: e.dataset.testid, params: !!e.querySelector('[data-testid=parameter-edit-btn]'), label: e.querySelector('.ui-model-picker__item-content-name').innerText.trim(), checked: !!e.querySelector('.codicon-check, .ui-model-picker__item-right-section [class*=check]') })),
    history: () => {
      const rows = [...document.querySelectorAll('.composer-history-hover-menu .ui-menu__row')];
      if (rows.length) return rows.map(e => ({ el: e, label: (e.querySelector('.compact-agent-history-react-menu-label, .ui-menu__item-content') || e).innerText.trim().split('\n')[0].slice(0, 80), checked: e.getAttribute('aria-checked') === 'true' || /\b(selected|active|current)\b/.test(e.className) }));
      return [...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map(e => ({ el: e, label: (e.getAttribute('aria-label') || e.innerText).trim().split('\n')[0].slice(0, 80), checked: e.classList.contains('focused') }));
    },
  };

  const menuItems = kind => (MENU_ITEMS[kind]?.() || []).filter(x => vis(x.el) && x.label).map(({ el, ...rest }) => rest);

  const menuOpen = () => [...document.querySelectorAll('.ui-menu, .composer-unified-context-menu-item, .composer-history-hover-menu')].some(vis);

  // Model parameters (context size, effort, fast…) live in a per-model submenu behind its "Edit" button.
  const maxToggle = () => {
    const t = [...document.querySelectorAll('[data-testid=max-mode-toggle]')].find(vis);
    return t ? { ...center(t), on: t.getAttribute('aria-checked') === 'true' } : null;
  };
  const modelTarget = (id, part) => {
    const row = [...document.querySelectorAll('[data-testid=model-picker-menu] .ui-menu__row')].find(e => e.dataset.testid === id);
    if (!row) return null;
    row.scrollIntoView({ block: 'nearest' });
    if (part !== 'edit') return center(row);
    const b = row.querySelector('[data-testid=parameter-edit-btn]');
    return b && vis(b) ? center(b) : null;
  };
  const paramRows = () => {
    const menu = [...document.querySelectorAll('[data-testid=parameter-submenu]')].find(vis);
    if (!menu) return null;
    return [...menu.querySelectorAll('.ui-menu__section')].map(s => ({
      title: s.querySelector('.ui-menu__section-title')?.innerText.trim() || '',
      rows: [...s.querySelectorAll('.ui-menu__row, .ui-menu__toggle-row')].filter(vis).map(r => {
        const toggle = r.matches('.ui-menu__toggle-row');
        return { el: r, label: (r.querySelector('.ui-menu__item-content') || r).innerText.trim(), toggle, checked: toggle ? r.getAttribute('aria-checked') === 'true' : !!r.querySelector('.ui-model-picker__param-check') };
      }),
    }));
  };
  const modelParams = () => paramRows()?.map(s => ({ title: s.title, items: s.rows.map(({ el, ...rest }) => rest) })) || null;
  const paramTarget = (title, label) => {
    const row = paramRows()?.find(s => s.title === title)?.rows.find(r => r.label === label);
    return row ? center(row.el) : null;
  };

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

  // Cheap per-window check for notifications: is the Agent running, and is it waiting on a button?
  // "Run in background" shows up on any command running longer than ~5 s; it is not a request for approval.
  const WAIT = /^(?!.*(background|后台))(run|allow|accept|approve|continue|yes\b|运行|允许|接受|批准|继续)/i;
  const agentState = () => {
    const panel = findPanel();
    if (!panel) return null;
    const busy = isBusy();
    const items = topItems(panel);
    let waiting = null, waitingText = '';
    for (const el of items.slice(-3)) {
      const labels = buttonsIn(el, false).map(x => x.label).filter(l => WAIT.test(l));
      if (labels.length) { waiting = `${el.dataset.flatIndex}:${labels.join('/')}`; waitingText = summary(el); }
    }
    const global = buttonsIn(panel, true).filter(x => !x.el.closest('[data-flat-index]') && WAIT.test(x.label)).map(x => x.label);
    if (!waiting && global.length) { waiting = `g:${global.join('/')}`; waitingText = global.join(' / '); }
    const lastReply = [...items].reverse().find(el => el.matches('[data-message-kind="assistant"]') || el.querySelector('[data-message-kind="assistant"]'));
    const last = lastReply ? lastReply.innerText.trim().replace(/\s+/g, ' ').slice(0, 160) : '';
    return { busy, waiting, waitingText, last };
  };

  const quickOpenRows = () => {
    const w = document.querySelector('.quick-input-widget');
    if (!w || !vis(w)) return null;
    return [...w.querySelectorAll('.monaco-list-row')].filter(vis).map(e => ({
      name: e.querySelector('.label-name')?.innerText.trim() || '',
      dir: e.querySelector('.label-description')?.innerText.trim() || '',
    }));
  };

  return { extract, locate, panelRect, control, menuItems, menuItem, quickOpenRows, agentState, queueTarget, stopTarget, focusQueueEdit,
    menuOpen, maxToggle, modelTarget, modelParams, paramTarget, subTarget, activeChatTab, tabTarget, hasComposer, filesState, fileTarget };
}

const helpersCall = call => `(${pageHelpers.toString()})().${call}`;

class Session {
  constructor(client, deviceId) {
    this.client = client;
    this.deviceId = deviceId;
    // The phone reports when the app goes to the background; notifications skip the window it is looking at.
    this.visible = true;
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

  async editQueued(id, text) {
    if (!text.trim()) throw new Error('内容不能为空；不想要这条就点「删除」');
    await this.queueAction(id, 'edit');
    const focus = () => this.cdp.evaluate(helpersCall(`focusQueueEdit(${JSON.stringify(String(id))})`));
    let ok = false;
    for (let i = 0; i < 10 && !ok; i++) {
      await new Promise(r => setTimeout(r, 100));
      ok = await focus();
    }
    if (!ok) throw new Error('Cursor 没有进入编辑状态，没改动');
    await this.key(process.platform === 'darwin' ? 'Meta+A' : 'Ctrl+A');
    await this.typeText(text);
    await this.key('Enter');
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async queueAction(id, action) {
    if (!['send', 'remove', 'edit'].includes(action)) throw new Error('不支持的排队操作');
    const call = a => this.cdp.evaluate(helpersCall(`queueTarget(${JSON.stringify(String(id))}${a ? `, ${JSON.stringify(a)}` : ''})`));
    const row = await call();
    if (!row) throw new Error('这条排队消息已经不在了（可能刚被发出）');
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
    let pos = null;
    for (let i = 0; i < 6 && !pos; i++) {
      await new Promise(r => setTimeout(r, 80));
      pos = await call(action);
    }
    if (!pos) throw new Error('没找到排队消息的操作按钮（可能 Cursor 版本不同）');
    await this.tapCss(pos.x, pos.y);
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async subagentAction(name, part) {
    const call = `subTarget(${JSON.stringify(String(name))}, ${JSON.stringify(part)})`;
    let pos = await this.cdp.evaluate(helpersCall(call));
    if (pos?.expand) {
      await this.tapCss(pos.x, pos.y);
      for (let i = 0; i < 8 && (!pos || pos.expand); i++) {
        await new Promise(r => setTimeout(r, 120));
        pos = await this.cdp.evaluate(helpersCall(call));
      }
    }
    if (!pos || pos.expand) throw new Error('这个子 Agent 已经结束了，或者 Cursor 里找不到它');
    if (part === 'open') {
      const tab = await this.cdp.evaluate(helpersCall('activeChatTab()'));
      if (tab && await this.cdp.evaluate(helpersCall('hasComposer()'))) this.mainTab = tab;
    }
    await this.tapCss(pos.x, pos.y);
    setTimeout(() => this.pollChat().catch(() => {}), 500);
  }

  // Opens Cursor's changed-files list if needed, runs fn, then puts the list back the way it was.
  async withFiles(fn) {
    const state = () => this.cdp.evaluate(helpersCall('filesState()'));
    let s = await state();
    const opened = !s.files.length;
    if (opened) {
      const t = await this.cdp.evaluate(helpersCall('fileTarget(0, "", "toggle")'));
      if (!t) return fn(s);
      await this.tapCss(t.x, t.y);
      for (let i = 0; i < 8 && !s.files.length; i++) {
        await new Promise(r => setTimeout(r, 120));
        s = await state();
      }
    }
    try {
      return await fn(s);
    } finally {
      const t = opened && await this.cdp.evaluate(helpersCall('fileTarget(0, "", "toggle")'));
      if (t && (await state()).files.length) await this.tapCss(t.x, t.y);
    }
  }

  async listChanges() {
    const s = await this.withFiles(async s => s);
    this.emit({ t: 'changes', ...s });
  }

  async changeAction(i, name, act) {
    if (!['keep', 'undo', 'bar'].includes(act)) throw new Error('不支持的操作');
    await this.withFiles(async () => {
      const call = a => helpersCall(`fileTarget(${Number(i) || 0}, ${JSON.stringify(String(name))}, ${JSON.stringify(a)})`);
      if (act !== 'bar') {
        const row = await this.cdp.evaluate(call('row'));
        if (!row) throw new Error('文件列表已经变了，请重新打开');
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
        await new Promise(r => setTimeout(r, 120));
      }
      const pos = await this.cdp.evaluate(call(act));
      if (!pos) throw new Error('没找到这个按钮（可能 Cursor 版本不同）');
      await this.tapCss(pos.x, pos.y);
      await new Promise(r => setTimeout(r, 400));
    });
    await this.listChanges();
    setTimeout(() => this.pollChat().catch(() => {}), 300);
  }

  async backToMain() {
    const pos = this.mainTab && await this.cdp.evaluate(helpersCall(`tabTarget(${JSON.stringify(this.mainTab)})`));
    if (!pos) throw new Error('找不到原来的主对话标签页，请在「画面」里手动切回');
    await this.tapCss(pos.x, pos.y);
    setTimeout(() => this.pollChat().catch(() => {}), 400);
  }

  async stopAgent() {
    const pos = await this.cdp.evaluate(helpersCall('stopTarget()'));
    if (!pos) throw new Error('Agent 当前没有在运行');
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
    const max = kind === 'model' ? await this.cdp.evaluate(helpersCall('maxToggle()?.on ?? null')) : null;
    await this.closeMenus();
    this.emit({ t: 'menu', kind, items, max });
  }

  async closeMenus() {
    for (let i = 0; i < 3 && await this.cdp.evaluate(helpersCall('menuOpen()')); i++) {
      await this.key('Escape');
      await new Promise(r => setTimeout(r, 120));
    }
  }

  async waitFor(call, tries = 10) {
    for (let i = 0; i < tries; i++) {
      await new Promise(r => setTimeout(r, 120));
      const v = await this.cdp.evaluate(helpersCall(call));
      if (v) return v;
    }
    return null;
  }

  async toggleMax() {
    await this.pressControl('model');
    const t = await this.waitFor('maxToggle()');
    if (!t) { await this.closeMenus(); throw new Error('这个 Cursor 版本没有 MAX Mode 开关'); }
    await this.tapCss(t.x, t.y);
    await new Promise(r => setTimeout(r, 250));
    await this.closeMenus();
    await this.openMenu('model');
  }

  // Leaves the parameter submenu open; callers must closeMenus().
  async openParamMenu(model) {
    const id = JSON.stringify(String(model));
    await this.pressControl('model');
    const row = await this.waitFor(`modelTarget(${id})`);
    if (!row) { await this.closeMenus(); throw new Error('模型列表里找不到这个模型'); }
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
    const edit = await this.waitFor(`modelTarget(${id}, 'edit')`, 6);
    if (!edit) { await this.closeMenus(); throw new Error('这个模型没有可调的参数'); }
    await this.tapCss(edit.x, edit.y);
    const params = await this.waitFor('modelParams()');
    if (!params) { await this.closeMenus(); throw new Error('参数菜单没有打开（可能 Cursor 版本不同）'); }
    return params;
  }

  async showParams(model, label) {
    try {
      this.emit({ t: 'params', model, label, sections: await this.openParamMenu(model) });
    } finally {
      await this.closeMenus();
    }
  }

  async pickParam(model, label, section, value) {
    try {
      await this.openParamMenu(model);
      const pos = await this.cdp.evaluate(helpersCall(`paramTarget(${JSON.stringify(String(section))}, ${JSON.stringify(String(value))})`));
      if (!pos) throw new Error(`没找到参数：${section} / ${value}`);
      await this.tapCss(pos.x, pos.y);
      await new Promise(r => setTimeout(r, 250));
    } finally {
      await this.closeMenus();
    }
    await this.showParams(model, label);
    setTimeout(() => this.pollChat().catch(() => {}), 300);
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

  // Asks Cursor's own Cmd+P index where a bare file name lives, then closes the picker again.
  async quickOpen(name) {
    await this.key(process.platform === 'darwin' ? 'Meta+p' : 'Ctrl+p');
    try {
      let rows = null;
      for (let i = 0; i < 6 && !rows; i++) {
        await new Promise(r => setTimeout(r, 150));
        rows = await this.cdp.evaluate(helpersCall('quickOpenRows()'));
      }
      if (!rows) return [];
      await this.cdp.send('Input.insertText', { text: name });
      let hits = [];
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 250));
        hits = (await this.cdp.evaluate(helpersCall('quickOpenRows()')) || []).filter(r => r.name === name);
        if (hits.length) break;
      }
      return hits;
    } finally {
      await this.key('Escape');
    }
  }

  async resolveFile(text) {
    const { p, line } = parseRef(text);
    if (!p) throw new Error('不是文件路径');
    const ws = workspaceForTitle(this.winTitle || '');
    const host = ws ? ws.host : /\[SSH: ([^\]]+)\]/.exec(this.winTitle || '')?.[1] || null;
    const isAbs = /^(\/|~\/)/.test(p);
    const tried = [];
    const tryPath = async (h, abs) => {
      if (tried.some(t => t.h === h && t.abs === abs)) return null;
      tried.push({ h, abs });
      const size = await fileSize(h, abs);
      return size == null ? null : { host: h, path: abs, size, line };
    };
    if (isAbs) {
      const hit = await tryPath(host, p);
      if (hit) return hit;
    } else if (ws) {
      const hit = await tryPath(ws.host, path.posix.join(ws.root, p));
      if (hit) return hit;
    }
    if (this.winTitle === 'Cursor Agents') {
      // The Agents window mixes projects, so try recently opened folders.
      for (const w of workspaces().slice(0, 8)) {
        const hit = await tryPath(w.host, isAbs ? p : path.posix.join(w.root, p));
        if (hit) return hit;
      }
      throw new Error(`找不到文件（可能已被删除或移动）：${p}`);
    }
    const name = path.posix.basename(p);
    const dir = path.posix.dirname(p);
    const hits = await this.quickOpen(name);
    // Prefer matches inside this workspace (relative dir) whose folder ends with the path the chat showed.
    const ranked = hits
      .map(h => ({ ...h, abs: h.dir.startsWith('/') ? path.posix.join(h.dir, name) : ws ? path.posix.join(ws.root, h.dir, name) : null }))
      .filter(h => h.abs)
      .sort((a, b) => (dir !== '.' && b.abs.endsWith('/' + p)) - (dir !== '.' && a.abs.endsWith('/' + p)) || a.dir.startsWith('/') - b.dir.startsWith('/'));
    for (const h of ranked) {
      const hit = await tryPath(host, h.abs);
      if (hit) return hit;
    }
    throw new Error(`找不到文件（可能已被删除或移动）：${p}`);
  }

  async openFile(text) {
    this.emit({ t: 'file', loading: true, name: path.posix.basename(parseRef(text).p) });
    try {
      const f = await this.resolveFile(text);
      const body = await readFile(f.host, f.path, f.size);
      this.emit({ t: 'file', name: path.posix.basename(f.path), path: f.path, host: f.host, size: f.size, line: f.line, ...body });
    } catch (e) {
      this.emit({ t: 'file', error: e.message, name: path.posix.basename(parseRef(text).p) });
    }
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
    this.winTitle = win.title;
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
    const busy = submit && await this.cdp.evaluate(helpersCall('agentState()?.busy'));
    await this.typeText(text);
    if (submit) await this.key('Enter');
    if (this.mode === 'chat') setTimeout(() => this.pollChat().catch(() => {}), 300);
    return Boolean(busy);
  }

  async attachImage(data, name, type) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type) || typeof data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error('只支持 PNG / JPEG / GIF / WebP 图片');
    const ok = await this.cdp.evaluate(pasteImage(data, String(name || 'image').replace(/[^\w.\-]/g, '_').slice(0, 60), type));
    if (ok === null) throw new Error('没找到可见的聊天输入框：先在画面里打开 Agent 面板（或点「打开聊天」）');
    if (!ok) throw new Error('Cursor 没有接收这张图片（当前模型可能不支持图片）');
    this.emit({ t: 'status', ok: true, msg: '图片已附加到 Cursor 输入框，写好文字后点发送' });
  }

  async handle(msg) {
    if (msg.t === 'windows') return this.emit({ t: 'windows', list: (await listWindows()).map(({ id, title, kind }) => ({ id, title, kind })), current: this.targetId });
    if (msg.t === 'attach') return this.attach(msg.id);
    if (msg.t === 'mode') return this.setMode(msg.mode);
    if (msg.t === 'visible') { this.visible = Boolean(msg.v); return; }
    if (msg.t === 'lang') { updateDevice(this.deviceId, { lang: msg.v === 'en' ? 'en' : 'zh' }); return; }
    if (!this.cdp) throw new Error('尚未连接到 Cursor 窗口');
    switch (msg.t) {
      case 'openMenu': return this.openMenu(msg.kind);
      case 'pickMenu': return this.pickMenu(msg.kind, msg.label);
      case 'toggleMax': return this.toggleMax();
      case 'params': return this.showParams(String(msg.model ?? ''), String(msg.label ?? ''));
      case 'pickParam': return this.pickParam(String(msg.model ?? ''), String(msg.label ?? ''), msg.section, msg.value);
      case 'newChat': return this.pressControl('newChat');
      case 'file': return this.openFile(String(msg.path ?? ''));
      case 'click': return this.clickButton(msg.item, msg.n);
      case 'queue': return msg.action === 'edit' ? this.editQueued(msg.id, String(msg.text ?? '')) : this.queueAction(msg.id, msg.action);
      case 'stop': return this.stopAgent();
      case 'subagent': return this.subagentAction(msg.name, msg.part === 'stop' ? 'stop' : 'open');
      case 'mainChat': return this.backToMain();
      case 'image': return this.attachImage(msg.data, msg.name, msg.type);
      case 'changes': return this.listChanges();
      case 'change': return this.changeAction(msg.i, msg.name, msg.act);
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
  '.jpg': 'image/jpeg',
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

async function readJson(req) {
  try { return JSON.parse(await readBody(req)); } catch { return {}; }
}

function deviceView(d, current) {
  return { id: d.id, name: d.name, created: d.created, lastSeen: d.lastSeen, current: d.id === current?.id };
}

async function handleApi(req, res, route) {
  const ip = clientIp(req);
  if (req.method === 'POST' && !originAllowed(req)) return json(req, res, 403, { error: 'bad origin' });
  const device = deviceFor(req);

  if (route === '/api/me') {
    return json(req, res, 200, { paired: Boolean(device), needTotp: needsTotp(device), totp: Boolean(totpConfig()) });
  }

  if (route === '/api/pair' && req.method === 'POST') {
    if (lockedOut(ip)) return json(req, res, 429, { error: '尝试次数过多，请 15 分钟后再试' });
    const { code, name, totp } = await readJson(req);
    if (!pairingValid(code)) {
      recordFailure(ip);
      return json(req, res, 401, { error: '配对链接无效或已过期（10 分钟内有效，只能用一次）。请在电脑上重新运行 npm run pair' });
    }
    if (totpConfig() && !verifyTotp(totp)) {
      if (totp) recordFailure(ip);
      return json(req, res, 401, { needTotp: true, error: totp ? '验证码不对' : '' });
    }
    consumePairing();
    const { device: added, token } = addDevice(name);
    console.log(`[pair] 新设备「${added.name}」 ip=${ip}`);
    return json(req, res, 200, { token });
  }

  if (!device) return json(req, res, 401, { error: '设备未配对' });

  if (route === '/api/totp' && req.method === 'POST') {
    if (lockedOut(ip)) return json(req, res, 429, { error: '尝试次数过多，请 15 分钟后再试' });
    const { code } = await readJson(req);
    if (!verifyTotp(code)) {
      recordFailure(ip);
      return json(req, res, 401, { error: '验证码不对' });
    }
    updateDevice(device.id, { verifiedAt: Date.now() });
    return json(req, res, 200, { ok: true });
  }
  if (needsTotp(device)) return json(req, res, 401, { needTotp: true, error: '需要二次验证' });

  if (route === '/api/devices') return json(req, res, 200, { devices: listDevices().map(d => deviceView(d, device)) });
  if (route === '/api/devices/remove' && req.method === 'POST') {
    const { id } = await readJson(req);
    removeDevice(String(id));
    closeEventStreams(String(id));
    console.log(`[unpair] 移除设备 ${id}（操作来自「${device.name}」）`);
    return json(req, res, 200, { ok: true });
  }
  if (route === '/api/logout' && req.method === 'POST') {
    removeDevice(device.id);
    closeEventStreams(device.id);
    console.log(`[unpair] 设备「${device.name}」自己退出`);
    return json(req, res, 200, { ok: true });
  }

  if (route === '/api/events') return openEventStream(req, res, device.id);
  if (route === '/api/push/key') return json(req, res, 200, { key: pushPublicKey() });
  if (route === '/api/push/subscribe' && req.method === 'POST') {
    const { sub } = await readJson(req);
    if (!/^https:\/\//.test(sub?.endpoint || '') || !sub.keys?.p256dh || !sub.keys?.auth) return json(req, res, 400, { error: '订阅信息无效' });
    updateDevice(device.id, { push: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } } });
    return json(req, res, 200, { ok: true });
  }
  if (route === '/api/push/unsubscribe' && req.method === 'POST') {
    updateDevice(device.id, { push: null });
    return json(req, res, 200, { ok: true });
  }
  if (route === '/api/push/test' && req.method === 'POST') {
    await deliver({ kind: 'test', win: '', title: 'Cursor Remote', body: '测试通知：能看到这条，说明通知已经通了 ✅',
      en: { body: 'Test notification: if you can see this, notifications work ✅' } }, device.id);
    return json(req, res, 200, { ok: true });
  }
  return json(req, res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') {
    res.writeHead(originAllowed(req) ? 204 : 403, corsHeaders(req));
    return res.end();
  }
  // The same app also runs from GitHub Pages; there url.json holds the encrypted relay address instead.
  if (url.pathname === '/url.json') return json(req, res, 200, { self: true });
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname);
  if (req.method === 'GET' && serveApp(res, url.pathname === '/' ? 'index.html' : url.pathname)) return;
  res.writeHead(404, SECURITY_HEADERS).end('not found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 << 20 });

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
      const device = msg.t === 'auth' ? findDevice(msg.token) : null;
      if (!device || needsTotp(device)) {
        ws.send(JSON.stringify({ t: 'auth', ok: false, needTotp: Boolean(device) }));
        return ws.close(4001, 'unauthorized');
      }
      updateDevice(device.id, { lastSeen: Date.now() });
      session = new Session(ws, device.id);
      addViewer(session);
      ws.send(JSON.stringify({ t: 'auth', ok: true }));
      console.log(`[+] client ${clientIp(req)}`);
      return;
    }
    // Frame acks bypass the queue so a slow command never stalls the stream.
    if (msg.t === 'ack') return session.ack();
    queue = queue.then(async () => {
      try {
        const queued = await session.handle(msg);
        if (msg.t === 'type') session.emit({ t: 'status', ok: true, msg: '已发送' });
        if (msg.t === 'queue' && msg.action === 'edit') session.emit({ t: 'status', ok: true, msg: '已修改，仍在排队' });
        if (msg.t === 'send') session.emit({ t: 'status', ok: true, msg: queued ? 'Agent 正在运行，已加入排队，这一轮结束后自动发送' : '已发送' });
      } catch (e) {
        session.emit({ t: 'status', ok: false, msg: e.message });
      }
    });
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    if (!session) return;
    removeViewer(session);
    session.dispose();
    console.log(`[-] client ${clientIp(req)}`);
  });
});

// Until a first device exists, print a pairing QR so a fresh install works without extra commands.
function offerFirstPairing() {
  if (listDevices().length) return;
  const base = appBase();
  if (!base) return;
  const { link, minutes } = createPairing(base);
  printQr(`还没有配对的设备。用手机扫码完成配对（${minutes} 分钟内有效；过期后运行 npm run pair）`, link);
}

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
    console.log(`已发布最新地址（GitHub Pages 约 1 分钟后生效）。手机 App 固定地址：${appUrl()}`);
    offerFirstPairing();
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
      saveState({ relayUrl: m[0] });
      if (PUBLISH_REPO) publishUrl(m[0]);
      else {
        console.log('（每次重启地址都会变，配对过的手机需要重新配对；运行 npm run setup 可获得固定地址）');
        offerFirstPairing();
      }
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

server.listen(PORT, TUNNEL ? '127.0.0.1' : HOST, async () => {
  console.log(`Cursor Remote Lite 已启动，端口 ${PORT}`);
  console.log(`已配对 ${listDevices().length} 台设备。添加新设备：npm run pair`);
  startWatcher({
    listWindows,
    openCdp: async ws => { const c = new Cdp(ws); await c.connect(); return c; },
    probe: helpersCall('agentState()'),
  });
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
    if (ips[0]) {
      saveState({ relayUrl: `http://${ips[0]}:${PORT}/` });
      offerFirstPairing();
    }
  }
});
