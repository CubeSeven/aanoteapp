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

`npm run build` first regenerates the editor bundle (`js/editor.js` → `js/cm.bundle.js`
via esbuild), then compiles the Rust binary.

Binary: `src-tauri/target/release/aanote`

To rebuild only the editor bundle after editing `js/editor.js`:

```bash
npm run build:bundle
```

### Google Drive sync

Create a Google Cloud project, enable Drive API, create OAuth 2.0 credentials (Desktop app). Set them in `js/gdrive-config.js` (copy from `js/gdrive-config.example.js`):

```js
export const GDRIVE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID";
export const GDRIVE_CLIENT_SECRET = "YOUR_GOOGLE_CLIENT_SECRET";
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
| Delete (soft, undoable) | Del |
| Pin / Unpin | right-click → Pin / Unpin |

Settings → Google Drive → Connect → pick notes folder → Sync Now.

### Data safety

- **Atomic writes** — notes and the sync index are written via temp-file-then-rename, so a crash can't corrupt them.
- **Trash & undo** — deletes move to `.aanote-trash/` (auto-purged after 30 days); an undo toast appears immediately.
- **Sync conflicts** — when a note changed on both sides, the loser is preserved as a `<name> (conflict <timestamp>).md` copy instead of being silently overwritten.
- **Sync serialization** — only one sync runs at a time; overlapping triggers are skipped.
- **Paginated Drive listing** — vaults over 100 files sync correctly (no silent truncation).

## Cross-platform

- Linux (GTK3 + WebKitGTK)
- macOS (native WebView)
- Windows (WebView2)

CI builds on tag push (`v*`).
