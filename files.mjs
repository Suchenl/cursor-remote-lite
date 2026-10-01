// Resolves file references from Cursor chats and reads them from the local disk or, for SSH windows, over ssh.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TEXT_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };

const STORAGE_DIRS = {
  darwin: '~/Library/Application Support/Cursor/User/workspaceStorage',
  linux: '~/.config/Cursor/User/workspaceStorage',
  win32: `${process.env.APPDATA}/Cursor/User/workspaceStorage`,
};

// vscode-remote://ssh-remote+<host or hex-encoded {"hostName":...}>/path
function parseFolderUri(uri) {
  const u = new URL(uri);
  if (u.protocol === 'file:') return { host: null, root: decodeURIComponent(u.pathname) };
  if (u.protocol !== 'vscode-remote:') return null;
  const authority = decodeURIComponent(u.host);
  const m = /^ssh-remote\+(.+)$/.exec(authority);
  if (!m) return null;
  let host = m[1];
  if (/^[0-9a-f]+$/i.test(host) && host.length % 2 === 0) {
    try { host = JSON.parse(Buffer.from(host, 'hex').toString('utf8')).hostName || host; } catch {}
  }
  return { host, root: decodeURIComponent(u.pathname) };
}

// Every folder Cursor has opened, newest first.
export function workspaces() {
  const dir = (STORAGE_DIRS[process.platform] || STORAGE_DIRS.linux).replace(/^~/, os.homedir());
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of entries) {
    const file = path.join(dir, name, 'workspace.json');
    try {
      const { folder } = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ws = folder && parseFolderUri(folder);
      if (ws) out.push({ ...ws, mtime: fs.statSync(file).mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Window titles look like "file.py — Folder [SSH: host]" or "Folder".
export function workspaceForTitle(title) {
  const host = /\[SSH: ([^\]]+)\]/.exec(title)?.[1] || null;
  const folder = title.replace(/\s*\[SSH: [^\]]+\]\s*$/, '').split(' — ').pop().replace(/^●\s*/, '').trim();
  return workspaces().find(w => w.host === host && path.posix.basename(w.root) === folder) || null;
}

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Remote paths starting with ~/ must leave the tilde unquoted so the remote shell expands it.
const remotePath = p => p.startsWith('~/') ? `"$HOME"/${shq(p.slice(2))}` : shq(p);

// One shared master connection per host: faster, and avoids sshd's MaxStartups dropping bursts of new connections.
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${path.join(os.homedir(), '.cursor-remote-lite', 'ssh-%C')}`, '-o', 'ControlPersist=120'];

async function ssh(host, command, limit) {
  try {
    return await sshOnce(host, command, limit);
  } catch {
    await new Promise(r => setTimeout(r, 500));
    return sshOnce(host, command, limit).catch(e => { throw new Error(`SSH 连接 ${host} 失败：${e.message}`); });
  }
}

function sshOnce(host, command, limit) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...SSH_OPTS, host, command], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0, err = '';
    child.stdout.on('data', c => { if (size < limit) { chunks.push(c); size += c.length; } });
    child.stderr.on('data', c => { err += c; });
    const timer = setTimeout(() => child.kill(), 20000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).subarray(0, limit));
      else reject(new Error(err.trim().split('\n').pop() || `ssh exited with ${code}`));
    });
  });
}

// Returns the size of a regular file, or null if it doesn't exist.
export async function fileSize(host, p) {
  if (!host) {
    try {
      const st = fs.statSync(p.replace(/^~(?=\/)/, os.homedir()));
      return st.isFile() ? st.size : null;
    } catch { return null; }
  }
  // Exits 0 whether or not the file exists, so a rejection here always means the connection failed.
  const out = await ssh(host, `test -f ${remotePath(p)} && stat -c %s -- ${remotePath(p)} || true`, 64);
  const n = parseInt(out.toString(), 10);
  return Number.isFinite(n) ? n : null;
}

async function readHead(host, p, limit) {
  if (!host) {
    const fd = fs.openSync(p.replace(/^~(?=\/)/, os.homedir()), 'r');
    try {
      const buf = Buffer.alloc(limit);
      const n = fs.readSync(fd, buf, 0, limit, 0);
      return buf.subarray(0, n);
    } finally { fs.closeSync(fd); }
  }
  return ssh(host, `head -c ${limit} -- ${remotePath(p)}`, limit);
}

export async function readFile(host, p, size) {
  const name = path.posix.basename(p);
  const image = IMAGE_TYPES[path.extname(name).toLowerCase()];
  if (image) {
    if (size > IMAGE_LIMIT) throw new Error(`图片太大（${(size / 1048576).toFixed(1)} MB），请在电脑上看`);
    const buf = await readHead(host, p, size);
    return { image: `data:${image};base64,${buf.toString('base64')}` };
  }
  const buf = await readHead(host, p, Math.min(size, TEXT_LIMIT));
  if (buf.subarray(0, 8192).includes(0)) throw new Error('二进制文件，不能预览');
  return { text: buf.toString('utf8'), truncated: size > TEXT_LIMIT };
}

// "src/a.py:12", "a.py#L12-20", "a.py (lines 3-9)" → path + first line.
export function parseRef(text) {
  let s = String(text).trim().replace(/^[`'"]+|[`'",;:.)]+$/g, '');
  let line = null;
  const m = /(?::(\d+)(?::\d+)?(?:-\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(s);
  if (m) { line = Number(m[1] || m[2]); s = s.slice(0, m.index); }
  return { p: s, line };
}
