[中文](README.md) | **English**

# Cursor Remote Lite

Use the Cursor on your computer from your phone: read Agent replies, send messages, tap "Run / Accept", preview files, and switch windows / modes / models.
Free, open source and self-hosted. No server needed, and your phone doesn't have to be on the same Wi-Fi as your computer.

> Inspired by [len5ky/CursorRemote](https://github.com/len5ky/CursorRemote); this is a free version written from scratch.

<p align="center"><img src="docs/quickstart.gif" width="300" alt="Demo: preview a file, switch windows, change model, approve a command, send a message"></p>

<p align="center"><sub>Demo: tap a file name to preview it → switch to an SSH window → change model → approve a command → send a message and watch the Agent reply live (demo data)</sub></p>

## Screenshots

| Chat | File preview | Switch window | Pick model |
|:-:|:-:|:-:|:-:|
| <img src="docs/ui-chat.png" width="190" alt="Chat"> | <img src="docs/ui-file.png" width="190" alt="File preview"> | <img src="docs/ui-windows.png" width="190" alt="Switch window"> | <img src="docs/ui-model.png" width="190" alt="Pick model"> |

## Why I built this

An Agent run can easily take ten or twenty minutes, and it often stops midway waiting for you to tap "Run" or answer a question. Once you step away from the computer, the task just sits there.
What I wanted was simple: **see what's happening in Cursor on my computer from my phone, and keep working from there**. Without moving code to the cloud, without paying for another subscription, and working on Android and on networks in mainland China.

Existing options all fall a little short:

- **Cursor's official mobile app** (Cursor for iOS + Remote Control): iPhone / iPad only (iOS 26+), with no native Android app yet; requires a paid plan; Remote Control only works with the Agents window, and the Agent's reasoning loop moves to Cursor's cloud. Conversations in regular editor windows or SSH remote windows can't be controlled.
- **[len5ky/CursorRemote](https://github.com/len5ky/CursorRemote)**: same idea (controls the local Cursor through its debugging port), but requires a $7.99/month license, and the code is source-available rather than open source; for access from outside your network you have to set up Tailscale or a Telegram bot yourself.
- **Remote desktop** (Sunlogin, ToDesk, RustDesk, Chrome Remote Desktop): can control everything, but reading Cursor's chat panel and hitting tiny buttons on a small phone screen is painful, and it uses a lot of data.

### Why support both Android and iPhone

The official app is iPhone-only, but people's phones are far from all iPhones:

| Region | iOS | Android | Period |
|---|---|---|---|
| United States | 60.7% | 39.3% | August 2026 |
| Europe | 39.5% | 60.4% | July 2026 |
| Worldwide | ~28% | ~72% | 2026 |
| Mainland China | Minority | Majority, and many Huawei, Xiaomi, OPPO, etc. phones have no Google services | — |

Data from [StatCounter](https://gs.statcounter.com/os-market-share/mobile/), which measures each OS's share of traffic across roughly 1.5 million websites. It reflects "phones actually in use", not sales. iPhone users browse more, so iOS's share is slightly inflated; treat the exact numbers as rough, but the conclusion is clear: **iPhone is slightly ahead in the US, Android leads in Europe and worldwide, and in China most phones are Android without Google services**.

So this project provides both: an Android app that installs without Google services, and a full-screen "Add to Home Screen" app on iPhone (no App Store listing needed, so it works in Europe too).

## How it compares

| | Cursor Remote Lite (this project) | Cursor official iOS app | len5ky/CursorRemote | Remote desktop |
|---|---|---|---|---|
| Price | Free | Requires a paid Cursor plan | $7.99/month | Mostly free / paid |
| License | MIT open source | Closed source | source-available | — |
| Phones | Android app, iPhone, any browser | iPhone / iPad only | Any browser, Telegram | Apps for each platform |
| Windows it can control | All windows: local, SSH remote, Agents | Agents window only (Remote Control) | Local windows | The whole desktop |
| Where your code / chats go | Only on your computer, sent to your phone through a Cloudflare tunnel (HTTPS) | Agent loop runs in Cursor's cloud | Your computer + LAN / Tailscale | The remote desktop vendor's servers |
| Access from outside your network | Built in, no setup; fixed address | Built in | Set up Tailscale / Telegram yourself | Built in |
| Experience on the phone | Chat UI + live screen, file preview | Native app | Chat UI | Shrunken desktop screen |
| Alerts when done / waiting for approval | ✅ In-app notifications, nothing else to install | ✅ | Via Telegram | ❌ |
| Computer must stay on | Yes (no sleep) | Not for cloud Agents; yes for Remote Control | Yes | Yes |

**This project's limitations**, stated up front:

- It works by reading Cursor's UI, so a major Cursor redesign may require an update.
- The background service and startup scripts currently support macOS only; on Windows you have to start things manually (see below).
- Cloudflare's free quick tunnels come with no availability guarantee and occasionally disconnect and reconnect.

## Features

- **Chat mode**: read Agent conversations like a chat app (bubbles, tool-call cards, thinking), type and send directly. When the Agent stops to wait for your approval, the buttons appear on your phone.
- **File preview**: tap a file name in the conversation (shown in blue) or a tool card marked 📄 to view the file full screen with line numbers; images are displayed directly. Files in SSH remote windows are read via `ssh` (your computer needs passwordless ssh to that machine; if you already use Cursor over SSH, this is usually set up).
- **Screen mode**: a live view of either just the chat panel or the whole window. Taps, scrolling, zooming and common keys are all sent to the computer.
- **Notifications**: when an Agent finishes, or stops waiting for you to tap "Run / Allow", your phone gets a notification; tap it to jump straight to that window. All windows trigger alerts, except the one you're currently viewing on your phone.
- **Multiple windows**: tap the window name in the top-left to switch windows, including SSH remote windows and the Agents window; you can also open the Cursor Agents window with one tap.
- **Modes / models / chat history**: switch between Agent / Plan / Ask, change models, open past conversations and start new ones, right from your phone.
- **Model parameters**: tap "Parameters" in the model list to adjust context length (e.g. 300K / 1M), reasoning effort (Low → Max) and the Fast toggle; there's also a MAX Mode toggle at the top. Which options are available depends on what Cursor offers for that model.
- **Queued messages**: messages sent while the Agent is running go into Cursor's queue. Your phone shows "Agent is running" plus each queued message, which you can edit, send immediately (interrupting the current turn) or delete. You can also stop the Agent with one tap.
- **Sub-agents**: while sub-agents spawned by the Agent are running, your phone shows "Subagents running: N" (collapsed by default; tap to expand the list). Tap "View" to see a sub-agent's own conversation (read-only), or stop it individually.
- **Changed files**: after the Agent edits files, "N changed" appears above the input box. Tap it to see lines added / removed per file, tap a file name to view it, and Keep or Undo each file, just like Keep / Undo on the desktop.
- **Send images**: the image button next to the input box attaches a photo or screenshot (say, a picture of an error on another screen) to Cursor's input box, so you can send it along with your message. Large images are compressed on the phone first.
- **Confirmation for risky actions**: stopping the Agent or a sub-agent, undoing changes, deleting queued messages, rejecting, removing a device and unpairing all ask for confirmation first.
- **Voice input (off by default)**: your keyboard's microphone already does dictation, so the microphone button is hidden by default. Turn it on under "⋯ → Voice button": the Android app uses the system speech recognizer; iPhone / browsers use the browser's built-in speech recognition.
- **中文 / English**: follows your phone's system language by default; you can also switch under "⋯ → 语言 / Language". Notifications follow the chosen language too.
- **Device pairing**: no passwords. Your computer generates a one-time QR code, you scan it with your phone, and you're paired; optional Authenticator two-factor verification.
- **Fixed address**: the app is hosted on your own GitHub Pages, so you don't need to re-pair when your computer restarts or the tunnel address changes.

## How it works

```
Phone app (GitHub Pages) ──HTTPS/WebSocket──> Cloudflare tunnel ──> relay on your computer (Node) ──CDP──> Cursor
```

(Phone app on GitHub Pages → Cloudflare tunnel → relay (Node) on your computer → Cursor.)

Cursor is built on Electron. When started with `--remote-debugging-port`, the relay uses the Chrome DevTools Protocol to read chat content, capture the screen, and simulate clicks and keyboard input.

## Requirements

- macOS (`server.mjs` also runs on Windows / Linux, but the startup and background service scripts only support macOS; see "Windows" below)
- Node.js 22+
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/): for access from outside your network, `brew install cloudflared`
- [GitHub CLI](https://cli.github.com/): for the fixed address, `brew install gh`

## Quick start (5 minutes)

**Step 1: Install on your computer**

```bash
git clone https://github.com/Suchenl/cursor-remote-lite.git
cd cursor-remote-lite
npm install
npm run setup        # create the phone app repo, enable start at login, optionally enable 2FA
./start-cursor.sh    # restart Cursor with the debugging port (quits the current Cursor first)
```

`npm run setup` creates a public repository under **your own** GitHub account (named `cursor-remote-app` by default) and uses GitHub Pages to host the phone app and your computer's encrypted address. Everyone uses their own; it has nothing to do with the author or other users.

**Step 2: Pair your phone**

```bash
npm run pair
```

A QR code appears in the terminal (valid for 10 minutes, single use). Scan it with your phone's camera or browser to open it; there's no password to type.
If you can't scan it, send the link shown below the QR code to your phone and open it (or paste it into the app's input box).

<p align="center"><img src="docs/ui-pair.png" width="220" alt="Screen shown before pairing"></p>

**Step 3: Install it on your phone (optional, but recommended)**

- **iPhone**: open it in Safari → Share → Add to Home Screen
- **Android**: download and install [CursorRemote.apk](https://github.com/Suchenl/cursor-remote-lite/releases/latest/download/CursorRemote.apk), then scan the pairing code with your phone. The browser will offer to "Open in app"; tap it and the app gets paired (if the pairing code has already been used, run `npm run pair` again).
  Works on Huawei and other phones without Google services (the browser's "Install app" option usually isn't available on these phones).
  Note: pure HarmonyOS (HarmonyOS NEXT / 5.0 and later) can't install APKs directly; install "Zhuoyitong" (卓易通) first.

**Step 4: Start using it**

- The top-left shows the current window; tap it to switch windows (local / SSH / Agents).
- Send messages from the input box at the bottom; use `Agent ▾` / `Auto ▾` to switch mode and model; "History" opens earlier conversations and "＋ New" starts a new one.
- When the Agent is waiting for your approval (running a command, accepting changes), the buttons show up right in the conversation.
- Tap a blue file name or a card marked 📄 to preview a file; press Back to close it.
- "Screen" in the top-right switches to the live view, where you can tap anything in the Cursor UI.
- "⋯ → Enable notifications" in the top-right makes your phone alert you when the Agent finishes or needs approval (see "Notifications" below).

From now on, Cursor must always be started with the debugging port; just launch it with `./start-cursor.sh`.

## Notifications

In the app, tap "⋯ → Enable notifications", then tap "Send a test notification" to confirm it works.

| Phone | How notifications arrive | Things to note |
|---|---|---|
| Android app | The app keeps its own background connection to your computer, without Google services, so it works on Huawei too | A persistent "Waiting for Agent messages" notification stays in the notification bar (required by Android). On Huawei / Xiaomi etc., allow background activity: on Huawei, go to "Settings → Apps & services → App launch", set Cursor Remote to manage manually and turn everything on |
| iPhone | System push (Web Push), works even when the app is closed | You must first "Add to Home Screen" and open it from the home screen icon; iOS 16.4 or later |
| Desktop / Android browser | Browser push | The browser must be allowed to show notifications |

When you get alerted:

- **Waiting for approval**: the Agent has been stuck on a "Run / Allow / Accept" button for more than about 10 seconds (buttons that flash by briefly with auto-run enabled don't count).
- **Finished**: the Agent has stopped running; the notification includes the start of its reply.
- The window you're currently viewing on your phone doesn't trigger duplicate alerts.

Notifications are sent directly by your computer: the Android app connects straight to your computer; iPhone and browsers go through Apple's / Google's push servers, but the content is end-to-end encrypted and the push servers can't read it.

## Keeping your computer online (preventing sleep)

The relay runs on your computer, so **once your computer sleeps, your phone can't connect**.

| | Screen locked | Display off | Sleep / lid closed |
|---|---|---|---|
| Does the phone still work? | ✅ Yes | ✅ Yes (screen mode falls back to periodic screenshots, a bit choppy) | ❌ No |

So there's only one thing to do: **allow the display to turn off and the screen to lock, but don't let the system sleep**.

### macOS

**Laptops (no sleep while plugged in)**: System Settings → Battery → Options → turn on "Prevent automatic sleeping on power adapter when the display is off".
Or use the command line (affects only the plugged-in state; `-c` = charger):

```bash
sudo pmset -c sleep 0          # never sleep while plugged in
sudo pmset -c displaysleep 10  # display still turns off after 10 minutes (saves power, doesn't affect use)
pmset -g | grep -E " sleep|displaysleep"   # show current settings
```

**Desktops (Mac mini / iMac / Studio)**: System Settings → Energy → turn on "Prevent automatic sleeping when the display is off".

**Just stay awake temporarily** (e.g. letting the Agent run a long task before you head out):

```bash
caffeinate -s    # prevent sleep while plugged in; press Ctrl+C to restore
```

**Closing the lid**: a MacBook always sleeps when the lid is closed (unless it has an external display + power + keyboard). If you want to use it remotely, don't close the lid; turn the brightness all the way down and lock the screen instead.
Forcing it with `sudo pmset -a disablesleep 1` is not recommended: it will overheat if you put it in a bag.

### Windows

Settings → System → Power & battery → Screen and sleep: set "When plugged in, put my device to sleep after" to **Never**; you can keep "Turn off my screen" (e.g. 10 minutes).
Or use an administrator PowerShell:

```powershell
powercfg /change standby-timeout-ac 0     # never sleep while plugged in
powercfg /change monitor-timeout-ac 10    # turn off the display after 10 minutes
powercfg /change hibernate-timeout-ac 0   # never hibernate while plugged in
# Don't sleep when the laptop lid is closed (while plugged in):
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
```

How to start on Windows: launch Cursor with `"%LOCALAPPDATA%\Programs\cursor\Cursor.exe" --remote-debugging-port=9222`, then run `npm run public` in the project directory (keep that window open). `npm run pair` works as usual.

### Trade-offs

- **Power use**: a laptop idling with the display off draws about 3–8 W, under 0.2 kWh per day; a desktop draws 30–100 W, 1–2 kWh per day.
- **Battery**: keeping a laptop plugged in at full charge for long periods speeds up battery wear. macOS's "Optimized Battery Charging" and Windows vendors' "battery protection / 80% charge limit" help; turning them on is recommended.
- **Security**: a computer that's always on can always be controlled by paired phones. Keep it locked (locking doesn't affect use), and remove devices you no longer use under "⋯ → Paired devices".

### What happens if you don't set this up

- After your computer sleeps, the phone shows "Computer offline" and you can't do anything; **any task the Agent is running also pauses** until someone wakes the computer.
- After waking, the service recovers automatically. The tunnel address changes, but the new address is published automatically and the phone reconnects within about a minute, **no re-pairing needed**.

## Security

- **Pairing**: the link generated by `npm run pair` contains a random key and a one-time pairing code; it expires after 10 minutes and is invalidated after use. After pairing, the phone receives a device token, and the computer stores only its hash.
- **Nothing on GitHub to crack**: `url.json` (your computer's address) in the Pages repository is encrypted with a random 256-bit key. That key is passed to the phone only through the pairing link and is never uploaded. There's no password, so there's no offline password brute-forcing either.
- **Two-factor verification (optional)**: `npm run 2fa` binds Google Authenticator / Microsoft Authenticator / 1Password, etc. Once enabled, pairing a new device requires a 6-digit code; you can also require re-verification every N days (default 30; 0 means only verify at pairing). Even if a pairing link leaks, it can't be used without the code from your phone.
- **Managing devices**: view and remove devices on your phone under "⋯ → Paired devices", or on your computer with `npm run devices`. A removed device is disconnected immediately.
- Debugging port 9222 listens only on localhost; in public mode the relay also listens only on `127.0.0.1`, so it can only be reached from outside through the tunnel.
- Repeated failed pairing attempts trigger a temporary lockout.
- A paired device has full control over your Cursor, which is equivalent to being able to run commands on your computer. **Don't post pairing links in group chats or anywhere public.**

## Common commands

| Command | What it does |
|---|---|
| `npm run setup` | Setup wizard (can be re-run) |
| `npm run pair` | Pair a new device (shows a QR code) |
| `npm run devices` | List paired devices; `npm run devices remove <id>` removes one |
| `npm run 2fa` | Enable / re-bind Authenticator 2FA; `npm run 2fa off` disables it; `npm run 2fa status` shows status |
| `npm run public` | Run in the foreground (public access + fixed address) |
| `npm start` | Run in the foreground (LAN only) |
| `./service.sh status / logs / uninstall` | Background service status / logs / uninstall |
| `npm run reset` | Clear all pairings, 2FA and configuration (you'll need to pair again afterwards) |

## FAQ

**The phone shows "Not connected to Cursor"**: Cursor wasn't started with the debugging port; run `./start-cursor.sh`.

**The phone shows "Computer offline"**: the computer is asleep / shut down, or the service just restarted (the new address takes effect in about a minute, and the app retries automatically). See "Preventing sleep" above.

**Got a new phone / cleared browser data**: run `npm run pair` on your computer to pair again, and delete the old device under "Paired devices".

**Does it cost anything? Does it use up any free quotas?** No. At runtime it uses only three things:
- Cloudflare quick tunnels: free, no sign-up required.
- GitHub Pages: free for public repositories. Your computer publishes its address once per restart (one commit); Pages recommends no more than 10 builds per hour, and going over just means changes take effect a bit later.
- GitHub API: 5,000 requests per hour; only a handful are actually used.

GitHub Actions is only used when the author publishes a new APK release; nothing runs on the user's side.

**Not receiving notifications**: first use "Send a test notification" from the menu. If the test notification doesn't arrive: on Android, check the system notification permission and background activity permission; on iPhone, make sure you opened the app from the home screen icon. If the test notification arrives but Agent alerts don't: your computer may be asleep, or Cursor wasn't started with `./start-cursor.sh`.

**Doesn't work on a company network**: Cloudflare tunnels use port 443, which usually works; if even `trycloudflare.com` is blocked, you can only use `npm start` on the same LAN.

**SSH remote window doesn't show up**: tap the window name in the top-left to open the window list; the list refreshes every time you open it.

**Tapping a file says it can't be found**: the file may have been deleted or moved; for files in SSH windows, your computer needs passwordless `ssh` to that machine.

## Support the project

If you find it useful, you can buy the author a coffee ☕ (entirely optional).

| WeChat Pay | Alipay |
|---|---|
| <img src="app/donate-wechat.jpg" width="220" alt="WeChat Pay QR code"> | <img src="app/donate-alipay.jpg" width="220" alt="Alipay QR code"> |

What the app shows under "⋯ → Support the author" is controlled by `app/donate.json`. You can add international payment links in `links`, for example:

```json
"links": [{ "label": "PayPal", "url": "https://paypal.me/your-username" }]
```

## License

MIT
