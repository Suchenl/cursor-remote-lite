import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const DATA_DIR = path.join(os.homedir(), '.cursor-remote-lite');
const MIN_LEN = 10;

function askHidden(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, answer => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

const pw = await askHidden('新密码（至少 10 位，需同时包含字母和数字）：');
if (pw.length < MIN_LEN || !/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) {
  console.log('密码太弱，未修改');
  process.exit(1);
}
if (await askHidden('再输一次：') !== pw) {
  console.log('两次不一致，未修改');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(DATA_DIR, 'password'), pw, { mode: 0o600 });
fs.rmSync(path.join(DATA_DIR, 'sessions.json'), { force: true });
console.log('密码已更新，所有已登录设备需要重新登录。重启服务后生效。');
