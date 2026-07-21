use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::time::UNIX_EPOCH;

const SERVICE_NAME: &str = "aanote-gdrive";
const KEY_REFRESH_TOKEN: &str = "refresh_token";
const KEY_CLIENT_ID: &str = "client_id";
const KEY_CLIENT_SECRET: &str = "client_secret";

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SyncMeta {
    // map of relative path -> drive file id and local modified time (ms)
    pub files: HashMap<String, SyncFileEntry>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SyncFileEntry {
    pub id: String,
    pub local_mtime_ms: u64,
    pub remote_mtime_ms: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct DriveFile {
    id: String,
    name: String,
    modifiedTime: String,
    mimeType: String,
}

#[derive(Deserialize)]
struct DriveFileList {
    files: Vec<DriveFile>,
}

fn get_credential(key: &str) -> Option<String> {
    let entry = Entry::new(SERVICE_NAME, key).ok()?;
    entry.get_password().ok()
}

fn set_credential(key: &str, val: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())?;
    entry.set_password(val).map_err(|e| e.to_string())
}

fn delete_credential(key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, key).map_err(|e| e.to_string())?;
    let _ = entry.delete_password();
    Ok(())
}

#[tauri::command]
pub async fn gdrive_status() -> Result<String, String> {
    if get_credential(KEY_REFRESH_TOKEN).is_some() {
        Ok("connected".to_string())
    } else {
        Ok("disconnected".to_string())
    }
}

#[tauri::command]
pub async fn gdrive_logout() -> Result<(), String> {
    delete_credential(KEY_REFRESH_TOKEN)?;
    delete_credential(KEY_CLIENT_ID)?;
    delete_credential(KEY_CLIENT_SECRET)?;
    Ok(())
}

#[tauri::command]
pub async fn gdrive_login(client_id: String, client_secret: String) -> Result<(), String> {
    // Start TCP listener on random port
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://localhost:{}", port);

    // OAuth auth URL
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?\
        client_id={}&\
        redirect_uri={}&\
        response_type=code&\
        scope=https://www.googleapis.com/auth/drive.file&\
        access_type=offline&\
        prompt=consent",
        client_id, redirect_uri
    );

    // Open browser using open::that (Tauri's shell wrapper or simply std::process / open)
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&auth_url).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd").args(["/C", "start", &auth_url]).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(&auth_url).spawn();

    // Block and wait for redirect connection
    let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
    let mut buffer = [0; 2048];
    let bytes_read = stream.read(&mut buffer).map_err(|e| e.to_string())?;
    let request_str = String::from_utf8_lossy(&buffer[..bytes_read]);

    // Parse authorization code
    let code = request_str
        .split("code=")
        .nth(1)
        .and_then(|s| s.split('&').next())
        .and_then(|s| s.split(' ').next())
        .ok_or_else(|| "Failed to parse auth code from redirect URL".to_string())?;

    // Exchange code for token
    let client = reqwest::Client::new();
    let res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code),
            ("client_id", &client_id),
            ("client_secret", &client_secret),
            ("redirect_uri", &redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let err_body = res.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed: {}", err_body));
    }

    let token_resp: TokenResponse = res.json().await.map_err(|e| e.to_string())?;
    let refresh_token = token_resp
        .refresh_token
        .ok_or_else(|| "No refresh token returned (consent might already be given; try revoking app access first)".to_string())?;

    // Store in OS Keyring
    set_credential(KEY_CLIENT_ID, &client_id)?;
    set_credential(KEY_CLIENT_SECRET, &client_secret)?;
    set_credential(KEY_REFRESH_TOKEN, &refresh_token)?;

    // Send success HTML back to browser
    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n\
        <html>\
        <head><style>body { font-family: monospace; text-align: center; padding-top: 100px; background: #fafafa; color: #111; }</style></head>\
        <body>\
        <h2>aanote authorized!</h2>\
        <p>You can close this tab and return to the app.</p>\
        </body>\
        </html>";
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();

    Ok(())
}

async fn get_access_token() -> Result<String, String> {
    let client_id = get_credential(KEY_CLIENT_ID).ok_or("No Client ID stored")?;
    let client_secret = get_credential(KEY_CLIENT_SECRET).ok_or("No Client Secret stored")?;
    let refresh_token = get_credential(KEY_REFRESH_TOKEN).ok_or("No Refresh Token stored")?;

    let client = reqwest::Client::new();
    let res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Failed to refresh access token: {}", res.status()));
    }

    let token_resp: TokenResponse = res.json().await.map_err(|e| e.to_string())?;
    Ok(token_resp.access_token)
}

#[tauri::command]
pub async fn gdrive_sync(root_path: String) -> Result<String, String> {
    let token = get_access_token().await?;
    let client = reqwest::Client::new();

    // 1. Get or create the root folder named "aanote" in Google Drive
    let root_folder_id = get_or_create_app_folder(&client, &token).await?;

    // 2. Fetch list of files in that Google Drive folder
    let drive_files = list_drive_files(&client, &token, &root_folder_id).await?;

    // 3. Load or initialize local sync index (.sync.json)
    let sync_meta_path = Path::new(&root_path).join(".sync.json");
    let mut sync_meta = if sync_meta_path.exists() {
        let content = fs::read_to_string(&sync_meta_path).unwrap_or_default();
        serde_json::from_str::<SyncMeta>(&content).unwrap_or_else(|_| SyncMeta {
            files: HashMap::new(),
        })
    } else {
        SyncMeta {
            files: HashMap::new(),
        }
    };

    // 4. Scan local directory for all markdown files and directories
    let local_files = scan_local_dir(&root_path)?;

    let mut uploads = 0;
    let mut downloads = 0;
    let mut conflicts_resolved = 0;

    // Track processed remote IDs to identify remote deletes
    let mut processed_remote_ids = std::collections::HashSet::new();

    // A. Sync Local -> Remote (Uploads / Local modifications)
    for (rel_path, local_mtime) in &local_files {
        let entry = sync_meta.files.get(rel_path).cloned();
        
        // Find if this file already exists in remote files (e.g. by name match)
        let remote_file = drive_files.iter().find(|df| df.name == *rel_path);

        match (entry, remote_file) {
            // Case 1: Brand new file (neither locally indexed nor remote)
            (None, None) => {
                let id = upload_file(&client, &token, &root_path, rel_path, &root_folder_id).await?;
                let remote_mtime = get_remote_mtime(&client, &token, &id).await.unwrap_or(*local_mtime);
                sync_meta.files.insert(
                    rel_path.clone(),
                    SyncFileEntry {
                        id,
                        local_mtime_ms: *local_mtime,
                        remote_mtime_ms: remote_mtime,
                    },
                );
                uploads += 1;
            }
            // Case 2: Exists on remote but not locally indexed
            (None, Some(df)) => {
                let remote_mtime = parse_rfc3339_to_ms(&df.modifiedTime);
                if *local_mtime > remote_mtime {
                    // Local is newer: overwrite remote
                    update_file(&client, &token, &root_path, rel_path, &df.id).await?;
                    let new_remote_mtime = get_remote_mtime(&client, &token, &df.id).await.unwrap_or(*local_mtime);
                    sync_meta.files.insert(
                        rel_path.clone(),
                        SyncFileEntry {
                            id: df.id.clone(),
                            local_mtime_ms: *local_mtime,
                            remote_mtime_ms: new_remote_mtime,
                        },
                    );
                    uploads += 1;
                } else {
                    // Remote is newer: overwrite local
                    download_file(&client, &token, &root_path, rel_path, &df.id).await?;
                    let actual_mtime = get_file_mtime(&Path::new(&root_path).join(rel_path)).unwrap_or(*local_mtime);
                    sync_meta.files.insert(
                        rel_path.clone(),
                        SyncFileEntry {
                            id: df.id.clone(),
                            local_mtime_ms: actual_mtime,
                            remote_mtime_ms: remote_mtime,
                        },
                    );
                    downloads += 1;
                }
                processed_remote_ids.insert(df.id.clone());
            }
            // Case 3: Locally indexed but not on remote (was deleted on remote)
            (Some(se), None) => {
                let path = Path::new(&root_path).join(rel_path);
                if path.exists() {
                    let _ = fs::remove_file(path);
                }
                sync_meta.files.remove(rel_path);
            }
            // Case 4: Exists in both index and remote
            (Some(mut se), Some(df)) => {
                processed_remote_ids.insert(df.id.clone());
                let remote_mtime = parse_rfc3339_to_ms(&df.modifiedTime);
                
                let local_changed = *local_mtime != se.local_mtime_ms;
                let remote_changed = remote_mtime != se.remote_mtime_ms;

                if local_changed && remote_changed {
                    // Conflict! Last-write-wins (LWW)
                    conflicts_resolved += 1;
                    if *local_mtime > remote_mtime {
                        update_file(&client, &token, &root_path, rel_path, &df.id).await?;
                        let new_remote_mtime = get_remote_mtime(&client, &token, &df.id).await.unwrap_or(*local_mtime);
                        se.local_mtime_ms = *local_mtime;
                        se.remote_mtime_ms = new_remote_mtime;
                        sync_meta.files.insert(rel_path.clone(), se);
                        uploads += 1;
                    } else {
                        download_file(&client, &token, &root_path, rel_path, &df.id).await?;
                        let actual_mtime = get_file_mtime(&Path::new(&root_path).join(rel_path)).unwrap_or(*local_mtime);
                        se.local_mtime_ms = actual_mtime;
                        se.remote_mtime_ms = remote_mtime;
                        sync_meta.files.insert(rel_path.clone(), se);
                        downloads += 1;
                    }
                } else if local_changed {
                    // Only local changed: upload
                    update_file(&client, &token, &root_path, rel_path, &df.id).await?;
                    let new_remote_mtime = get_remote_mtime(&client, &token, &df.id).await.unwrap_or(*local_mtime);
                    se.local_mtime_ms = *local_mtime;
                    se.remote_mtime_ms = new_remote_mtime;
                    sync_meta.files.insert(rel_path.clone(), se);
                    uploads += 1;
                } else if remote_changed {
                    // Only remote changed: download
                    download_file(&client, &token, &root_path, rel_path, &df.id).await?;
                    let actual_mtime = get_file_mtime(&Path::new(&root_path).join(rel_path)).unwrap_or(*local_mtime);
                    se.local_mtime_ms = actual_mtime;
                    se.remote_mtime_ms = remote_mtime;
                    sync_meta.files.insert(rel_path.clone(), se);
                    downloads += 1;
                }
            }
        }
    }

    // B. Sync Remote -> Local (Downloads of files only on remote)
    for df in &drive_files {
        if processed_remote_ids.contains(&df.id) {
            continue;
        }
        if df.mimeType == "application/vnd.google-apps.folder" {
            continue;
        }
        // Exists only on remote. Download it.
        download_file(&client, &token, &root_path, &df.name, &df.id).await?;
        let actual_mtime = get_file_mtime(&Path::new(&root_path).join(&df.name)).unwrap_or_default();
        let remote_mtime = parse_rfc3339_to_ms(&df.modifiedTime);
        sync_meta.files.insert(
            df.name.clone(),
            SyncFileEntry {
                id: df.id.clone(),
                local_mtime_ms: actual_mtime,
                remote_mtime_ms: remote_mtime,
            },
        );
        downloads += 1;
    }

    // C. Clean up deleted local files that were previously indexed
    let mut to_remove = Vec::new();
    for (rel_path, se) in &sync_meta.files {
        if !local_files.contains_key(rel_path) {
            // Local file was deleted. Delete on remote.
            let _ = delete_remote_file(&client, &token, &se.id).await;
            to_remove.push(rel_path.clone());
        }
    }
    for r in to_remove {
        sync_meta.files.remove(&r);
    }

    // 5. Save updated sync index (ignoring it from the sync itself)
    if let Ok(serialized) = serde_json::to_string_pretty(&sync_meta) {
        let _ = fs::write(&sync_meta_path, serialized);
    }

    Ok(format!(
        "Sync completed: uploaded {}, downloaded {}, resolved {} conflicts",
        uploads, downloads, conflicts_resolved
    ))
}

async fn get_or_create_app_folder(client: &reqwest::Client, token: &str) -> Result<String, String> {
    // Check if folder "aanote" exists
    let res = client
        .get("https://www.googleapis.com/drive/v3/files")
        .query(&[
            ("q", "name = 'aanote' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"),
            ("spaces", "drive"),
            ("fields", "files(id, name, modifiedTime, mimeType)"),
        ])
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Drive API error (get_or_create_app_folder) {}: {}", status, err_text));
    }

    let list: DriveFileList = res.json().await.map_err(|e| e.to_string())?;
    if let Some(folder) = list.files.first() {
        return Ok(folder.id.clone());
    }

    // Create the folder
    let body = serde_json::json!({
        "name": "aanote",
        "mimeType": "application/vnd.google-apps.folder"
    });

    let res = client
        .post("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Failed to create aanote folder: {}", res.status()));
    }

    let created: DriveFile = res.json().await.map_err(|e| e.to_string())?;
    Ok(created.id)
}

async fn list_drive_files(client: &reqwest::Client, token: &str, parent_id: &str) -> Result<Vec<DriveFile>, String> {
    let q = format!("'{}' in parents and trashed = false", parent_id);
    let spaces = "drive";
    let fields = "files(id, name, modifiedTime, mimeType)";
    let res = client
        .get("https://www.googleapis.com/drive/v3/files")
        .query(&[
            ("q", q.as_str()),
            ("spaces", spaces),
            ("fields", fields),
        ])
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Drive API error (list_drive_files) {}: {}", status, err_text));
    }

    let list: DriveFileList = res.json().await.map_err(|e| e.to_string())?;
    Ok(list.files)
}

async fn upload_file(
    client: &reqwest::Client,
    token: &str,
    root: &str,
    rel_path: &str,
    parent_id: &str,
) -> Result<String, String> {
    let local_path = Path::new(root).join(rel_path);
    let content = fs::read(&local_path).map_err(|e| e.to_string())?;

    let metadata = serde_json::json!({
        "name": rel_path,
        "parents": [parent_id]
    });

    let form = reqwest::multipart::Form::new()
        .part("metadata", reqwest::multipart::Part::text(metadata.to_string()).mime_str("application/json").map_err(|e| e.to_string())?)
        .part("media", reqwest::multipart::Part::bytes(content).mime_str("text/markdown").map_err(|e| e.to_string())?);

    let res = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart")
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Upload failed for {}: {}", rel_path, res.status()));
    }

    let created: DriveFile = res.json().await.map_err(|e| e.to_string())?;
    Ok(created.id)
}

async fn update_file(
    client: &reqwest::Client,
    token: &str,
    root: &str,
    rel_path: &str,
    file_id: &str,
) -> Result<(), String> {
    let local_path = Path::new(root).join(rel_path);
    let content = fs::read(&local_path).map_err(|e| e.to_string())?;

    let url = format!("https://www.googleapis.com/upload/drive/v3/files/{}?uploadType=media", file_id);
    let res = client
        .patch(&url)
        .bearer_auth(token)
        .body(content)
        .header("Content-Type", "text/markdown")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Update failed for {}: {}", rel_path, res.status()));
    }
    Ok(())
}

async fn download_file(
    client: &reqwest::Client,
    token: &str,
    root: &str,
    rel_path: &str,
    file_id: &str,
) -> Result<(), String> {
    let url = format!("https://www.googleapis.com/drive/v3/files/{}?alt=media", file_id);
    let res = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Download failed for {}: {}", rel_path, res.status()));
    }

    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let local_path = Path::new(root).join(rel_path);
    
    // Create parent directories if missing (e.g. subfolders)
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    fs::write(&local_path, bytes).map_err(|e| e.to_string())?;
    Ok(())
}

async fn get_remote_mtime(client: &reqwest::Client, token: &str, file_id: &str) -> Result<u64, String> {
    let url = format!("https://www.googleapis.com/drive/v3/files/{}?fields=modifiedTime", file_id);
    let res = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Get remote mtime failed: {}", res.status()));
    }
    #[derive(Deserialize)]
    struct MtimeResp {
        modifiedTime: String,
    }
    let resp: MtimeResp = res.json().await.map_err(|e| e.to_string())?;
    Ok(parse_rfc3339_to_ms(&resp.modifiedTime))
}

async fn delete_remote_file(client: &reqwest::Client, token: &str, file_id: &str) -> Result<(), String> {
    let url = format!("https://www.googleapis.com/drive/v3/files/{}", file_id);
    let res = client
        .delete(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() && res.status() != reqwest::StatusCode::NOT_FOUND {
        return Err(format!("Delete failed: {}", res.status()));
    }
    Ok(())
}

fn scan_local_dir(root: &str) -> Result<HashMap<String, u64>, String> {
    let mut files = HashMap::new();
    let root_path = Path::new(root);
    if !root_path.exists() {
        return Ok(files);
    }

    let walker = walkdir::WalkDir::new(root_path).into_iter();
    for entry in walker.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            let filename = path.file_name().unwrap_or_default().to_string_lossy();
            if filename == ".sync.json" || filename.starts_with('.') {
                continue;
            }
            if let Ok(rel_path) = path.strip_prefix(root_path) {
                let rel_str = rel_path.to_string_lossy().to_string();
                let mtime = get_file_mtime(path).unwrap_or_default();
                files.insert(rel_str, mtime);
            }
        }
    }
    Ok(files)
}

fn get_file_mtime(path: &Path) -> Option<u64> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_secs() * 1000 + duration.subsec_millis() as u64)
}

fn parse_rfc3339_to_ms(rfc: &str) -> u64 {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(rfc) {
        dt.timestamp_millis() as u64
    } else {
        0
    }
}
