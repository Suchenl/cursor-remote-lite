# Cursor Remote Lite

在手机上用电脑里的 Cursor：看 Agent 回复、发消息、点「运行 / 接受」、切换窗口 / 模式 / 模型。
免费、开源、自托管，不需要服务器，也不需要手机和电脑在同一个 Wi-Fi。

> 灵感来自 [len5ky/CursorRemote](https://github.com/len5ky/CursorRemote)，这是一个从零实现的免费版本。

## 功能

- **聊天模式**：像聊天 App 一样看 Agent 对话（气泡、工具调用卡片、思考过程），直接输入发送，Agent 停下来等你确认时，按钮会出现在手机上。
- **文件预览**：对话里出现的文件名（蓝色下划线）、编辑过文件的工具卡片，点一下就能全屏查看文件内容，带行号；图片直接显示。SSH 远程窗口的文件通过 `ssh` 读取（要求电脑能免密 ssh 到那台机器，用 Cursor 连 SSH 的电脑一般都已配置好）。
- **屏幕模式**：实时画面，可以只看聊天面板或整个窗口，点按 / 滚动 / 缩放 / 常用按键都会传到电脑上。
- **多窗口**：点顶部标题切换窗口，SSH 远程窗口、Agents 窗口都能选；也能一键打开 Cursor Agents 窗口。
- **模式 / 模型 / 历史对话**：手机上直接切 Agent / Plan / Ask，换模型，打开历史对话，新建对话。
- **装成 App**：「添加到主屏幕」后全屏打开，没有浏览器地址栏。
- **固定地址**：App 放在你自己的 GitHub Pages 上，电脑重启、隧道地址变化都不用重新扫码。
- **安全**：密码登录（失败锁定），GitHub 上只有用密码加密过的电脑地址，没有密码就打不开。

## 原理

```
手机 App (GitHub Pages) ──HTTPS/WebSocket──> Cloudflare 隧道 ──> 电脑上的中继 (Node) ──CDP──> Cursor
```

Cursor 基于 Electron，用 `--remote-debugging-port` 启动后，中继通过 Chrome DevTools Protocol 读取聊天内容、截取画面、模拟点击和键盘输入。

## 要求

- macOS（Windows / Linux 上 `server.mjs` 也能跑，但启动和后台服务脚本只支持 macOS）
- Node.js 22+
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)：外网访问，`brew install cloudflared`
- [GitHub CLI](https://cli.github.com/)：固定地址，`brew install gh`

## 安装

```bash
git clone https://github.com/Suchenl/cursor-remote-lite.git
cd cursor-remote-lite
npm install
npm run setup        # 设密码、创建手机 App 仓库、设置开机自启
./start-cursor.sh    # 让 Cursor 带调试端口重启（会先退出当前 Cursor）
```

`npm run setup` 结束时会打印你的手机 App 地址，形如 `https://<你的GitHub用户名>.github.io/cursor-remote-app/`。
用手机打开，输入密码，然后：

- **iPhone**：Safari → 分享 → 添加到主屏幕
- **Android**：下载 [CursorRemote.apk](https://github.com/Suchenl/cursor-remote-lite/releases/latest/download/CursorRemote.apk) 安装，首次打开填入上面的地址。
  华为等没有谷歌服务的手机也能用（浏览器的「安装应用」在这些手机上通常不可用）。
  注意：纯血鸿蒙（HarmonyOS NEXT / 5.0 及以上）不能直接装 APK，需要先装「卓易通」。

以后每次 Cursor 重启都要带调试端口，用 `./start-cursor.sh` 启动即可。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run setup` | 安装向导（可重复运行） |
| `npm run set-password` | 修改密码（会注销所有已登录设备） |
| `npm run public` | 前台运行（外网 + 固定地址） |
| `npm start` | 前台运行（只在局域网） |
| `./service.sh status / logs / uninstall` | 后台服务状态 / 日志 / 卸载 |
| `npm run reset` | 删除密码、配置和所有登录状态 |

## 安全说明

- 能登录的人可以完全控制你的 Cursor，等同于能在你电脑上执行命令。请用足够长的密码（向导要求至少 10 位、包含字母和数字）。
- 密码只存在本机 `~/.cursor-remote-lite/password`，不会上传。GitHub 仓库里的 `url.json` 是用密码加密过的（PBKDF2 + AES-GCM）。
- 调试端口 9222 只监听本机；公网模式下中继也只监听 `127.0.0.1`，外部只能通过隧道访问。
- 连续输错密码会被锁定 15 分钟。

## 常见问题

**手机上显示「未连接到 Cursor」**：Cursor 没带调试端口启动，运行 `./start-cursor.sh`。

**公司网络打不开**：Cloudflare 隧道走 443 端口，一般都能用；如果连 `trycloudflare.com` 都被拦，就只能在同一局域网下用 `npm start`。

**SSH 远程窗口看不到**：点顶部标题打开窗口列表，列表每次打开都会刷新。

## 赞赏

觉得好用的话，可以请作者喝杯咖啡 ☕（完全自愿）

| 微信 | 支付宝 |
|---|---|
| <img src="app/donate-wechat.jpg" width="220" alt="微信收款码"> | <img src="app/donate-alipay.jpg" width="220" alt="支付宝收款码"> |

App 里「⋯ → 赞赏作者」显示的内容由 `app/donate.json` 控制，可以在 `links` 里加海外付款链接，例如：

```json
"links": [{ "label": "PayPal", "url": "https://paypal.me/你的用户名" }]
```

## License

MIT
