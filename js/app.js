// ============================================================
// TUI Notes — Frontend (v4: icons, DnD, reorder, tree UI)
// ============================================================

import { createEditor } from "./cm.bundle.js";
import { loadIcons, iconHTML } from "./icons.js";

const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;
const { getCurrentWindow } = window.__TAURI__.window;

// ---------- Constants ----------
const MOBILE_BREAKPOINT = 720;
const COLLAPSE_KEY = "tui-notes-collapsed";
const SIDEBAR_KEY = "tui-notes-sidebar";
const DRAG_HOLD_MS = 250;
const DELETE_HOLD_MS = 800; // long-press to delete
const PREFIX_RE = /^\d{2,3}-/;

// ---------- State ----------
let activeNotePath = null;
let fileTree = [];
let isDirty = false;
let rootPath = localStorage.getItem("tui-notes-root") || null;
let selectedIndex = 0;
let flatItems = [];
// searchMode flag removed – spotlights use modal
let ignoreNextChange = false;
let sidebarOpen = null;
let collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]"));
let saveTimeout;

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

const searchModal = document.getElementById("search-modal");
const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");
const searchIconPlaceholder = document.getElementById("search-icon-placeholder");

const contextMenu = document.getElementById("context-menu");
const ctxRename = document.getElementById("ctx-rename");
const ctxDelete = document.getElementById("ctx-delete");

// ---------- Editor ----------
const view = createEditor(cmHost, () => {
  if (!ignoreNextChange) {
    isDirty = true;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveNote, 1000);
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

window.addEventListener("resize", () => {
  if (isMobile() && sidebarOpen && !backdrop.classList.contains("visible")) {
    applySidebar(false);
  } else if (!isMobile() && !sidebarOpen) {
    if (localStorage.getItem(SIDEBAR_KEY) !== "0") applySidebar(true);
  }
});

sidebarToggle.addEventListener("click", toggleSidebar);
backdrop.addEventListener("click", () => applySidebar(false));

function initSettingsBtn() {
  btnSettings.innerHTML = iconHTML("settings");
}

btnSettings.addEventListener("click", () => {
  if (settingsModal.classList.contains("hidden")) {
    settingsModal.classList.remove("hidden");
  } else {
    settingsModal.classList.add("hidden");
  }
});

settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) {
    settingsModal.classList.add("hidden");
  }
});

btnImportFolder.addEventListener("click", async () => {
  settingsModal.classList.add("hidden");
  await pickDirectory();
});

// ============================================================
// Init
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  await loadIcons();

  sidebarToggle.innerHTML = iconHTML("panel-left");
  btnNewNote.innerHTML = iconHTML("plus");
  btnNewFolder.innerHTML = iconHTML("folder-plus");
  btnSearch.innerHTML = iconHTML("search");
  searchIconPlaceholder.innerHTML = iconHTML("search");

  initSidebar();
  initSettingsBtn();

  if (!rootPath) await pickDirectory();
  else await loadTree();

  getCurrentWindow().onCloseRequested(async () => {
    if (isDirty) await saveNote();
  });

  setInterval(() => {
    if (searchModal.classList.contains("hidden") && rootPath && settingsModal.classList.contains("hidden")) {
      if (fileTreeEl.querySelector(".tree-input")) return;
      loadTree(true);
    }
  }, 5000);
  window.addEventListener("focus", () => {
    if (searchModal.classList.contains("hidden") && rootPath && settingsModal.classList.contains("hidden")) {
      if (fileTreeEl.querySelector(".tree-input")) return;
      loadTree(true);
    }
  });
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
      localStorage.setItem("tui-notes-root", rootPath);
      await loadTree();
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
  try {
    fileTree = await invoke("scan_directory", { path: rootPath });
    renderTree();
  } catch (e) {
    if (!silent) showError(String(e));
  }
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
    if (guideStr) {
      const guides = document.createElement("span");
      guides.className = "tree-guides";
      guides.textContent = guideStr;
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
  if (mode === "into" && dragState.srcIsDir) {
    if (row.dataset.path.startsWith(dragState.srcPath + "/")) return;
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
    } else if (target.mode === "into") {
      const destDir = target.row.dataset.path;
      const destPath = `${destDir}/${srcName}`;
      if (destPath === srcPath) return;
      await invoke("move_node", {
        oldPath: `${rootPath}/${srcPath}`,
        newPath: `${rootPath}/${destPath}`,
      });
      if (activeNotePath === srcPath) activeNotePath = destPath;
    } else {
      await reorderWithPrefixes(srcPath, srcIsDir, target);
    }
    await loadTree();
    updateStatus();
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
  fileTreeEl
    .querySelectorAll(".drag-source")
    .forEach((el) => el.classList.remove("drag-source"));
  clearDropIndicators();
  fileNav.style.touchAction = "";
  dragState.active = false;
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
    await invoke("delete_node", { path: `${rootPath}/${path}` });
    if (activeNotePath === path || activeNotePath?.startsWith(path + "/")) {
      activeNotePath = null;
      titleInput.value = "";
      setEditorContent("");
      editorPlaceholder.classList.remove("hidden");
      editorContainer.classList.add("hidden");
    }
    await loadTree();
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
    const content = await invoke("read_note", {
      path: `${rootPath}/${path}`,
    });
    activeNotePath = path;
    editorPlaceholder.classList.add("hidden");
    editorContainer.classList.remove("hidden");
    
    // Set title field (strip numeric prefix + .md extension)
    const rawName = path.split("/").pop();
    titleInput.value = rawName.replace(PREFIX_RE, "").replace(/\.md$/, "");
    
    setEditorContent(content);
    isDirty = false;
    updateSelection(path);
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

async function saveNote() {
  if (!activeNotePath || !isDirty) return;
  try {
    await invoke("save_note", {
      path: `${rootPath}/${activeNotePath}`,
      content: getEditorContent(),
    });
    isDirty = false;
  } catch (e) {
    showError(String(e));
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
    const matches = await invoke("search_notes", { root: rootPath, query });
    searchResults.innerHTML = "";
    searchHits = matches;
    searchSelectedIndex = matches.length > 0 ? 0 : -1;
    
    if (matches.length === 0) {
      searchResults.innerHTML = '<div class="search-empty">// no matches found</div>';
      return;
    }
    
    matches.forEach((path, i) => {
      const div = document.createElement("div");
      div.className = "search-hit" + (i === 0 ? " focused" : "");
      
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
      
      div.appendChild(icon);
      div.appendChild(name);
      div.appendChild(dirSpan);
      
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

function showError(msg) {
  errorBanner.textContent = `ERROR: ${msg}`;
  errorBanner.classList.remove("hidden");
  clearTimeout(errorBanner._t);
  errorBanner._t = setTimeout(() => errorBanner.classList.add("hidden"), 3000);
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
    saveNote();
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
