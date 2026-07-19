# aanote

Monochrome markdown note‑taking app (Tauri v2, CodeMirror 6).

## Run

```
cargo install tauri-cli --version "^2"
npm install
cp index.html dist/index.html && cp -r js css dist/
npm run tauri build
```

Binary: `src-tauri/target/release/aanote`

## Features

- Obsidian‑style sidebar tree
- Spotlight search (Ctrl+F)
- Google Drive sync (manual + auto on save)
- Custom titlebar (drag, min/max/close)
- Light monochrome theme
- Cross‑platform (Linux, macOS, Windows)
