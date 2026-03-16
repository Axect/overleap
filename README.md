<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="node">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license">
  <img src="https://img.shields.io/badge/sync-realtime-orange" alt="sync">
</p>

<h1 align="center">overleap</h1>

<p align="center">
  <strong>Leap over the browser.</strong><br>
  Real-time bidirectional sync between Overleaf and your local filesystem.
</p>

<p align="center">
  Edit LaTeX in your favorite editor. Changes appear on Overleaf instantly — and vice versa.
</p>

---

## Why?

Overleaf is great for collaboration. Your local editor is great for writing. **overleap** bridges the two — no manual pull/push, no git middleware, just real-time OT sync over Overleaf's native protocol.

Once your Overleaf project is just local files, **anything that can edit files can edit Overleaf** — Neovim, VS Code, scripts, and yes, AI agents.

> *Your AI assistant writes LaTeX. Collaborators see it on Overleaf. In real time.*

## Prerequisites

- **Node.js** >= 18
- **git** (needed to install the Overleaf-compatible socket.io client)

## Quick Start

```bash
npm install -g overleap

# 1. List your projects
overleap projects --cookie "your_session_cookie"

# 2. Start syncing — pick by number, name, or ID
overleap sync -p 3 --dir ./my-paper
overleap sync -p "quantum" --dir ./my-paper
overleap sync -p 64a1b2c3d4e5f6... --dir ./my-paper
```

Or use a `.env` file:

```env
OVERLEAF_COOKIE=your_session_cookie
```

Then just:

```bash
overleap sync
# → shows numbered project list, pick one interactively
```

## How It Works

```
  Local Editor                         Overleaf
  ┌──────────┐    OT ops over WS     ┌──────────┐
  │  .tex    │ ◄──────────────────►  │  Project │
  │  files   │    Socket.IO v0.9     │  docs    │
  └──────────┘                       └──────────┘
       ▲                                    ▲
       │ chokidar                           │
       │ (fs watch)              Operational Transform
       │                          (same protocol as
       ▼                           Overleaf editor)
   overleap
```

1. Connects to Overleaf using the same WebSocket protocol as the browser editor
2. Downloads all project files on first run; uploads local-only files to the server
3. Watches local files — text edits are diffed and sent as OT operations, binary files are uploaded via multipart API
4. Receives remote changes — applied to local files atomically
5. New files/docs created by collaborators are auto-downloaded

## Commands

| Command | Description |
|---------|-------------|
| `overleap sync` | Start bidirectional sync |
| `overleap projects` | List available projects |
| `overleap compile` | Trigger compilation & download PDF |

## Options

| Flag | Env Variable | Description |
|------|-------------|-------------|
| `--project, -p` | `OVERLEAF_PROJECT_ID` | Project number, name (fuzzy), or ID |
| `--dir, -d` | `OVERLEAF_DIR` | Local directory (default: cwd) |
| `--cookie, -c` | `OVERLEAF_COOKIE` | Session cookie |
| `--url, -u` | `OVERLEAF_URL` | Server URL (default: overleaf.com) |

**Project selection** is flexible — omit `-p` for an interactive numbered list, or:

```bash
-p 3                    # pick 3rd project from list
-p "quantum"            # fuzzy match by name
-p 64a1b2c3d4e5...      # direct Overleaf project ID
```

## Getting Your Cookie

1. Open [overleaf.com](https://www.overleaf.com) and log in
2. DevTools → Application → Cookies
3. Copy the full cookie string (or just the `overleaf_session2` value)

## Features

- **Text files** (`.tex`, `.bib`, `.sty`, etc.) — live OT sync, same protocol as the Overleaf editor
- **Binary files** (images, PDFs, etc.) — auto upload/download/update via REST API
- **AI-agent friendly** — flush debouncing and content stability checks prevent corrupted uploads from rapid edits
- **Local-only file detection** — files that exist locally but not on the server are uploaded on initial sync

## Limitations

- Requires a valid session cookie (no OAuth yet)

## License

MIT
