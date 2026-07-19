# aanote

Monochrome markdown note-taking app (Tauri v2, CodeMirror 6).

## Install

### Prerequisites
- [Rust](https://rustup.rs)
- [Node.js](https://nodejs.org) 18+
- Linux: `sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev`

### Build from source

```bash
git clone git@github.com:CubeSeven/aanoteapp.git
cd aanoteapp
npm install
npm run build
```

Binary: `src-tauri/target/release/aanote`

### Google Drive sync

Create a Google Cloud project, enable Drive API, create OAuth 2.0 credentials (Desktop app). Set them in `js/app.js`:

```js
const GDRIVE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID";
const GDRIVE_CLIENT_SECRET = "YOUR_GOOGLE_CLIENT_SECRET";
```

Then rebuild: `npm run build`

## Usage

| Action | Shortcut |
|---|---|
| New note | F2 |
| New folder | F3 |
| Search | Ctrl+F |
| Save + sync | Ctrl+S |
| Toggle sidebar | Ctrl+\ |
| Rename | F4 |
| Delete | Del |

Settings → Google Drive → Connect → pick notes folder → Sync Now.

## Cross-platform

- Linux (GTK3 + WebKitGTK)
- macOS (native WebView)
- Windows (WebView2)

CI builds on tag push (`v*`).
