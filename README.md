<div align="center">

<img src="docs/icon.png" width="96" alt="Video Downloader" />

# Video Downloader

**A polished video download tool — YouTube · Douyin · Bilibili · Xiaohongshu · 1000+ sites**

[![Platform](https://img.shields.io/badge/platform-Windows-blue)](https://github.com/SillyShalong/video-downloader/releases)
[![Electron](https://img.shields.io/badge/Electron-45-9feaf9?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)](https://react.dev/)
[![Ant Design](https://img.shields.io/badge/Ant_Design-6-1677ff?logo=antdesign&logoColor=white)](https://ant.design/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-63%20cases-brightgreen)](#-automated-tests)

**Desktop app + CLI + Android** · Quality selection · Real-time speed · Pause/Cancel · Download history · H.264 output · Bilingual UI

[Download](#-install) · [Quick Start](#-quick-start) · [Development](#-development) · [中文文档](README.zh-CN.md)

</div>

---

![screenshot](docs/screenshot.png)

## ✨ Features

| | | |
|---|---|---|
| 🌍 **1000+ sites** | YouTube (Shorts/playlists), Douyin, Bilibili, Xiaohongshu + all yt-dlp supported sites | Paste URL or full **share text** — auto-detected |
| 🎞 **Quality selection** | Best / 1080p / 720p / 540p / 360p | Bilibili SESSDATA login for higher quality |
| 📋 **Multi-source picker** | Playlists/channels auto-detected | Check the videos you want, download only those |
| 🗂 **Download history** | Full metadata persisted (URL, path, size) | Compact list + detail drawer, delete individual records |
| 🛡 **H.264 guaranteed** | All sites lock H.264+AAC | Windows default player works, no black screen |
| 🌐 **Proxy support** | HTTP/SOCKS5 with one-click test | Douyin/Xiaohongshu auto-bypass (domestic) |
| 🔁 **Stable downloads** | Auto-retry transient errors (403/timeout) | Manual pause / cancel / resume (断点续传) |
| 📱 **Android app** | Standalone Bilibili engine + remote mode | Same UI, controls desktop via LAN |
| 🌏 **Bilingual** | 中文 / English UI toggle in settings | All labels, buttons, messages translated |
| 🖥 **Dual interface** | Electron desktop (native dialogs) | CLI for scripting (`node cli.mjs`) |

## 📥 Install

**End users (recommended)**: Download from [Releases](https://github.com/SillyShalong/video-downloader/releases):

- `VideoDownloader-Setup-x.y.z-x64.exe` — Windows installer (choose directory, desktop shortcut)
- `VideoDownloader-Portable-x.y.z-x64.exe` — Windows portable (no install needed)
- `VideoDownloader-Android-vX.Y.Z.apk` — Android app (standalone Bilibili + remote mode)

No Node.js/Python required — yt-dlp, ffmpeg, and deno are all bundled.

**From source**:

```bash
git clone https://github.com/SillyShalong/video-downloader.git
cd video-downloader
npm install
npm run setup        # Download yt-dlp / ffmpeg / deno
npm run build:web    # Build frontend
npm start            # Launch desktop app
```

## 🚀 Quick Start

### GUI

1. Paste a video URL or share text (multiple links supported)
2. Select quality → Click **Download**
3. For playlists: check the videos you want in the selection modal
4. Real-time progress with speed/ETA; click any row for full details

### CLI

```bash
node cli.mjs "https://www.youtube.com/watch?v=xxxx"          # YouTube
node cli.mjs "douyin share text"                              # Douyin
node cli.mjs "https://www.bilibili.com/video/BV..." -q 1080  # Bilibili 1080p
node cli.mjs --audio "https://youtu.be/xxxx" -o D:/Music      # Audio only (mp3)
node cli.mjs "https://youtu.be/xxxx" -p http://127.0.0.1:7890 # Via proxy
```

### Android

- **Standalone**: Open app → paste Bilibili link → download directly to phone
- **Remote mode**: Desktop runs `node gui.mjs --lan` → app ⚙ Settings → enter server address

## 🔧 Platform Details

| Platform | Engine | Notes |
|---|---|---|
| YouTube | yt-dlp + deno (JS challenges) | Proxy supported; DASH auto-merge |
| Bilibili | yt-dlp | Multi-part supported; SESSDATA for 720p+; proxy supported |
| Douyin | Custom (headless Edge in-page signing) | Bypasses Argus anti-bot; watermark-free; **must use share links** |
| Xiaohongshu | Custom (headless Edge page data) | **Must use App share links** (bare URLs blocked) |
| HLS sites | Custom (headless Edge + m3u8 extraction) | Cloudflare-protected streaming; domains via `config.json` `hlsSites` |
| Other sites | yt-dlp generic | Auto-covered (1000+ sites) |

## 📱 Mobile / Tablet (Remote Mode)

Node.js engine can't run on phones; mobile uses **remote mode** — controls the desktop service over LAN:

1. Desktop: `node gui.mjs --lan` (prints phone-accessible address)
2. Phone: Open the address in browser (add to home screen as PWA), or use the Android app

Full functionality: submit downloads, select quality, real-time progress, pause/cancel.

## 🧪 Automated Tests

```bash
npm test              # Build frontend + all tests
npm run test:gui      # GUI regression only (headless Edge drives real page)
npm run test:network  # Enable external network tests
```

63 test cases covering: site detection, share text parsing, download args (H.264 lock regression), proxy validation, explorer command line, download task full pipeline (SSE → disk), retry/pause/cancel, download history persistence, multi-source selection, anti-flicker (DOM node identity), modal close methods, remote mode connection errors.

## 🛠 Development

```
web/src/         React + AntD frontend (Vite, bilingual)
electron/        Electron main process (native dialogs, paths)
src/             Core engines (yt-dlp wrapper / Douyin / Xiaohongshu / HLS / task queue / SSE)
bin/             yt-dlp · ffmpeg · deno (npm run setup)
android/         Capacitor project (same UI, standalone Bilibili engine in Kotlin)
tests/           node:test 3-layer tests (unit / server / GUI)
```

```bash
npm run dev       # Frontend hot-reload
npm run dist      # Package Windows installer + portable (release/)
npm test          # Full test suite
```

## ❓ FAQ

**Video has audio but no picture?**
No. All downloads lock H.264 encoding (yt-dlp defaults to VP9/AV1 which Windows players can't decode). Non-H.264 sources are auto-transcoded.

**Bilibili limited to 480p?**
Guest access caps some videos. ⚙ Settings → paste SESSDATA (browser F12 → Cookie) to unlock.

**Download fails with 403?**
Usually proxy exit IP rotation. Built-in auto-retry (3 attempts); manual retry available on task row.

## 📄 License

[MIT](LICENSE)

---

<div align="center">
⭐ If this helps you, consider giving it a Star!
</div>
