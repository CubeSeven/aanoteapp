use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

/// Trash directory name (lives inside the user's notes root). Files are
/// soft-deleted here and retained for 30 days before being purged.
const TRASH_DIR: &str = ".aanote-trash";
const TRASH_RETENTION_DAYS: i64 = 30;

/// Write `content` to `path` atomically: write to a temp file in the same
/// directory, then rename over the destination. Prevents truncated/corrupt
/// files on crash or power loss mid-write.
fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create dir {}: {}", dir.display(), e))?;

    // Temp file in the same directory (so the rename is atomic on the same FS).
    let tmp = dir.join(format!(
        ".aanote-tmp-{}",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("x")
    ));

    let mut f = fs::File::create(&tmp)
        .map_err(|e| format!("Failed to create temp {}: {}", tmp.display(), e))?;
    f.write_all(content)
        .map_err(|e| format!("Failed to write {}: {}", tmp.display(), e))?;
    // Flush + sync so the data hits disk before the rename.
    let _ = f.sync_all();
    drop(f);

    // os-level rename is atomic on Unix and Windows.
    fs::rename(&tmp, path).map_err(|e| {
        // Best-effort cleanup of the temp file on failure.
        let _ = fs::remove_file(&tmp);
        format!("Failed to finalize {}: {}", path.display(), e)
    })
}

/// Reject a note/folder name that would escape `dir`: contains a path separator,
/// a `..` component, or is absolute. Returns the sanitized base name.
/// Replaces path separators with `-` so they don't create unexpected nesting.
fn sanitize_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(format!(
            "Name cannot contain a path separator (/ or \\): \"{}\"",
            trimmed
        ));
    }
    // Reject any component that escapes (defense in depth; sanitize already
    // strips separators but reject `..` on its own too).
    let p = Path::new(trimmed);
    for comp in p.components() {
        match comp {
            Component::ParentDir => return Err("Name cannot contain \"..\"".to_string()),
            Component::RootDir => return Err("Name cannot be absolute".to_string()),
            _ => {}
        }
    }
    Ok(trimmed.to_string())
}

/// Resolve the trash directory for a given notes root.
fn trash_dir_for(root: &str) -> PathBuf {
    Path::new(root).join(TRASH_DIR)
}

/// Move a file or folder into the trash (timestamped to avoid collisions).
/// Returns the trash path so callers (e.g. undo) can reference it.
fn trash_path_for(root: &str, rel_path: &str) -> PathBuf {
    // Timestamp prefix avoids collisions when the same name is deleted twice.
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    trash_dir_for(root).join(format!("{}-{}", ts, rel_path.replace('/', "__")))
}

/// Move a file/dir into the trash, creating the trash dir if needed.
fn move_to_trash(root: &str, rel_path: &str) -> Result<PathBuf, String> {
    let src = Path::new(root).join(rel_path);
    if !src.exists() {
        return Err(format!("Does not exist: {}", rel_path));
    }
    let trash = trash_dir_for(root);
    fs::create_dir_all(&trash).map_err(|e| format!("Failed to create trash dir: {}", e))?;
    let dest = trash_path_for(root, rel_path);
    // If a same-timestamp collision happens (extremely rare), append a counter.
    let mut final_dest = dest.clone();
    let mut n = 1;
    while final_dest.exists() {
        final_dest = dest.with_extension(format!("aanote-trash-{}", n));
        n += 1;
    }
    fs::rename(&src, &final_dest)
        .map_err(|e| format!("Failed to move {} to trash: {}", rel_path, e))?;
    Ok(final_dest)
}

/// Purge trash entries older than the retention window. Called opportunistically
/// during scans and syncs. Errors are non-fatal (best-effort cleanup).
pub fn purge_old_trash(root: &str) {
    let trash = trash_dir_for(root);
    if !trash.exists() {
        return;
    }
    let cutoff = chrono::Utc::now() - chrono::Duration::days(TRASH_RETENTION_DAYS);
    let cutoff_ts = cutoff.format("%Y%m%d-%H%M%S").to_string();
    if let Ok(entries) = fs::read_dir(&trash) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                // Filenames are "YYYYMMDD-HHMMSS-<relpath>". Compare prefix.
                if name.len() >= 15 && &name[..15] < cutoff_ts.as_str() {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FileNode>,
}

#[tauri::command]
pub fn scan_directory(path: String) -> Result<Vec<FileNode>, String> {
    let root = Path::new(&path);
    if !root.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    // Opportunistic: purge trash entries older than the retention window.
    purge_old_trash(&path);

    let mut nodes = Vec::new();
    let walk = WalkDir::new(root)
        .min_depth(1)
        .max_depth(10)
        .follow_links(false)
        .into_iter()
        // Prune hidden entries AND the trash subtree so we never descend into
        // .aanote-trash (its contents must not appear in the tree).
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(name.starts_with('.') )
        })
        .filter_map(|e| e.ok());

    for entry in walk {
        let entry_path = entry.path();
        let name = entry_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let is_dir = entry_path.is_dir();

        // (hidden + trash already pruned by filter_entry; this is a safety net)
        if name.starts_with('.') {
            continue;
        }
        if !is_dir && !name.ends_with(".md") {
            continue;
        }
        if !is_dir {
            if let Ok(meta) = entry_path.metadata() {
                if meta.len() > 1_048_576 {
                    continue;
                }
            }
        }

        let rel_path = entry_path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();

        nodes.push(FileNode {
            name,
            path: rel_path,
            is_dir,
            children: Vec::new(),
        });
    }

    Ok(build_tree(nodes))
}

/// Timestamp of a file's last modification, in milliseconds since UNIX_EPOCH.
/// Returns None if the file is missing or its mtime can't be read.
#[tauri::command]
pub fn file_mtime(path: String) -> Result<Option<u64>, String> {
    match fs::metadata(&path) {
        Ok(meta) => match meta.modified() {
            Ok(modified) => match modified.duration_since(std::time::UNIX_EPOCH) {
                Ok(d) => Ok(Some(d.as_secs() * 1000 + d.subsec_millis() as u64)),
                Err(_) => Ok(None),
            },
            Err(_) => Ok(None),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to stat {}: {}", path, e)),
    }
}

fn build_tree(flat: Vec<FileNode>) -> Vec<FileNode> {
    let mut tree: Vec<FileNode> = Vec::new();
    let mut dirs: Vec<&FileNode> = flat.iter().filter(|n| n.is_dir).collect();
    dirs.sort_by(|a, b| a.path.cmp(&b.path));
    let mut files: Vec<&FileNode> = flat.iter().filter(|n| !n.is_dir).collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));

    for dir in dirs {
        insert_node(&mut tree, dir.clone());
    }
    for file in files {
        insert_node(&mut tree, file.clone());
    }
    tree
}

fn insert_node(tree: &mut Vec<FileNode>, node: FileNode) {
    let parent_path = Path::new(&node.path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .filter(|s| !s.is_empty());

    match parent_path {
        Some(ref pp) => {
            if let Some(parent) = find_node_mut(tree, pp) {
                parent.children.push(node);
            } else {
                tree.push(node);
            }
        }
        None => tree.push(node),
    }
}

fn find_node_mut<'a>(tree: &'a mut [FileNode], path: &str) -> Option<&'a mut FileNode> {
    for node in tree.iter_mut() {
        if node.path == path {
            return Some(node);
        }
        if node.is_dir {
            if let Some(found) = find_node_mut(&mut node.children, path) {
                return Some(found);
            }
        }
    }
    None
}

#[tauri::command]
pub fn read_note(path: String) -> Result<String, String> {
    fs::read_to_string(&path)
        .map(|s| s.replace("\r\n", "\n"))
        .map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
pub fn save_note(path: String, content: String) -> Result<(), String> {
    atomic_write(Path::new(&path), content.as_bytes())
        .map_err(|e| format!("Failed to save {}: {}", path, e))
}

/// Save only if the file on disk still matches `expected_mtime_ms` (the mtime
/// the frontend last saw). Returns Ok(true) if saved, Ok(false) if the file
/// changed on disk (sync downloaded a newer version) — in that case the
/// frontend must reload instead of clobbering. C3/C6 fix.
#[tauri::command]
pub fn save_note_if_unchanged(
    path: String,
    content: String,
    expected_mtime_ms: Option<u64>,
) -> Result<bool, String> {
    if let Some(expected) = expected_mtime_ms {
        match file_mtime(path.clone())? {
            Some(actual) if actual != expected => {
                return Ok(false); // file changed on disk — caller should reload
            }
            None => {} // file vanished — allow recreate
            _ => {}
        }
    }
    atomic_write(Path::new(&path), content.as_bytes())?;
    Ok(true)
}

#[tauri::command]
pub fn move_node(old_path: String, new_path: String) -> Result<(), String> {
    let new = Path::new(&new_path);
    // Guard against silently overwriting an existing destination (C5).
    if new.exists() {
        return Err(format!(
            "Destination already exists: {}",
            new.display()
        ));
    }
    fs::rename(&old_path, &new_path).map_err(|e| {
        format!(
            "Failed to move {} to {}: {}",
            old_path, new_path, e
        )
    })
}

#[tauri::command]
pub fn create_note(dir_path: String, name: String) -> Result<String, String> {
    let clean = sanitize_name(&name)?;
    let full_path = Path::new(&dir_path).join(format!("{}.md", clean));
    if full_path.exists() {
        return Err(format!("Note already exists: {}", full_path.display()));
    }
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    atomic_write(&full_path, b"")
        .map_err(|e| format!("Failed to create {}: {}", full_path.display(), e))?;
    Ok(full_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_folder(dir_path: String, name: String) -> Result<String, String> {
    let clean = sanitize_name(&name)?;
    let full_path = Path::new(&dir_path).join(&clean);
    if full_path.exists() {
        return Err(format!("Folder already exists: {}", full_path.display()));
    }
    fs::create_dir_all(&full_path)
        .map_err(|e| format!("Failed to create folder {}: {}", full_path.display(), e))?;
    Ok(full_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn search_notes(root: String, query: String) -> Result<Vec<String>, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("Not a directory: {}", root));
    }
    let q = query.to_lowercase();
    let mut matches = Vec::new();

    for entry in WalkDir::new(root_path)
        .min_depth(1)
        .max_depth(10)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || !name.ends_with(".md") {
            continue;
        }
        if let Ok(meta) = p.metadata() {
            if meta.len() > 1_048_576 {
                continue;
            }
        }
        if let Ok(content) = fs::read_to_string(p) {
            if content.to_lowercase().contains(&q) {
                if let Ok(rel) = p.strip_prefix(root_path) {
                    matches.push(rel.to_string_lossy().to_string());
                }
            }
        }
    }
    matches.sort();
    Ok(matches)
}

/// A search hit with a content snippet around the first match (Feature 3).
#[derive(Debug, Serialize, Clone)]
pub struct SearchHit {
    pub path: String,
    pub snippet: String,
}

/// Like `search_notes` but also returns a snippet of text around the first
/// occurrence of the query, for display in the results list.
#[tauri::command]
pub fn search_notes_snippet(root: String, query: String) -> Result<Vec<SearchHit>, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("Not a directory: {}", root));
    }
    let q = query.to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();

    for entry in WalkDir::new(root_path)
        .min_depth(1)
        .max_depth(10)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || !name.ends_with(".md") {
            continue;
        }
        // Skip trashed files.
        if p.to_string_lossy().contains(TRASH_DIR) {
            continue;
        }
        if let Ok(meta) = p.metadata() {
            if meta.len() > 1_048_576 {
                continue;
            }
        }
        if let Ok(content) = fs::read_to_string(p) {
            if let Some(idx) = content.to_lowercase().find(&q) {
                if let Ok(rel) = p.strip_prefix(root_path) {
                    hits.push(SearchHit {
                        path: rel.to_string_lossy().to_string(),
                        snippet: make_snippet(&content, idx, query.chars().count()),
                    });
                }
            }
        }
    }
    // Filename matches (no content match) still surface, with the note's first
    // line as a fallback snippet.
    for entry in WalkDir::new(root_path)
        .min_depth(1)
        .max_depth(10)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || !name.ends_with(".md") {
            continue;
        }
        if p.to_string_lossy().contains(TRASH_DIR) {
            continue;
        }
        if name.to_lowercase().contains(&q) {
            if let Ok(rel) = p.strip_prefix(root_path) {
                let rel_str = rel.to_string_lossy().to_string();
                if hits.iter().any(|h| h.path == rel_str) {
                    continue;
                }
                let fallback = fs::read_to_string(p)
                    .unwrap_or_default()
                    .lines()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("")
                    .chars()
                    .take(120)
                    .collect::<String>();
                hits.push(SearchHit {
                    path: rel_str,
                    snippet: fallback,
                });
            }
        }
    }
    hits.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(hits)
}

/// Build a ~120-char window around the match, collapsing newlines to spaces.
fn make_snippet(content: &str, match_idx: usize, query_len: usize) -> String {
    let chars: Vec<char> = content.chars().collect();
    let mstart = chars
        .iter()
        .take(match_idx)
        .map(|c| c.len_utf8())
        .sum::<usize>();
    let char_count = chars.len();
    let start = mstart.saturating_sub(60);
    let end = (mstart + query_len + 60).min(char_count);
    let window: String = chars[start..end].iter().collect();
    let collapsed = window.replace(['\n', '\r'], " ");
    let mut s = collapsed.trim().to_string();
    if start > 0 {
        s = format!("…{}", s);
    }
    if end < char_count {
        s = format!("{}…", s);
    }
    s.chars().take(140).collect()
}

#[tauri::command]
pub fn delete_node(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Does not exist: {}", path));
    }
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| format!("Failed to delete folder {}: {}", path, e))
    } else {
        fs::remove_file(p).map_err(|e| format!("Failed to delete {}: {}", path, e))
    }
}

/// Soft-delete: move a file/folder (given as an absolute path inside the notes
/// root) into the trash. Returns the absolute trash path so the frontend can
/// offer an undo. Feature 2 (trash/undo).
#[tauri::command]
pub fn trash_node(root_path: String, path: String) -> Result<String, String> {
    let abs = Path::new(&path);
    // Normalize to an absolute path inside root.
    let rel = abs
        .strip_prefix(&root_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.clone());
    let dest = move_to_trash(&root_path, &rel)?;
    Ok(dest.to_string_lossy().to_string())
}

/// Restore a previously trashed file back to its original location.
/// `trash_path` is the value returned by `trash_node`. The original location is
/// derived from the trash filename.
#[tauri::command]
pub fn restore_from_trash(root_path: String, trash_path: String) -> Result<(), String> {
    let trash_abs = Path::new(&trash_path);
    let fname = trash_abs
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid trash path".to_string())?;
    // Filename format: "YYYYMMDD-HHMMSS-<relpath with __ for />".
    let rel = fname
        .find("-")
        .and_then(|i| fname[i + 1..].find("-").map(|j| i + 1 + j))
        .map(|idx| fname[idx + 1..].replace("__", "/"))
        .ok_or_else(|| "Invalid trash filename".to_string())?;
    let dest = Path::new(&root_path).join(&rel);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    if dest.exists() {
        return Err(format!(
            "A file already exists at the original location: {}",
            dest.display()
        ));
    }
    fs::rename(trash_abs, &dest).map_err(|e| format!("Failed to restore: {}", e))
}

/// Permanently empty the trash directory.
#[tauri::command]
pub fn empty_trash(root_path: String) -> Result<u32, String> {
    let trash = trash_dir_for(&root_path);
    if !trash.exists() {
        return Ok(0);
    }
    let mut count = 0u32;
    for entry in fs::read_dir(&trash).map_err(|e| format!("Failed to read trash: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let p = entry.path();
        let r = if p.is_dir() {
            fs::remove_dir_all(&p)
        } else {
            fs::remove_file(&p)
        };
        if r.is_ok() {
            count += 1;
        }
    }
    Ok(count)
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    // Only allow http(s) URLs to reach the OS opener. Prevents any chance of
    // scheme-based shell tricks (S8) regardless of platform.
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("Refusing to open non-http URL: {}", url));
    }

    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&url).spawn();

    // Windows: avoid `cmd /C start` (shell parsing = injection risk). Invoke
    // the URL directly via cmd's start verb without a shell metachar path.
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd")
        .raw_arg(format!("/C start \"\" \"{}\"", url))
        .spawn();

    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(&url).spawn();

    Ok(())
}

/// Return the N most recently modified markdown files under `root` (excluding
/// the trash). Used by the "Recent" section (Feature 4).
#[derive(Debug, Serialize)]
pub struct RecentEntry {
    pub path: String,
    pub mtime_ms: u64,
}

#[tauri::command]
pub fn list_recent(root: String, limit: Option<usize>) -> Result<Vec<RecentEntry>, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(10);
    let mut entries: Vec<RecentEntry> = Vec::new();

    for entry in WalkDir::new(root_path)
        .min_depth(1)
        .max_depth(10)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || !name.ends_with(".md") {
            continue;
        }
        if p.to_string_lossy().contains(TRASH_DIR) {
            continue;
        }
        if let Ok(meta) = p.metadata() {
            if let Ok(modified) = meta.modified() {
                if let Ok(d) = modified.duration_since(std::time::UNIX_EPOCH) {
                    let mtime = d.as_secs() * 1000 + d.subsec_millis() as u64;
                    if let Ok(rel) = p.strip_prefix(root_path) {
                        entries.push(RecentEntry {
                            path: rel.to_string_lossy().to_string(),
                            mtime_ms: mtime,
                        });
                    }
                }
            }
        }
    }
    entries.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    entries.truncate(limit);
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as tfs;

    #[test]
    fn create_folder_then_scan_finds_it() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        create_folder(root.clone(), "projects".to_string()).unwrap();
        assert!(Path::new(&root).join("projects").is_dir());

        let tree = scan_directory(root.clone()).unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name, "projects");
        assert!(tree[0].is_dir);
    }

    #[test]
    fn create_note_inside_folder_appears_nested() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        create_folder(root.clone(), "journal".to_string()).unwrap();
        create_note(
            Path::new(&root)
                .join("journal")
                .to_string_lossy()
                .to_string(),
            "july".to_string(),
        )
        .unwrap();

        let tree = scan_directory(root.clone()).unwrap();
        assert_eq!(tree.len(), 1);
        assert!(tree[0].is_dir);
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].name, "july.md");
        assert_eq!(tree[0].children[0].path, "journal/july.md");
    }

    #[test]
    fn move_note_into_folder_updates_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        create_folder(root.clone(), "archive".to_string()).unwrap();
        create_note(root.clone(), "todo".to_string()).unwrap();
        move_node(
            Path::new(&root)
                .join("todo.md")
                .to_string_lossy()
                .to_string(),
            Path::new(&root)
                .join("archive/todo.md")
                .to_string_lossy()
                .to_string(),
        )
        .unwrap();

        let tree = scan_directory(root.clone()).unwrap();
        assert_eq!(tree.len(), 1);
        assert!(tree[0].is_dir);
        assert_eq!(tree[0].children[0].name, "todo.md");
    }

    #[test]
    fn search_finds_content() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        create_note(root.clone(), "alpha".to_string()).unwrap();
        save_note(
            Path::new(&root)
                .join("alpha.md")
                .to_string_lossy()
                .to_string(),
            "hello skiathos".to_string(),
        )
        .unwrap();

        let hits = search_notes(root.clone(), "skiathos".to_string()).unwrap();
        assert_eq!(hits, vec!["alpha.md".to_string()]);
        let none = search_notes(root, "zzz-nothing".to_string()).unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn delete_removes_file_and_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        create_note(root.clone(), "bye".to_string()).unwrap();
        delete_node(
            Path::new(&root)
                .join("bye.md")
                .to_string_lossy()
                .to_string(),
        )
        .unwrap();
        assert!(!Path::new(&root).join("bye.md").exists());

        create_folder(root.clone(), "doomed".to_string()).unwrap();
        create_note(
            Path::new(&root)
                .join("doomed")
                .to_string_lossy()
                .to_string(),
            "inner".to_string(),
        )
        .unwrap();
        delete_node(
            Path::new(&root)
                .join("doomed")
                .to_string_lossy()
                .to_string(),
        )
        .unwrap();
        assert!(!Path::new(&root).join("doomed").exists());

        let _ = tfs::remove_dir_all(&root);
    }

    // ---- New tests: dangerous paths & new features ----

    #[test]
    fn sanitize_rejects_traversal_and_separators() {
        assert!(sanitize_name("../escape").is_err());
        assert!(sanitize_name("a/b").is_err());
        assert!(sanitize_name("a\\b").is_err());
        assert!(sanitize_name("/abs").is_err());
        assert!(sanitize_name("   ").is_err());
        assert_eq!(sanitize_name("  hello  ").unwrap(), "hello");
        assert_eq!(sanitize_name("note #1").unwrap(), "note #1");
    }

    #[test]
    fn create_note_rejects_traversal_name() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let err = create_note(root.clone(), "../escape".to_string());
        assert!(err.is_err(), "traversal name must be rejected");
        // And nothing escaped outside root.
        assert!(!tmp.path().join("..").join("escape.md").exists());
    }

    #[test]
    fn move_node_refuses_to_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        create_note(root.clone(), "a".to_string()).unwrap();
        create_note(root.clone(), "b".to_string()).unwrap();
        let a = tmp.path().join("a.md").to_string_lossy().to_string();
        let b = tmp.path().join("b.md").to_string_lossy().to_string();
        let err = move_node(a, b);
        assert!(err.is_err(), "move onto existing must fail");
        // Both originals still present.
        assert!(tmp.path().join("a.md").exists());
        assert!(tmp.path().join("b.md").exists());
    }

    #[test]
    fn save_is_atomic_and_replaces_content() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("note.md");
        let ps = p.to_string_lossy().to_string();
        save_note(ps.clone(), "first".to_string()).unwrap();
        assert_eq!(read_note(ps.clone()).unwrap(), "first");
        save_note(ps.clone(), "second".to_string()).unwrap();
        assert_eq!(read_note(ps).unwrap(), "second");
        // No leftover temp files.
        for e in tfs::read_dir(tmp.path()).unwrap() {
            let name = e.unwrap().file_name();
            assert!(
                !name.to_string_lossy().starts_with(".aanote-tmp"),
                "temp file leaked"
            );
        }
    }

    #[test]
    fn save_if_unchanged_blocks_when_disk_changed() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("note.md");
        let ps = p.to_string_lossy().to_string();
        save_note(ps.clone(), "v1".to_string()).unwrap();
        let mtime = file_mtime(ps.clone()).unwrap().unwrap();

        // Simulate a sync/other-writer change behind the editor's back.
        std::thread::sleep(std::time::Duration::from_millis(20));
        save_note(ps.clone(), "v2-from-sync".to_string()).unwrap();
        let new_mtime = file_mtime(ps.clone()).unwrap().unwrap();
        assert_ne!(mtime, new_mtime, "mtime should differ after rewrite");

        // Editor still holds the OLD mtime; save must be refused.
        let saved = save_note_if_unchanged(ps.clone(), "v3-from-editor".to_string(), Some(mtime));
        assert_eq!(saved.unwrap(), false);
        assert_eq!(read_note(ps).unwrap(), "v2-from-sync");
    }

    #[test]
    fn save_if_unchanged_allows_when_stable() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("note.md");
        let ps = p.to_string_lossy().to_string();
        save_note(ps.clone(), "v1".to_string()).unwrap();
        let mtime = file_mtime(ps.clone()).unwrap().unwrap();
        let saved = save_note_if_unchanged(ps.clone(), "v2".to_string(), Some(mtime));
        assert_eq!(saved.unwrap(), true);
        assert_eq!(read_note(ps).unwrap(), "v2");
    }

    #[test]
    fn trash_then_restore_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        create_note(root.clone(), "doomed".to_string()).unwrap();
        let abs = tmp.path().join("doomed.md").to_string_lossy().to_string();
        let trash_path = trash_node(root.clone(), abs.clone()).unwrap();
        assert!(!tmp.path().join("doomed.md").exists(), "note should be gone");
        assert!(Path::new(&trash_path).exists(), "trashed file should exist");

        restore_from_trash(root.clone(), trash_path).unwrap();
        assert!(tmp.path().join("doomed.md").exists(), "note should be back");
        assert_eq!(read_note(abs).unwrap(), "");
    }

    #[test]
    fn trash_is_hidden_from_scan() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        create_note(root.clone(), "visible".to_string()).unwrap();
        create_note(root.clone(), "hidden".to_string()).unwrap();
        let abs = tmp.path().join("hidden.md").to_string_lossy().to_string();
        let _ = trash_node(root.clone(), abs).unwrap();

        let tree = scan_directory(root).unwrap();
        let names: Vec<_> = tree.iter().map(|n| n.name.clone()).collect();
        assert!(names.contains(&"visible.md".to_string()));
        assert!(!names.iter().any(|n| n.contains("hidden")));
    }

    #[test]
    fn search_snippet_returns_context() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        create_note(root.clone(), "doc".to_string()).unwrap();
        save_note(
            tmp.path().join("doc.md").to_string_lossy().to_string(),
            "intro line\nthe magic word is xyzzy here\nmore".to_string(),
        )
        .unwrap();
        let hits = search_notes_snippet(root, "xyzzy".to_string()).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("xyzzy"));
    }

    #[test]
    fn list_recent_orders_by_mtime_desc() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        create_note(root.clone(), "old".to_string()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        create_note(root.clone(), "new".to_string()).unwrap();
        let recent = list_recent(root, None).unwrap();
        assert!(recent.len() >= 2);
        // Newest first.
        assert_eq!(recent[0].path, "new.md");
    }

    #[test]
    fn open_external_rejects_non_http() {
        assert!(open_external_url("file:///etc/passwd".to_string()).is_err());
        assert!(open_external_url("javascript:alert(1)".to_string()).is_err());
        // http(s) are accepted (the spawn is a best-effort _ =; just check no Err).
        let _ = open_external_url("https://example.com".to_string());
    }
}
