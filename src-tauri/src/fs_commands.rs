use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

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

    let mut nodes = Vec::new();
    for entry in WalkDir::new(root)
        .min_depth(1)
        .max_depth(10)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let entry_path = entry.path();
        let name = entry_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let is_dir = entry_path.is_dir();

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
    fs::write(&path, content).map_err(|e| format!("Failed to save {}: {}", path, e))
}

#[tauri::command]
pub fn move_node(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(&old_path, &new_path)
        .map_err(|e| format!("Failed to move {} to {}: {}", old_path, new_path, e))
}

#[tauri::command]
pub fn create_note(dir_path: String, name: String) -> Result<String, String> {
    let full_path = Path::new(&dir_path).join(format!("{}.md", name));
    if full_path.exists() {
        return Err(format!("Note already exists: {}", full_path.display()));
    }
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    fs::write(&full_path, "")
        .map_err(|e| format!("Failed to create {}: {}", full_path.display(), e))?;
    Ok(full_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_folder(dir_path: String, name: String) -> Result<String, String> {
    let full_path = Path::new(&dir_path).join(&name);
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

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&url).spawn();

    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd").args(["/C", "start", &url]).spawn();

    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(&url).spawn();

    Ok(())
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
}
