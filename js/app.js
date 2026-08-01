// ============================================================
// aanote — Frontend (v4: icons, DnD, reorder, tree UI)
// ============================================================

import { createEditor } from "./cm.bundle.js";
import { loadIcons, iconHTML } from "./icons.js";
import { GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET } from "./gdrive-config.js";

const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;
const { getCurrentWindow } = window.__TAURI__.window;

// ---------- Custom titlebar ----------
// (wired inside DOMContentLoaded below)

// ---------- Constants ----------
const MOBILE_BREAKPOINT = 720;
const COLLAPSE_KEY = "aanote-collapsed";
const SIDEBAR_KEY = "aanote-sidebar";
const PINNED_KEY = "aanote-pinned";
const RECENT_KEY = "aanote-recent";
const THEME_KEY = "aanote-theme";
const DRAG_HOLD_MS = 250;
const DELETE_HOLD_MS = 800; // long-press to delete
const PREFIX_RE = /^\d{2,3}-/;
const MAX_RECENT = 8;

// ---------- Themes ----------
// fg/bg here are used ONLY to render the swatch preview (CSS owns the actual
// ramp via [data-theme="..."]). Keep these in sync with css/style.css.
const THEMES = [
  { id: "paper",  label: "Aa", fg: "#1536ff", bg: "#dddfde" },
  { id: "light",  label: "Aa", fg: "#111111", bg: "#ffffff" },
  { id: "dark",   label: "Aa", fg: "#e8e8e8", bg: "#1a1a1a" },
  { id: "sepia",  label: "Aa", fg: "#3a2f1f", bg: "#f1e6c8" },
];
let activeTheme = localStorage.getItem(THEME_KEY) || "paper";

function applyTheme(id) {
  activeTheme = id;
  document.documentElement.setAttribute("data-theme", id);
  localStorage.setItem(THEME_KEY, id);
  // Update swatch active states without a full re-render.
  document.querySelectorAll(".theme-swatch").forEach((el) => {
    el.classList.toggle("active", el.dataset.theme === id);
  });
}

function renderThemeSwatches() {
  const container = document.getElementById("theme-swatches");
  if (!container) return;
  container.innerHTML = "";
  for (const t of THEMES) {
    const sw = document.createElement("div");
    sw.className = "theme-swatch" + (t.id === activeTheme ? " active" : "");
    sw.dataset.theme = t.id;
    sw.title = t.id;
    sw.style.background = t.bg;
    sw.style.color = t.fg;
    sw.textContent = t.label;
    sw.addEventListener("click", () => applyTheme(t.id));
    container.appendChild(sw);
  }
}

// ---------- State ----------
let activeNotePath = null;
let fileTree = [];
let prevTreeSignature = ""; // P1: skip rebuild when unchanged
let isDirty = false;
let rootPath = localStorage.getItem("aanote-root") || null;
let selectedIndex = 0;
let flatItems = [];
// searchMode flag removed – spotlights use modal
let ignoreNextChange = false;
let sidebarOpen = null;
let collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]"));
let saveTimeout;
let isRefreshing = false;
let activeNoteMtime = null; // C3: track disk mtime to detect external changes
let pinned = new Set(JSON.parse(localStorage.getItem(PINNED_KEY) || "[]"));
let recent = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
let lastDeleted = null; // {trashPath, path} for undo (Feature 2)

// ---------- DOM ----------
const fileTreeEl = document.getElementById("file-tree");
const fileNav = document.getElementById("file-navigator");
const cmHost = document.getElementById("cm-host");
const titleInput = document.getElementById("title-input");
const editorContainer = document.getElementById("editor-container");
const editorPlaceholder = document.getElementById("editor-placeholder");
const errorBanner = document.getElementById("error-banner");
const btnNewNote = document.getElementById("btn-new-note");
const btnNewFolder = document.getElementById("btn-new-folder");
const btnSearch = document.getElementById("btn-search");
const sidebarToggle = document.getElementById("sidebar-toggle");
const backdrop = document.getElementById("backdrop");
const btnSettings = document.getElementById("btn-settings");
const settingsModal = document.getElementById("settings-modal");
const btnImportFolder = document.getElementById("btn-import-folder");
const localDirPath = document.getElementById("local-dir-path");
const btnGDriveConnect = document.getElementById("btn-gdrive-connect");
const btnGDriveSync = document.getElementById("btn-gdrive-sync");
const btnGDriveReset = document.getElementById("btn-gdrive-reset");
const gdriveStatusLbl = document.getElementById("gdrive-status");
const actionBar = document.getElementById("action-bar");
const syncStatus = document.getElementById("sync-status");
const syncStatusIcon = document.querySelector("#sync-status .sync-status-icon");
const syncStatusText = document.querySelector("#sync-status .sync-status-text");
let syncStatusTimer = null;
const chkAutoSync = document.getElementById("chk-auto-sync");

const searchModal = document.getElementById("search-modal");
const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");
const searchIconPlaceholder = document.getElementById("search-icon-placeholder");

const contextMenu = document.getElementById("context-menu");
const ctxRename = document.getElementById("ctx-rename");
const ctxDelete = document.getElementById("ctx-delete");
const ctxPin = document.getElementById("ctx-pin");

// ---------- Editor ----------
const view = createEditor(cmHost, () => {
  if (!ignoreNextChange) {
    isDirty = true;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveNote, 1000);
  }
});

function findNodeByName(nodes, name) {
  for (const n of nodes) {
    if (!n.is_dir && displayName(n).toLowerCase() === name.toLowerCase()) {
      return n;
    }
    if (n.is_dir && n.children) {
      const found = findNodeByName(n.children, name);
      if (found) return found;
    }
  }
  return null;
}

cmHost.addEventListener("open-wiki-link", async (e) => {
  const targetName = e.detail.name;
  const targetNode = findNodeByName(fileTree, targetName);
  if (targetNode) {
    openNote(targetNode.path);
  } else {
    try {
      const nameWithExt = targetName.endsWith(".md") ? targetName : `${targetName}.md`;
      const path = await invoke("create_note", {
        dirPath: rootPath,
        name: nameWithExt,
      });
      await loadTree();
      const relPath = path.replace(`${rootPath}/`, "");
      await openNote(relPath, true);
    } catch (err) {
      showError(String(err));
    }
  }
});

cmHost.addEventListener("open-external-link", async (e) => {
  const url = e.detail.url;
  try {
    await invoke("open_external_url", { url });
  } catch (err) {
    showError(String(err));
  }
});

function setEditorContent(text) {
  ignoreNextChange = true;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
  ignoreNextChange = false;
}

function getEditorContent() {
  return view.state.doc.toString();
}

// ============================================================
// Sidebar
// ============================================================

function isMobile() {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

function applySidebar(open) {
  sidebarOpen = open;
  fileNav.classList.toggle("hidden", !open);
  // Mirror open/closed state onto the toggle button so CSS can show an
  // active indicator (e.g. a dot under the icon).
  sidebarToggle.classList.toggle("active", open);
  if (isMobile()) backdrop.classList.toggle("visible", open);
  else backdrop.classList.remove("visible");
  localStorage.setItem(SIDEBAR_KEY, open ? "1" : "0");
}

function toggleSidebar() {
  applySidebar(!sidebarOpen);
}

function initSidebar() {
  if (isMobile()) {
    applySidebar(false);
    return;
  }
  applySidebar(localStorage.getItem(SIDEBAR_KEY) !== "0");
}

// P9: debounce resize so we don't write localStorage dozens of times per
// second during a window-edge drag.
let resizeTimer = null;
window.addEventListener("resize", () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (isMobile() && sidebarOpen && !backdrop.classList.contains("visible")) {
      applySidebar(false);
    } else if (!isMobile() && !sidebarOpen) {
      if (localStorage.getItem(SIDEBAR_KEY) !== "0") applySidebar(true);
    }
  }, 120);
});

sidebarToggle.addEventListener("click", toggleSidebar);
backdrop.addEventListener("click", () => applySidebar(false));

function initSettingsBtn() {
  btnSettings.innerHTML = iconHTML("settings");
  if (btnGDriveSync) btnGDriveSync.innerHTML = iconHTML("refresh-cw");
  if (btnGDriveReset) btnGDriveReset.innerHTML = iconHTML("trash-2");
}

btnImportFolder.addEventListener("click", async () => {
  settingsModal.classList.add("hidden");
  await pickDirectory();
});

// ---------- Google Drive sync ----------

/* GDrive credentials imported from gdrive-config.js */

async function updateGDriveStatus() {
  if (!gdriveStatusLbl) return;
  try {
    const status = await invoke("gdrive_status");
    const autoSyncEl = document.getElementById("auto-sync-setting");
    if (status === "connected") {
      gdriveStatusLbl.textContent = "Connected";
      if (btnGDriveConnect) {
        btnGDriveConnect.textContent = "Disconnect";
        btnGDriveConnect.dataset.mode = "logout";
      }
      if (btnGDriveSync) btnGDriveSync.classList.remove("hidden");
      if (btnGDriveReset) btnGDriveReset.classList.remove("hidden");
      if (autoSyncEl) autoSyncEl.classList.remove("hidden");
      if (chkAutoSync) {
        chkAutoSync.checked = localStorage.getItem("auto-sync-enabled") !== "0";
      }
    } else {
      gdriveStatusLbl.textContent = "Disconnected";
      if (btnGDriveConnect) {
        btnGDriveConnect.textContent = "Connect";
        btnGDriveConnect.dataset.mode = "login";
      }
      if (btnGDriveSync) btnGDriveSync.classList.add("hidden");
      if (btnGDriveReset) btnGDriveReset.classList.add("hidden");
      if (autoSyncEl) autoSyncEl.classList.add("hidden");
    }
  } catch (e) {
    gdriveStatusLbl.textContent = "Error";
    console.error(e);
  }
}

function updateLocalDirPath() {
  if (!localDirPath) return;
  if (rootPath) {
    localDirPath.textContent = rootPath;
    localDirPath.title = rootPath;
  } else {
    localDirPath.textContent = "Not selected";
    localDirPath.title = "";
  }
}

btnSettings.addEventListener("click", () => {
  if (settingsModal.classList.contains("hidden")) {
    settingsModal.classList.remove("hidden");
    updateGDriveStatus();
    updateLocalDirPath();
    renderThemeSwatches();
  } else {
    settingsModal.classList.add("hidden");
  }
});

settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) {
    settingsModal.classList.add("hidden");
  }
});

// Auto-sync toggle change handler
if (chkAutoSync) {
  chkAutoSync.addEventListener("change", () => {
    localStorage.setItem("auto-sync-enabled", chkAutoSync.checked ? "1" : "0");
  });
}

if (btnGDriveConnect) btnGDriveConnect.addEventListener("click", async () => {
  const mode = btnGDriveConnect.dataset.mode;
  if (mode === "logout") {
    try {
      await invoke("gdrive_logout");
      await updateGDriveStatus();
      showError("Disconnected from Google Drive.");
    } catch (e) {
      showError(String(e));
    }
  } else {
    btnGDriveConnect.disabled = true;
    btnGDriveConnect.textContent = "Connecting...";
    try {
      await invoke("gdrive_login", {
        clientId: GDRIVE_CLIENT_ID,
        clientSecret: GDRIVE_CLIENT_SECRET,
      });
      await updateGDriveStatus();
      showError("Connected to Google Drive.");
      if (rootPath) {
        try {
          setSyncStatus("syncing");
          const res = await invoke("gdrive_sync", { rootPath });
          await loadTree(true);
          await reloadActiveIfChanged();
          setSyncStatus("synced", res);
        } catch (e) {
          console.error(e);
          setSyncStatus("error");
        }
      }
    } catch (e) {
      showError(String(e));
    } finally {
      btnGDriveConnect.disabled = false;
      await updateGDriveStatus();
    }
  }
});

if (btnGDriveSync) btnGDriveSync.addEventListener("click", async () => {
  if (!rootPath) {
    showError("Choose a notes folder first.");
    return;
  }
  btnGDriveSync.disabled = true;
  setSyncStatus("syncing");
  try {
    const res = await invoke("gdrive_sync", { rootPath });
    console.log("Sync completed:", res);
    await loadTree(true);
    setSyncStatus("synced", res);
  } catch (e) {
    showError(String(e));
    setSyncStatus("error");
  } finally {
    btnGDriveSync.disabled = false;
  }
});

if (btnGDriveReset) btnGDriveReset.addEventListener("click", async () => {
  if (!rootPath) {
    showError("Choose a notes folder first.");
    return;
  }
  btnGDriveReset.disabled = true;
  try {
    const res = await invoke("gdrive_reset_sync", { rootPath });
    showError(res);
    await loadTree(true);
  } catch (e) {
    showError(String(e));
  } finally {
    btnGDriveReset.disabled = false;
  }
});

// ============================================================
// Init
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  await loadIcons();
  updateLocalDirPath();

  // --- Custom titlebar controls ---
  const appWindow = getCurrentWindow();
  
  // Drag entire window by clicking titlebar (not on buttons)
  document.getElementById("titlebar")?.addEventListener("mousedown", (e) => {
    if (e.target === e.currentTarget || e.target.id === "titlebar") {
      appWindow.startDragging();
    }
  });
  document.getElementById("titlebar")?.addEventListener("dblclick", () => appWindow.toggleMaximize());
  
  // Window control buttons
  document.getElementById("btn-min")?.addEventListener("click", () => appWindow.minimize());
  document.getElementById("btn-max")?.addEventListener("click", () => appWindow.toggleMaximize());
  document.getElementById("btn-close")?.addEventListener("click", async () => {
    if (isDirty) await saveNote();
    appWindow.destroy();
  });

  sidebarToggle.innerHTML = iconHTML("panel-left");
  btnSettings.innerHTML = iconHTML("settings");
  btnNewNote.innerHTML = iconHTML("plus");
  btnNewFolder.innerHTML = iconHTML("folder-plus");
  btnSearch.innerHTML = iconHTML("search");
  searchIconPlaceholder.innerHTML = iconHTML("search");

  initSidebar();
  initSettingsBtn();

  if (!rootPath) {
    await pickDirectory();
  } else {
    await loadTree();
  }

  // Auto-sync in background after UI is ready
  (async () => {
    try {
      const status = await invoke("gdrive_status");
      if (status === "connected" && rootPath && localStorage.getItem("auto-sync-enabled") !== "0") {
        setSyncStatus("syncing");
        const res = await invoke("gdrive_sync", { rootPath });
        await loadTree(true);
        await reloadActiveIfChanged();
        setSyncStatus("synced", res);
        console.log(`Initial sync: ${res}`);
      } else if (status === "disconnected") {
        // Don't nag on startup; just stay quiet.
      }
    } catch (e) {
      console.log("No GDrive connection or sync failed", e);
      setSyncStatus("error");
    }
  })();

  getCurrentWindow().onCloseRequested(async () => {
    if (isDirty) await saveNote();
  });

  setInterval(() => {
    if (searchModal.classList.contains("hidden") && rootPath && settingsModal.classList.contains("hidden") && !dragState.active) {
      if (fileTreeEl.querySelector(".tree-input")) return;
      loadTree(true);
    }
  }, 5000);

  // Background sync every 5 minutes to pull remote changes
  setInterval(async () => {
    if (!rootPath) return;
    if (localStorage.getItem("auto-sync-enabled") === "0") return;
    try {
      const status = await invoke("gdrive_status");
      if (status === "connected") {
        queueAutoSync(true);
      }
    } catch (e) {
      // Silent fail
    }
  }, 300000);
  window.addEventListener("focus", () => {
    if (searchModal.classList.contains("hidden") && rootPath && settingsModal.classList.contains("hidden") && !dragState.active) {
      if (fileTreeEl.querySelector(".tree-input")) return;
      loadTree(true);
    }
    // Auto-sync on window focus
    if (rootPath && localStorage.getItem("auto-sync-enabled") !== "0") {
      invoke("gdrive_status").then((status) => {
        if (status === "connected") {
          queueAutoSync(true);
        }
      }).catch(() => {});
    }
  });

  // Ctrl+S handled by the global keydown listener below (single handler —
  // previously registered twice, causing double syncs).
});

// ============================================================
// Directory picker
// ============================================================

async function pickDirectory() {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select notes directory",
    });
    if (selected) {
      rootPath = selected;
      localStorage.setItem("aanote-root", rootPath);
      await loadTree();
      updateLocalDirPath();
    } else {
      fileTreeEl.innerHTML =
        '<div class="tree-empty">// select a directory to begin</div>';
    }
  } catch (e) {
    showError(String(e));
  }
}

// ============================================================
// Tree model helpers
// ============================================================

function stripPrefix(name) {
  return name.replace(PREFIX_RE, "");
}

function displayName(node) {
  const base = stripPrefix(node.name);
  return node.is_dir ? base : base.replace(/\.md$/, "");
}

function findNodeAndSiblings(nodes, path, parent = null) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].path === path) {
      return { node: nodes[i], siblings: nodes, index: i, parent };
    }
    if (nodes[i].is_dir) {
      const r = findNodeAndSiblings(nodes[i].children, path, nodes[i]);
      if (r) return r;
    }
  }
  return null;
}

function parentDirOf(path) {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

// ============================================================
// File tree rendering
// ============================================================

async function loadTree(silent = false) {
  if (isRefreshing) return;
  isRefreshing = true;
  try {
    const newTree = await invoke("scan_directory", { path: rootPath });
    // P1: build a cheap signature of the tree structure; if it's unchanged
    // since the last render, skip the DOM wipe entirely. This avoids the
    // ~5000 listener churn every 5s on large vaults.
    const sig = treeSignature(newTree);
    const structChanged = sig !== prevTreeSignature;
    fileTree = newTree;
    if (structChanged) {
      prevTreeSignature = sig;
      renderTree();
    } else {
      // Structure unchanged: just refresh dynamic row state (pin markers, etc.)
      refreshRowState();
    }
    updateSelection(activeNotePath);
  } catch (e) {
    if (!silent) showError(String(e));
  } finally {
    isRefreshing = false;
  }
}

// Stable string signature of the tree's shape + names. Equal signatures mean
// the rendered tree would be identical, so we can skip the rebuild.
function treeSignature(nodes) {
  let out = "";
  const walk = (list) => {
    for (const n of list) {
      out += n.path + "|" + (n.is_dir ? "d" : "f") + "\n";
      if (n.is_dir && n.children.length) walk(n.children);
    }
  };
  walk(nodes || []);
  return out;
}

// Lightweight refresh of per-row state without rebuilding the DOM: updates pin
// markers and selection. Called when the tree structure is unchanged.
function refreshRowState() {
  for (const row of flatItems) {
    const isPinned = pinned.has(row.dataset.path);
    row.classList.toggle("is-pinned", isPinned);
  }
}

// ============================================================
// Recent / pinned (Feature 4)
// ============================================================

function persistPinned() {
  localStorage.setItem(PINNED_KEY, JSON.stringify([...pinned]));
}

function pushRecent(path) {
  if (!path) return;
  recent = [path, ...recent.filter((p) => p !== path)].slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
}

function togglePinned(path) {
  if (pinned.has(path)) pinned.delete(path);
  else pinned.add(path);
  persistPinned();
  refreshRowState();
  renderPinnedSection();
}

// Render a "Pinned" quick-access section at the top of the sidebar (above the
// tree). Pinned paths that no longer exist are pruned.
function ensureSpecialSections() {
  let pinnedEl = document.getElementById("pinned-section");
  let recentEl = document.getElementById("recent-section");
  if (!pinnedEl) {
    pinnedEl = document.createElement("div");
    pinnedEl.id = "pinned-section";
    pinnedEl.className = "special-section";
    fileTreeEl.before(pinnedEl);
  }
  if (!recentEl) {
    recentEl = document.getElementById("recent-section-wrapper");
  }
  return { pinnedEl };
}

function renderPinnedSection() {
  let pinnedEl = document.getElementById("pinned-section");
  // Only show pinned section if there are pinned notes.
  const valid = [...pinned].filter((p) => nodeExists(p));
  if (valid.length === 0) {
    if (pinnedEl) pinnedEl.remove();
    // prune stale pins
    if (pinned.size !== valid.length) {
      pinned = new Set(valid);
      persistPinned();
    }
    return;
  }
  if (!pinnedEl) {
    pinnedEl = document.createElement("div");
    pinnedEl.id = "pinned-section";
    pinnedEl.className = "special-section";
    fileTreeEl.before(pinnedEl);
  }
  pinnedEl.innerHTML = "";
  const header = document.createElement("div");
  header.className = "section-header";
  header.innerHTML = iconHTML("eye");
  header.appendChild(document.createTextNode("Pinned"));
  pinnedEl.appendChild(header);

  for (const path of valid) {
    const row = document.createElement("div");
    row.className = "tree-row pinned-row";
    row.dataset.path = path;
    row.dataset.isDir = "false";
    const ic = document.createElement("span");
    ic.className = "tree-icon";
    ic.innerHTML = iconHTML("file-text");
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = stripPrefix(path.split("/").pop()).replace(/\.md$/, "");
    row.appendChild(ic);
    row.appendChild(label);
    row.addEventListener("click", () => {
      if (dragState.wasDragging) return;
      openNote(path);
    });
    pinnedEl.appendChild(row);
  }
  // Prune stale pins if any.
  if (pinned.size !== valid.length) {
    pinned = new Set(valid);
    persistPinned();
  }
}

function renderRecentSection() {
  let recentEl = document.getElementById("recent-section");
  const valid = recent.filter((p) => nodeExists(p));
  if (valid.length === 0) {
    if (recentEl) recentEl.remove();
    return;
  }
  if (!recentEl) {
    recentEl = document.createElement("div");
    recentEl.id = "recent-section";
    recentEl.className = "special-section";
    fileTreeEl.before(recentEl);
  }
  recentEl.innerHTML = "";
  const header = document.createElement("div");
  header.className = "section-header";
  header.appendChild(document.createTextNode("Recent"));
  recentEl.appendChild(header);
  for (const path of valid.slice(0, 5)) {
    const row = document.createElement("div");
    row.className = "tree-row recent-row";
    row.dataset.path = path;
    row.dataset.isDir = "false";
    const ic = document.createElement("span");
    ic.className = "tree-icon";
    ic.innerHTML = iconHTML("file-text");
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = stripPrefix(path.split("/").pop()).replace(/\.md$/, "");
    row.appendChild(ic);
    row.appendChild(label);
    row.addEventListener("click", () => openNote(path));
    recentEl.appendChild(row);
  }
}

// Does a given relative path exist in the current tree?
function nodeExists(path) {
  return findNodeAndSiblings(fileTree, path) !== null;
}

function persistCollapsed() {
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
}

function renderTree() {
  flatItems = [];
  fileTreeEl.innerHTML = "";
  if (fileTree.length === 0) {
    fileTreeEl.innerHTML =
      '<div class="tree-empty">// empty — press + to create a note</div>';
    return;
  }
  renderNodes(fileTree, fileTreeEl, 0, "");
  // Feature 4: refresh special sections after a full rebuild.
  renderPinnedSection();
  renderRecentSection();
}

function renderNodes(nodes, container, depth, guideStr) {
  nodes.forEach((node, i) => {
    const isLast = i === nodes.length - 1;
    const isCollapsed = collapsed.has(node.path);

    const row = document.createElement("div");
    row.className = "tree-row";
    row.dataset.path = node.path;
    row.dataset.isDir = String(node.is_dir);
    row.setAttribute("draggable", "true");

    // Guides (indent lines)
    const fullGuide = guideStr + (isLast ? "└─" : "├─");
    if (depth > 0) {
      const guides = document.createElement("span");
      guides.className = "tree-guides";
      guides.textContent = fullGuide;
      row.appendChild(guides);
    }

    // Icon
    const ic = document.createElement("span");
    ic.className = "tree-icon";
    ic.innerHTML = node.is_dir
      ? iconHTML(isCollapsed ? "folder" : "folder-open")
      : iconHTML("file-text");
    row.appendChild(ic);

    // Label
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = displayName(node);
    row.appendChild(label);

    // Click / dblclick
    row.addEventListener("click", () => {
      if (dragState.wasDragging) return;
      if (node.is_dir) toggleFolder(node);
      else openNote(node.path);
    });
    row.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startRename(row, node);
    });
    row.addEventListener("contextmenu", (e) => {
      if (isMobile()) return;
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, row, node);
    });

    // ---- HTML5 Drag API (mouse) ----
    row.addEventListener("dragstart", (e) => {
      window.getSelection()?.removeAllRanges();
      if (dragState.holdTimer) clearTimeout(dragState.holdTimer);
      dragState.active = true;
      dragState.wasDragging = true;
      dragState.srcPath = node.path;
      dragState.srcIsDir = node.is_dir;
      row.classList.add("drag-source");
      e.dataTransfer.setData("text/plain", node.path);
      e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      updateDropTarget(e.clientX, e.clientY);
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      endDrag();
    });
    row.addEventListener("dragend", () => {
      cleanupDrag();
    });

    // ---- Pointer Events (touch + long-press mouse) ----
    row.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      dragState.startX = e.clientX;
      dragState.startY = e.clientY;
      dragState.srcPath = node.path;
      dragState.srcIsDir = node.is_dir;
      
      dragState.holdTimer = setTimeout(() => {
        row.setPointerCapture(e.pointerId);
        beginDrag(e);
      }, DRAG_HOLD_MS);
      
      dragState.deleteTimer = setTimeout(() => {
        if (!dragState.active) {
          clearTimeout(dragState.holdTimer);
          requestDelete(row);
        }
      }, DELETE_HOLD_MS);
    });
    row.addEventListener("pointermove", (e) => {
      // Cancel delete timer if moved
      if (
        Math.abs(e.clientX - dragState.startX) > 8 ||
        Math.abs(e.clientY - dragState.startY) > 8
      ) {
        clearTimeout(dragState.deleteTimer);
        dragState.deleteTimer = null;
      }
      if (!dragState.active) {
        if (
          dragState.holdTimer &&
          (Math.abs(e.clientX - dragState.startX) > 8 ||
            Math.abs(e.clientY - dragState.startY) > 8)
        ) {
          clearTimeout(dragState.holdTimer);
          dragState.holdTimer = null;
        }
        return;
      }
      e.preventDefault();
      moveGhost(e.clientX, e.clientY);
      updateDropTarget(e.clientX, e.clientY);
      handleAutoScroll(e.clientY);
    });
    row.addEventListener("pointerup", (e) => {
      clearTimeout(dragState.deleteTimer);
      dragState.deleteTimer = null;
      if (dragState.holdTimer) {
        clearTimeout(dragState.holdTimer);
        dragState.holdTimer = null;
      }
      if (dragState.active) {
        e.preventDefault();
        endDrag();
      }
    });
    row.addEventListener("pointercancel", () => {
      clearTimeout(dragState.deleteTimer);
      dragState.deleteTimer = null;
      cancelDrag();
    });

    // Feature 4: mark pinned notes with a class for the pin glyph.
    if (!node.is_dir && pinned.has(node.path)) {
      row.classList.add("is-pinned");
    }

    container.appendChild(row);
    flatItems.push(row);

    if (node.is_dir && node.children.length > 0 && !isCollapsed) {
      const childGuides = guideStr + (isLast ? "  " : "│ ");
      renderNodes(node.children, container, depth + 1, childGuides);
    }
  });
}

// Also handle dragover/drop on the tree container itself (for "drop to root")
fileTreeEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  // Only highlight root if not over a row
  const row = e.target.closest(".tree-row");
  if (!row) {
    clearDropIndicators();
    dragState.currentTarget = { row: null, mode: "root" };
  }
});
fileTreeEl.addEventListener("drop", (e) => {
  e.preventDefault();
  if (!e.target.closest(".tree-row")) {
    endDrag();
  }
});

function toggleFolder(node) {
  if (collapsed.has(node.path)) collapsed.delete(node.path);
  else collapsed.add(node.path);
  persistCollapsed();
  renderTree();
  updateSelection(activeNotePath);
}

// ============================================================
// Drag & Drop state + helpers
// ============================================================

const dragState = {
  active: false,
  wasDragging: false,
  srcPath: null,
  srcIsDir: false,
  ghost: null,
  holdTimer: null,
  startX: 0,
  startY: 0,
  currentTarget: null,
  autoScrollTimer: null,
};

function beginDrag(e) {
  window.getSelection()?.removeAllRanges();
  dragState.active = true;
  dragState.wasDragging = true;
  const src = flatItems.find((r) => r.dataset.path === dragState.srcPath);
  if (src) src.classList.add("drag-source");
  const ghost = document.createElement("div");
  ghost.id = "drag-ghost";
  ghost.textContent = src ? src.querySelector(".tree-label").textContent : "?";
  document.body.appendChild(ghost);
  dragState.ghost = ghost;
  moveGhost(e.clientX, e.clientY);
  fileNav.style.touchAction = "none";
}

function moveGhost(x, y) {
  if (!dragState.ghost) return;
  dragState.ghost.style.left = `${x + 12}px`;
  dragState.ghost.style.top = `${y + 8}px`;
}

function updateDropTarget(x, y) {
  clearDropIndicators();
  dragState.currentTarget = null;

  const el = document.elementFromPoint(x, y);
  if (!el) return;
  const row = el.closest(".tree-row");
  if (!row) {
    if (el.closest("#file-tree")) {
      dragState.currentTarget = { row: null, mode: "root" };
    }
    return;
  }
  if (row.dataset.path === dragState.srcPath) return;

  const isDir = row.dataset.isDir === "true";
  const rect = row.getBoundingClientRect();
  const relY = rect.height > 0 ? (y - rect.top) / rect.height : 0;

  let mode;
  if (isDir) {
    if (relY < 0.25) mode = "before";
    else if (relY > 0.75) mode = "after";
    else mode = "into";
  } else {
    mode = relY < 0.5 ? "before" : "after";
  }

  // Block dropping folder into itself/descendant
  if (dragState.srcIsDir) {
    if (row.dataset.path === dragState.srcPath || row.dataset.path.startsWith(dragState.srcPath + "/")) {
      return;
    }
  }

  row.classList.add(mode === "into" ? "drop-into" : `drop-${mode}`);
  dragState.currentTarget = { row, mode };
}

function clearDropIndicators() {
  fileTreeEl
    .querySelectorAll(".drop-into,.drop-before,.drop-after")
    .forEach((el) => {
      el.classList.remove("drop-into", "drop-before", "drop-after");
    });
}

function handleAutoScroll(y) {
  const rect = fileTreeEl.getBoundingClientRect();
  const margin = 40;
  clearInterval(dragState.autoScrollTimer);
  dragState.autoScrollTimer = null;
  if (y < rect.top + margin) {
    dragState.autoScrollTimer = setInterval(
      () => (fileTreeEl.scrollTop -= 12),
      30
    );
  } else if (y > rect.bottom - margin) {
    dragState.autoScrollTimer = setInterval(
      () => (fileTreeEl.scrollTop += 12),
      30
    );
  }
}

async function endDrag() {
  clearInterval(dragState.autoScrollTimer);
  dragState.autoScrollTimer = null;
  const target = dragState.currentTarget;
  const srcPath = dragState.srcPath;
  const srcIsDir = dragState.srcIsDir;
  cleanupDrag();

  if (!target) return;

  const srcName = srcPath.split("/").pop();
  const srcDir = parentDirOf(srcPath);

  try {
    if (target.mode === "root") {
      if (srcDir === "") return;
      await invoke("move_node", {
        oldPath: `${rootPath}/${srcPath}`,
        newPath: `${rootPath}/${srcName}`,
      });
      if (activeNotePath === srcPath) activeNotePath = srcName;
      else if (activeNotePath?.startsWith(srcPath + "/")) {
        activeNotePath = srcName + activeNotePath.slice(srcPath.length);
      }
    } else if (target.mode === "into") {
      const destDir = target.row.dataset.path;
      const destPath = `${destDir}/${srcName}`;
      if (destPath === srcPath) return;
      await invoke("move_node", {
        oldPath: `${rootPath}/${srcPath}`,
        newPath: `${rootPath}/${destPath}`,
      });
      if (activeNotePath === srcPath) activeNotePath = destPath;
      else if (activeNotePath?.startsWith(srcPath + "/")) {
        activeNotePath = destPath + activeNotePath.slice(srcPath.length);
      }
    } else {
      await reorderWithPrefixes(srcPath, srcIsDir, target);
    }
    await loadTree();
  } catch (err) {
    showError(String(err));
  }
}

async function reorderWithPrefixes(srcPath, srcIsDir, target) {
  const targetPath = target.row.dataset.path;
  const targetDir = parentDirOf(targetPath);
  const srcDir = parentDirOf(srcPath);
  const srcName = srcPath.split("/").pop();

  const ctx = findNodeAndSiblings(fileTree, targetPath);
  if (!ctx) return;
  const siblings = ctx.siblings;
  const names = siblings.map((n) => n.name);
  const targetIdx = siblings.findIndex((n) => n.path === targetPath);

  // Build new order: remove src if same dir, then insert at position
  let newNames = names.filter((n) => n !== srcName);
  let insertIdx = newNames.indexOf(names[targetIdx]);
  if (insertIdx === -1) insertIdx = newNames.length;
  if (target.mode === "after") insertIdx += 1;
  newNames.splice(insertIdx, 0, srcName);

  // Compute renames with numeric prefixes
  const renames = [];
  for (let i = 0; i < newNames.length; i++) {
    const base = stripPrefix(newNames[i]);
    const desired = `${String(i + 1).padStart(2, "0")}-${base}`;
    if (newNames[i] !== desired) {
      const oldRel = targetDir ? `${targetDir}/${newNames[i]}` : newNames[i];
      const newRel = targetDir ? `${targetDir}/${desired}` : desired;
      renames.push({ oldRel, newRel });
    }
  }

  // Move src into target dir first if cross-folder
  if (srcDir !== targetDir) {
    const srcNewRel = targetDir ? `${targetDir}/${srcName}` : srcName;
    await invoke("move_node", {
      oldPath: `${rootPath}/${srcPath}`,
      newPath: `${rootPath}/${srcNewRel}`,
    });
    if (activeNotePath === srcPath) activeNotePath = srcNewRel;
    else if (activeNotePath?.startsWith(srcPath + "/")) {
      activeNotePath = srcNewRel + activeNotePath.slice(srcPath.length);
    }
  }

  // Two-phase rename to avoid collisions
  const tempMap = [];
  for (const r of renames) {
    const tmp = r.oldRel + ".reordering";
    await invoke("move_node", {
      oldPath: `${rootPath}/${r.oldRel}`,
      newPath: `${rootPath}/${tmp}`,
    });
    tempMap.push({ tmp, final: r.newRel });
  }
  for (const t of tempMap) {
    await invoke("move_node", {
      oldPath: `${rootPath}/${t.tmp}`,
      newPath: `${rootPath}/${t.final}`,
    });
    if (
      activeNotePath === t.tmp ||
      activeNotePath === t.tmp.replace(/\.reordering$/, "")
    ) {
      activeNotePath = t.final;
    } else if (activeNotePath?.startsWith(t.tmp + "/") || activeNotePath?.startsWith(t.tmp.replace(/\.reordering$/, "") + "/")) {
      const orig = t.tmp.replace(/\.reordering$/, "");
      activeNotePath = t.final + activeNotePath.slice(orig.length);
    }
  }
}

function cancelDrag() {
  clearInterval(dragState.autoScrollTimer);
  dragState.autoScrollTimer = null;
  cleanupDrag();
}

function cleanupDrag() {
  if (dragState.holdTimer) {
    clearTimeout(dragState.holdTimer);
    dragState.holdTimer = null;
  }
  if (dragState.ghost) {
    dragState.ghost.remove();
    dragState.ghost = null;
  }
  const src = flatItems.find((r) => r.dataset.path === dragState.srcPath);
  if (src) src.classList.remove("drag-source");
  clearDropIndicators();
  dragState.active = false;
  dragState.srcPath = null;
  dragState.srcIsDir = false;
  dragState.currentTarget = null;
  setTimeout(() => (dragState.wasDragging = false), 100);
}

// ============================================================
// Rename (F4 / double-click)
// ============================================================

function startRename(row, node) {
  const input = document.createElement("input");
  input.className = "tree-input";
  input.value = displayName(node);
  row.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const newName = input.value.trim();
      if (newName && newName !== displayName(node)) {
        const dir = parentDirOf(node.path);
        const prefix = (node.name.match(PREFIX_RE) || [""])[0];
        const finalName = node.is_dir
          ? `${prefix}${newName}`
          : `${prefix}${newName}.md`;
        const newPath = dir ? `${dir}/${finalName}` : finalName;
        if (newPath !== node.path) {
          try {
            await invoke("move_node", {
              oldPath: `${rootPath}/${node.path}`,
              newPath: `${rootPath}/${newPath}`,
            });
            if (activeNotePath === node.path) activeNotePath = newPath;
          } catch (err) {
            showError(String(err));
          }
        }
      }
    }
    await loadTree();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(false));
}

// ============================================================
// Delete (Delete ×2 or Long-press + Status bar Tap)
// ============================================================

// ============================================================
// Delete (Instant)
// ============================================================

async function commitDelete(path, isDir) {
  try {
    // Feature 2: soft-delete into .aanote-trash/ and offer an undo. Falls back
    // to permanent delete only if trashing fails (e.g. path outside root).
    let trashPath = null;
    try {
      trashPath = await invoke("trash_node", {
        rootPath,
        path: `${rootPath}/${path}`,
      });
    } catch (trashErr) {
      // Fallback: hard delete (matches old behavior).
      await invoke("delete_node", { path: `${rootPath}/${path}` });
    }
    if (activeNotePath === path || activeNotePath?.startsWith(path + "/")) {
      activeNotePath = null;
      activeNoteMtime = null;
      titleInput.value = "";
      setEditorContent("");
      editorPlaceholder.classList.remove("hidden");
      editorContainer.classList.add("hidden");
    }
    await loadTree();
    // Offer undo if we soft-deleted.
    if (trashPath) {
      lastDeleted = { trashPath, path };
      showUndoToast(`Deleted ${path.split("/").pop()}`, async () => {
        try {
          await invoke("restore_from_trash", { rootPath, trashPath });
          await loadTree();
          showBanner("Restored", "info");
        } catch (e) {
          showError(String(e));
        }
      });
    }
  } catch (err) {
    showError(String(err));
  }
}

async function requestDelete(item) {
  const path = item.dataset.path;
  const isDir = item.dataset.isDir === "true";
  await commitDelete(path, isDir);
}

// ============================================================
// Editor ops
// ============================================================

async function openNote(path, focusTitle = false) {
  if (isDirty && activeNotePath) await saveNote();
  try {
    const abs = `${rootPath}/${path}`;
    const content = await invoke("read_note", { path: abs });
    activeNotePath = path;
    // C3: record the on-disk mtime so we can detect if a sync overwrites the
    // file before the editor next saves.
    try {
      activeNoteMtime = await invoke("file_mtime", { path: abs });
    } catch {
      activeNoteMtime = null;
    }
    editorPlaceholder.classList.add("hidden");
    editorContainer.classList.remove("hidden");

    // Set title field (strip numeric prefix + .md extension)
    const rawName = path.split("/").pop();
    titleInput.value = rawName.replace(PREFIX_RE, "").replace(/\.md$/, "");

    setEditorContent(content);
    isDirty = false;
    updateSelection(path);
    pushRecent(path);
    renderRecentSection();
    if (isMobile()) applySidebar(false);

    if (focusTitle) {
      titleInput.focus();
      titleInput.select();
    } else {
      view.focus();
    }
  } catch (e) {
    showError(String(e));
  }
}

titleInput.addEventListener("change", async () => {
  if (!activeNotePath) return;
  const newName = titleInput.value.trim();
  const dir = parentDirOf(activeNotePath);
  const oldName = activeNotePath.split("/").pop();
  const prefix = (oldName.match(PREFIX_RE) || [""])[0];
  const finalName = newName ? `${prefix}${newName}.md` : oldName;
  const newPath = dir ? `${dir}/${finalName}` : finalName;
  
  if (newPath !== activeNotePath) {
    try {
      await invoke("move_node", {
        oldPath: `${rootPath}/${activeNotePath}`,
        newPath: `${rootPath}/${newPath}`,
      });
      activeNotePath = newPath;
      await loadTree(true);
      updateSelection(newPath);
    } catch (err) {
      showError(String(err));
      // Revert field
      titleInput.value = oldName.replace(PREFIX_RE, "").replace(/\.md$/, "");
    }
  }
});

let syncDebounceTimer = null;
async function queueAutoSync(forceNow = false) {
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  if (localStorage.getItem("auto-sync-enabled") === "0") return;

  const runSync = async () => {
    try {
      const status = await invoke("gdrive_status");
      if (status === "connected" && rootPath) {
        setSyncStatus("syncing");
        const res = await invoke("gdrive_sync", { rootPath });
        await loadTree(true);
        // C3: if the active note was overwritten by a remote download during
        // sync, reload it into the editor (unless the user has unsaved edits,
        // which the mtime-guarded saveNote will preserve as a conflict copy).
        await reloadActiveIfChanged();
        setSyncStatus("synced", res);
      } else if (status === "disconnected") {
        // A sync was queued but Drive is no longer connected.
        setSyncStatus("offline");
      }
    } catch (e) {
      console.error("Auto-sync failed:", e);
      setSyncStatus("error");
    }
  };

  if (forceNow) {
    await runSync();
  } else {
    syncDebounceTimer = setTimeout(runSync, 15000);
  }
}

async function saveNote(forceSync = false) {
  if (!activeNotePath) return;
  if (isDirty) {
    const abs = `${rootPath}/${activeNotePath}`;
    try {
      // C3/C6: save only if the file on disk still matches the mtime we last
      // loaded. If a background sync downloaded a newer version, the save is
      // refused; we reload the editor and surface a conflict notice instead
      // of clobbering the remote version.
      const saved = await invoke("save_note_if_unchanged", {
        path: abs,
        content: getEditorContent(),
        expectedMtimeMs: activeNoteMtime,
      });
      if (!saved) {
        // Disk changed under us — reload the remote version and keep the
        // user's edits as a conflict copy so nothing is lost.
        const localText = getEditorContent();
        await invoke("read_note", { path: abs }).then(async (remote) => {
          if (remote !== localText) {
            await saveLocalConflictCopy(abs, localText);
            showBanner("Note updated on disk; your edits saved as a conflict copy", "info");
          }
          setEditorContent(remote);
          activeNoteMtime = await invoke("file_mtime", { path: abs });
        });
        isDirty = false;
        return;
      }
      // Refresh mtime to the just-saved value so subsequent saves compare correctly.
      activeNoteMtime = await invoke("file_mtime", { path: abs });
      isDirty = false;
    } catch (e) {
      showError(String(e));
      return;
    }
  }
  queueAutoSync(forceSync);
}

// Write a local conflict copy via the backend's create_note (Feature 1, FE).
async function saveLocalConflictCopy(absPath, content) {
  try {
    const base = absPath.replace(/\.md$/, "");
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 15);
    const conflictPath = `${base} (local conflict ${ts}).md`;
    // create_note rejects existing names, so this unique name is safe.
    const created = await invoke("create_note", {
      dirPath: absPath.slice(0, absPath.lastIndexOf("/")) || rootPath,
      name: `${base.split("/").pop()} (local conflict ${ts})`,
    });
    if (created) {
      await invoke("save_note", { path: created, content });
    }
  } catch (e) {
    console.error("Failed to save local conflict copy", e);
  }
}

// C3: after a sync, check whether the active note's on-disk content changed
// (e.g. a remote download overwrote it). If so, and the editor has no unsaved
// edits, reload the content so the user isn't looking at a stale version.
async function reloadActiveIfChanged() {
  if (!activeNotePath) return;
  const abs = `${rootPath}/${activeNotePath}`;
  let currentMtime;
  try {
    currentMtime = await invoke("file_mtime", { path: abs });
  } catch {
    return;
  }
  if (activeNoteMtime !== null && currentMtime === activeNoteMtime) return; // unchanged
  // The file changed on disk.
  if (isDirty) {
    // User has unsaved edits — leave the editor as-is. The next save will
    // detect the divergence and create a conflict copy.
    return;
  }
  try {
    const content = await invoke("read_note", { path: abs });
    setEditorContent(content);
    activeNoteMtime = currentMtime;
  } catch {
    // File may have been removed by sync (remote delete). Close the editor.
    if (activeNotePath) {
      activeNotePath = null;
      activeNoteMtime = null;
      titleInput.value = "";
      setEditorContent("");
      editorPlaceholder.classList.remove("hidden");
      editorContainer.classList.add("hidden");
    }
  }
}

// ============================================================
// Inline create (context-aware)
// ============================================================

function getCreateTargetDir() {
  const sel = flatItems.find((el) => el.classList.contains("selected"));
  // Fall back to activeNotePath if no row selected
  if (!sel && activeNotePath) {
    const parent = parentDirOf(activeNotePath);
    return { dir: parent, label: parent ? stripPrefix(parent) + "/" : "~/" };
  }
  if (!sel) return { dir: "", label: "~/" };
  if (sel.dataset.isDir === "true") {
    return { dir: sel.dataset.path, label: stripPrefix(sel.dataset.path) + "/" };
  }
  const parent = parentDirOf(sel.dataset.path);
  return { dir: parent, label: parent ? stripPrefix(parent) + "/" : "~/" };
}

function showInlineInput(kind) {
  if (!rootPath) {
    showError("select a directory first (Ctrl+O)");
    return;
  }
  exitSearchMode();
  if (!sidebarOpen) applySidebar(true);

  const old = fileTreeEl.querySelector(".tree-input");
  if (old) old.remove();

  const { dir, label } = getCreateTargetDir();
  const input = document.createElement("input");
  input.className = "tree-input";
  input.placeholder =
    kind === "note" ? `${label} new-note.md` : `${label} new-folder/`;
  fileTreeEl.prepend(input);
  input.focus();

  input.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") {
      input.remove();
      fileNav.focus();
    }
    if (e.key === "Enter") {
      const name = input.value.trim();
      if (!name) {
        input.remove();
        fileNav.focus();
        return;
      }
      const targetAbs = dir ? `${rootPath}/${dir}` : rootPath;
      try {
        if (kind === "note") {
          const path = await invoke("create_note", {
            dirPath: targetAbs,
            name,
          });
          await loadTree();
          await openNote(path.replace(`${rootPath}/`, ""), true);
        } else {
          await invoke("create_folder", { dirPath: targetAbs, name });
          await loadTree();
        }
      } catch (err) {
        showError(String(err));
        input.remove();
      }
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.body.contains(input)) input.remove();
    }, 150);
  });
}

// ============================================================
// Context Menu (Desktop Right-Click)
// ============================================================

let contextTarget = null; // {row, node}

function showContextMenu(x, y, row, node) {
  contextTarget = { row, node };
  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
  contextMenu.classList.remove("hidden");
}

function hideContextMenu() {
  contextMenu.classList.add("hidden");
  contextTarget = null;
}

ctxRename.addEventListener("click", () => {
  if (contextTarget) {
    startRename(contextTarget.row, contextTarget.node);
  }
  hideContextMenu();
});

ctxDelete.addEventListener("click", () => {
  if (contextTarget) {
    requestDelete(contextTarget.row);
  }
  hideContextMenu();
});

if (ctxPin) {
  ctxPin.addEventListener("click", () => {
    if (contextTarget && !contextTarget.node.is_dir) {
      togglePinned(contextTarget.node.path);
    }
    hideContextMenu();
  });
}

document.addEventListener("click", (e) => {
  if (!contextMenu.contains(e.target)) {
    hideContextMenu();
  }
});

// ============================================================
// Search (Spotlight Modal)
// ============================================================

let searchDebounce;
let searchHits = [];
let searchSelectedIndex = -1;

function enterSearchMode() {
  if (!rootPath) {
    showError("select a directory first (Ctrl+O)");
    return;
  }
  searchModal.classList.remove("hidden");
  searchInput.value = "";
  searchResults.innerHTML = "";
  searchHits = [];
  searchSelectedIndex = -1;
  searchInput.focus();
}

async function runSearch(query) {
  if (!query) {
    searchResults.innerHTML = "";
    searchHits = [];
    searchSelectedIndex = -1;
    return;
  }
  try {
    // Feature 3: fetch hits with content snippets for richer results.
    const hits = await invoke("search_notes_snippet", { root: rootPath, query });
    searchResults.innerHTML = "";
    searchHits = hits.map((h) => h.path);
    searchSelectedIndex = hits.length > 0 ? 0 : -1;

    if (hits.length === 0) {
      searchResults.innerHTML = '<div class="search-empty">// no matches found</div>';
      return;
    }

    const qLower = query.toLowerCase();
    hits.forEach((hit, i) => {
      const path = hit.path;
      const div = document.createElement("div");
      div.className = "search-hit" + (i === 0 ? " focused" : "");

      const top = document.createElement("div");
      top.className = "search-hit-top";

      const icon = document.createElement("span");
      icon.className = "ic";
      icon.innerHTML = iconHTML("file-text");

      const name = document.createElement("span");
      name.className = "search-hit-name";
      name.textContent = stripPrefix(path).replace(/\.md$/, "");

      const dirStr = parentDirOf(path);
      const dirSpan = document.createElement("span");
      dirSpan.className = "search-hit-dir";
      dirSpan.textContent = dirStr ? stripPrefix(dirStr) + "/" : "~/";

      top.appendChild(icon);
      top.appendChild(name);
      top.appendChild(dirSpan);

      // Snippet line with the matched term highlighted (Feature 3).
      if (hit.snippet) {
        const snip = document.createElement("div");
        snip.className = "search-hit-snippet";
        snip.appendChild(buildHighlightedSnippet(hit.snippet, qLower));
        div.appendChild(top);
        div.appendChild(snip);
      } else {
        div.appendChild(top);
      }

      div.addEventListener("click", () => {
        exitSearchMode();
        openNote(path);
      });

      searchResults.appendChild(div);
    });
  } catch (e) {
    showError(String(e));
  }
}

// Build a snippet DOM node with the query term bolded.
function buildHighlightedSnippet(snippet, qLower) {
  const frag = document.createDocumentFragment();
  const lower = snippet.toLowerCase();
  let i = 0;
  while (i < snippet.length) {
    const idx = lower.indexOf(qLower, i);
    if (idx === -1) {
      frag.appendChild(document.createTextNode(sliceSafe(snippet, i)));
      break;
    }
    if (idx > i) frag.appendChild(document.createTextNode(sliceSafe(snippet, i, idx)));
    const mark = document.createElement("b");
    mark.className = "search-match";
    mark.textContent = sliceSafe(snippet, idx, idx + qLower.length);
    frag.appendChild(mark);
    i = idx + qLower.length;
  }
  return frag;
}

// Safe slice that respects surrogate pairs (keeps it simple: char-based).
function sliceSafe(s, from, to) {
  const arr = [...s];
  if (to === undefined) return arr.slice(from).join("");
  return arr.slice(from, to).join("");
}

function updateSearchSelection() {
  const children = searchResults.children;
  for (let i = 0; i < children.length; i++) {
    children[i].classList.toggle("focused", i === searchSelectedIndex);
    if (i === searchSelectedIndex) {
      children[i].scrollIntoView({ block: "nearest" });
    }
  }
}

searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(searchInput.value.trim()), 150);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    exitSearchMode();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (searchHits.length > 0) {
      searchSelectedIndex = (searchSelectedIndex + 1) % searchHits.length;
      updateSearchSelection();
    }
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (searchHits.length > 0) {
      searchSelectedIndex = (searchSelectedIndex - 1 + searchHits.length) % searchHits.length;
      updateSearchSelection();
    }
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (searchSelectedIndex >= 0 && searchHits[searchSelectedIndex]) {
      const path = searchHits[searchSelectedIndex];
      exitSearchMode();
      openNote(path);
    }
  }
});

searchModal.addEventListener("click", (e) => {
  if (e.target === searchModal) exitSearchMode();
});

function exitSearchMode() {
  searchModal.classList.add("hidden");
  if (activeNotePath) view.focus();
  else fileNav.focus();
}

// ============================================================
// Selection / error
// ============================================================

function updateSelection(path) {
  flatItems.forEach((el) => {
    el.classList.remove("selected");
    if (el.dataset.path === path) {
      el.classList.add("selected");
      el.scrollIntoView({ block: "nearest" });
    }
  });
  const idx = flatItems.findIndex((el) => el.dataset.path === path);
  if (idx >= 0) selectedIndex = idx;
}

function showBanner(msg, type = "info") {
  errorBanner.textContent = type === "error" ? `ERROR: ${msg}` : msg;
  errorBanner.className = ""; // clear all
  errorBanner.classList.add(type); // add .info, .error, .success
  errorBanner.classList.remove("hidden");
  clearTimeout(errorBanner._t);
  errorBanner._t = setTimeout(() => errorBanner.classList.add("hidden"), 3000);
}

function showError(msg) {
  showBanner(msg, "error");
}

// Show a toast with an "Undo" action (Feature 2). `onUndo` runs if clicked.
function showUndoToast(msg, onUndo) {
  errorBanner.innerHTML = "";
  errorBanner.className = "";
  errorBanner.classList.add("info");
  errorBanner.classList.remove("hidden");

  const label = document.createElement("span");
  label.textContent = msg;
  const undoBtn = document.createElement("button");
  undoBtn.className = "undo-btn";
  undoBtn.textContent = "Undo";
  undoBtn.addEventListener("click", () => {
    errorBanner.classList.add("hidden");
    if (onUndo) onUndo();
  });
  errorBanner.appendChild(label);
  errorBanner.appendChild(undoBtn);

  clearTimeout(errorBanner._t);
  errorBanner._t = setTimeout(() => {
    errorBanner.classList.add("hidden");
    errorBanner.innerHTML = "";
  }, 6000);
}

// Format a char count into a compact human string: 0, 850, 1.2k, 24k.
function formatChars(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

// Braille spinner — the original "really cool" sync loader. Cycled while syncing.
const spinnerChars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerInterval = null;

// Drive the sync-status chip. state ∈ "syncing" | "synced" | "offline" | "error" | null.
// `detail` is a {uploaded, downloaded, conflicts, charsSynced, summary} object for "synced".
function setSyncStatus(state, detail) {
  if (!syncStatus) return;
  if (syncStatusTimer) { clearTimeout(syncStatusTimer); syncStatusTimer = null; }
  // Stop any running braille animation.
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }

  // Clear state classes.
  syncStatus.classList.remove("syncing", "synced", "offline", "error");

  if (state === null) {
    syncStatus.classList.add("hidden");
    // Restore the action bar's icon row.
    if (actionBar) actionBar.classList.remove("syncing");
    return;
  }

  // While any sync status is visible, the bar swaps to show it (icons hidden).
  if (actionBar) actionBar.classList.add("syncing");

  // Icon: during syncing we cycle the braille spinner (restored by request);
  // the other states use a static SVG.
  if (state === "syncing") {
    if (syncStatusIcon) {
      let i = 0;
      syncStatusIcon.textContent = spinnerChars[0];
      spinnerInterval = setInterval(() => {
        i = (i + 1) % spinnerChars.length;
        syncStatusIcon.textContent = spinnerChars[i];
      }, 80);
    }
  } else {
    const iconMap = {
      synced: "check",
      offline: "wifi-off",
      error: "alert-triangle",
    };
    if (syncStatusIcon) syncStatusIcon.innerHTML = iconHTML(iconMap[state] || "check");
  }

  let text = "";
  if (state === "syncing") {
    text = "syncing…";
  } else if (state === "synced") {
    const notes = (detail?.uploaded || 0) + (detail?.downloaded || 0);
    const chars = detail?.charsSynced || 0;
    if (notes === 0 && !(detail?.conflicts)) {
      text = "up to date";
    } else {
      const parts = [];
      if (notes > 0) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
      if (detail?.conflicts > 0) parts.push(`${detail.conflicts} conflict${detail.conflicts === 1 ? "" : "s"}`);
      text = "synced " + parts.join(" · ");
      if (chars > 0) text += ` · ${formatChars(chars)} chars`;
    }
  } else if (state === "offline") {
    text = "offline";
  } else if (state === "error") {
    text = "sync failed";
  }
  if (syncStatusText) syncStatusText.textContent = text;

  syncStatus.classList.add(state);
  syncStatus.classList.remove("hidden");

  // Synced/offline/error are transient — after the fade, hide the status and
  // restore the bar's icon row. Syncing stays until the sync finishes.
  if (state !== "syncing") {
    syncStatusTimer = setTimeout(() => {
      syncStatus.classList.add("hidden");
      if (actionBar) actionBar.classList.remove("syncing");
    }, state === "synced" ? 2500 : 4000);
  }
}

// ============================================================
// Action bar
// ============================================================

btnNewNote.addEventListener("click", () => showInlineInput("note"));
btnNewFolder.addEventListener("click", () => showInlineInput("folder"));
btnSearch.addEventListener("click", () => {
  if (!searchModal.classList.contains("hidden")) exitSearchMode();
  else enterSearchMode();
});

// ============================================================
// Global keys
// ============================================================

document.addEventListener("keydown", (e) => {
  const inInput =
    document.activeElement &&
    (document.activeElement.tagName === "INPUT" ||
      document.activeElement.tagName === "TEXTAREA");
  if (inInput && e.key !== "Escape") return;

  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    saveNote(true); // force a sync after saving
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();
    if (!searchModal.classList.contains("hidden")) exitSearchMode();
    else enterSearchMode();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "o") {
    e.preventDefault();
    pickDirectory();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
    e.preventDefault();
    toggleSidebar();
    return;
  }
  if (e.key === "F2") {
    e.preventDefault();
    showInlineInput("note");
    return;
  }
  if (e.key === "F3") {
    e.preventDefault();
    showInlineInput("folder");
    return;
  }
  if (e.key === "F4") {
    e.preventDefault();
    const sel = flatItems.find((el) => el.classList.contains("selected"));
    if (sel) {
      const found = findNodeAndSiblings(fileTree, sel.dataset.path);
      if (found) startRename(sel, found.node);
    }
    return;
  }
  if (e.key === "F5") {
    e.preventDefault();
    if (searchModal.classList.contains("hidden")) loadTree();
    return;
  }
  if (e.key === "Escape") {
    if (!contextMenu.classList.contains("hidden")) {
      hideContextMenu();
      return;
    }
    if (!settingsModal.classList.contains("hidden")) {
      settingsModal.classList.add("hidden");
      return;
    }
    if (!searchModal.classList.contains("hidden")) exitSearchMode();
    return;
  }
  if (e.key === "Delete" && !cmHost.contains(document.activeElement)) {
    const sel = flatItems.find((el) => el.classList.contains("selected"));
    if (sel) {
      e.preventDefault();
      requestDelete(sel);
    }
    return;
  }

  if (e.key === "Tab" && !e.shiftKey && searchModal.classList.contains("hidden")) {
    const inCM = cmHost.contains(document.activeElement);
    e.preventDefault();
    if (inCM) fileNav.focus();
    else view.focus();
    return;
  }

  if (
    searchModal.classList.contains("hidden") &&
    (document.activeElement === fileNav ||
      document.activeElement === fileTreeEl)
  ) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      selectedIndex = Math.max(
        0,
        Math.min(flatItems.length - 1, selectedIndex + dir)
      );
      flatItems.forEach((el) => el.classList.remove("selected"));
      flatItems[selectedIndex]?.classList.add("selected");
      flatItems[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = flatItems[selectedIndex];
      if (item && item.dataset.isDir !== "true") openNote(item.dataset.path);
      else if (item) {
        const found = findNodeAndSiblings(fileTree, item.dataset.path);
        if (found) toggleFolder(found.node);
      }
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const item = flatItems[selectedIndex];
      if (item && item.dataset.isDir === "true") {
        const path = item.dataset.path;
        const isColl = collapsed.has(path);
        const found = findNodeAndSiblings(fileTree, path);
        if (!found) return;
        if (e.key === "ArrowRight" && isColl) toggleFolder(found.node);
        if (e.key === "ArrowLeft" && !isColl) toggleFolder(found.node);
      }
    }
  }
});
