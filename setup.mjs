// Interactive first-run setup: checks dependencies, sets the password, creates the GitHub Pages app, installs the service.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(os.homedir(), '.cursor-remote-lite');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const isMac = process.platform === 'darwin';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, def = '') => (await rl.question(def ? `${q} [${def}] ` : `${q} `)).trim() || def;
const yes = async (q, def = 'y') => /^y/i.test(await ask(`${q} (y/n)`, def));
const has = cmd => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const config = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } })();
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

console.log('\n== Cursor Remote 安装向导 ==\n');

console.log('1/4 检查依赖');
const missing = [];
if (!has('cloudflared')) missing.push(['cloudflared', isMac ? 'brew install cloudflared' : 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/']);
if (!has('gh')) missing.push(['gh', isMac ? 'brew install gh' : 'https://cli.github.com/']);
for (const [name, how] of missing) console.log(`  缺少 ${name}：${how}`);
if (missing.length && !await yes('  缺少的工具只影响「外网访问 / 固定地址」，是否继续？')) process.exit(1);
if (!missing.length) console.log('  cloudflared、gh 都已安装');

console.log('\n2/4 登录密码');
const pwFile = path.join(DATA_DIR, 'password');
if (!fs.existsSync(pwFile) || await yes('  已有密码，要修改吗？', 'n')) {
  rl.pause();
  run('node', [path.join(DIR, 'set-password.mjs')], { stdio: 'inherit' });
  rl.resume();
}

console.log('\n3/4 固定地址（手机 App）');
console.log('  在你的 GitHub 上建一个公开仓库，用 GitHub Pages 托管手机 App。');
console.log('  仓库里只有 App 页面和「用你的密码加密过的」电脑地址，不含密码。');
if (has('gh') && await yes('  要设置吗？')) {
  if (run('gh', ['auth', 'status']).status !== 0) {
    console.log('  先登录 GitHub：');
    rl.pause();
    run('gh', ['auth', 'login'], { stdio: 'inherit' });
    rl.resume();
  }
  const login = run('gh', ['api', 'user', '--jq', '.login']).stdout.trim();
  const name = await ask('  仓库名', config.publishRepo?.split('/')[1] || 'cursor-remote-app');
  const repo = `${login}/${name}`;
  if (run('gh', ['repo', 'view', repo]).status !== 0) {
    const r = run('gh', ['repo', 'create', repo, '--public', '--description', 'My Cursor Remote phone app']);
    if (r.status !== 0) { console.log(r.stderr); process.exit(1); }
  }
  // Pages needs at least one commit before it can be enabled; the server uploads the rest on start.
  const index = fs.readFileSync(path.join(DIR, 'app', 'index.html'));
  const sha = run('gh', ['api', `repos/${repo}/contents/index.html`, '--jq', '.sha']).stdout.trim();
  run('gh', ['api', '-X', 'PUT', `repos/${repo}/contents/index.html`, '--input', '-'], {
    input: JSON.stringify({ message: 'add app', content: index.toString('base64'), ...(sha ? { sha } : {}) }),
  });
  run('gh', ['api', '-X', 'POST', `repos/${repo}/pages`, '-f', 'source[branch]=main', '-f', 'source[path]=/']);
  config.publishRepo = repo;
  saveConfig();
  console.log(`  手机 App 地址：https://${login.toLowerCase()}.github.io/${name}/`);
}

console.log('\n4/4 后台服务');
if (isMac && await yes('  设为开机自启（后台常驻，崩溃自动重启）？')) {
  run('bash', [path.join(DIR, 'service.sh'), 'install'], { stdio: 'inherit' });
} else {
  console.log('  手动启动：npm run public（外网）或 npm start（仅局域网）');
}

console.log(`
完成！最后一步：用 ./start-cursor.sh 启动 Cursor（带调试端口），手机才能控制它。
${config.publishRepo ? `手机打开 https://${config.publishRepo.split('/')[0].toLowerCase()}.github.io/${config.publishRepo.split('/')[1]}/ ，输入密码，再「添加到主屏幕」。` : ''}`);
rl.close();
