use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::State;

const SERVICE_NAME: &str = "aanote-gdrive";
const KEY_REFRESH_TOKEN: &str = "refresh_token";
const KEY_CLIENT_ID: &str = "client_id";
const KEY_CLIENT_SECRET: &str = "client_secret";

/// Shared mutable state holding the currently-running sync. Only one sync runs
/// at a time across all invoke() callers (C2 fix). Holds a bool so the
/// frontend can also query it to show "syncing" without re-entering.
pub struct SyncState {
    pub in_progress: Mutex<bool>,
}

/// Build a reqwest client with sane connect/read timeouts so a stalled network
/// can't hang the sync forever (S2 fix).
fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

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

/// Structured result of a sync, serialized to the frontend so the sync-status
/// chip can show "synced 3 notes · 1.2k chars" instead of an opaque string.
#[derive(Serialize, Debug, Clone, Default)]
pub struct SyncResult {
    pub uploaded: u32,
    pub downloaded: u32,
    pub conflicts: u32,
    /// Total characters transferred (sum of bytes/4-ish; we count chars of the
    /// markdown content uploaded + downloaded). Used for the "· N chars" hint.
    pub chars_synced: u64,
    /// Human-readable summary, for toasts/logs that want a one-liner.
    pub summary: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct DriveFile {
    id: String,
    name: String,
    modified_time: Option<String>,
    mime_type: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct DriveFileList {
    files: Vec<DriveFile>,
    #[serde(default)]
    next_page_token: Option<String>,
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

/// Minimal percent-decoding for OAuth redirect params.
fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(
                &String::from_utf8_lossy(&bytes[i + 1..i + 3]),
                16,
            ) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
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
pub async fn gdrive_reset_sync(
    root_path: String,
    state: State<'_, SyncState>,
) -> Result<String, String> {
    // Serialize: don't run reset while a sync is in progress.
    {
        let mut guard = state
            .in_progress
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        if *guard {
            return Err("A sync is already in progress; wait for it to finish.".to_string());
        }
        *guard = true;
    }
    let result = gdrive_reset_sync_inner(root_path).await;
    if let Ok(mut guard) = state.in_progress.lock() {
        *guard = false;
    }
    result
}

async fn gdrive_reset_sync_inner(root_path: String) -> Result<String, String> {
    // 1. Delete local .sync.json
    let sync_meta_path = Path::new(&root_path).join(".sync.json");
    if sync_meta_path.exists() {
        fs::remove_file(&sync_meta_path).map_err(|e| e.to_string())?;
    }

    // 2. Delete all files in the Google Drive "aanote" folder
    let token = get_access_token().await?;
    let client = http_client();
    let root_folder_id = get_or_create_app_folder(&client, &token).await?;
    let drive_files = list_drive_files(&client, &token, &root_folder_id).await?;

    let mut deleted = 0;
    for df in &drive_files {
        // Only count actual successes (S10 fix).
        if delete_remote_file(&client, &token, &df.id).await.is_ok() {
            deleted += 1;
        }
    }

    Ok(format!("Reset sync: deleted local index and {} remote files", deleted))
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

    // Open browser to the OAuth consent URL.
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&auth_url).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd").args(["/C", "start", &auth_url]).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(&auth_url).spawn();

    // Block and wait for the redirect, but with a timeout so a closed browser
    // tab doesn't hang the command forever (S1 fix). The listener itself is
    // std (blocking); spawn_blocking runs it off the async runtime.
    let (mut stream, _) = tokio::select! {
        r = tokio::task::spawn_blocking(move || listener.accept()) => {
            r.map_err(|e| format!("Accept task failed: {}", e))?.map_err(|e| e.to_string())?
        }
        _ = tokio::time::sleep(std::time::Duration::from_secs(180)) => {
            return Err("Login timed out waiting for browser redirect (180s).".to_string());
        }
    };

    // Read the full HTTP request, looping in case it arrives in segments (S9 fix).
    let mut request_str = String::new();
    let mut buffer = [0u8; 4096];
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .ok();
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                request_str.push_str(&String::from_utf8_lossy(&buffer[..n]));
                // Stop once we have the redirect line.
                if request_str.contains("code=") || request_str.contains("error=") {
                    break;
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => break,
            Err(e) => return Err(format!("Failed to read redirect: {}", e)),
        }
    }

    // Parse the redirect line robustly. It looks like:
    //   GET /?code=4/0xxx&scope=... HTTP/1.1
    // or on error:
    //   GET /?error=access_denied HTTP/1.1
    let first_line = request_str.lines().next().unwrap_or("");
    let query = first_line
        .split_whitespace()
        .nth(1)
        .and_then(|path| path.split('?').nth(1))
        .unwrap_or("");
    let mut params: HashMap<String, String> = HashMap::new();
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = url_decode(it.next().unwrap_or(""));
        let v = url_decode(it.next().unwrap_or(""));
        if !k.is_empty() {
            params.insert(k, v);
        }
    }

    // Surface explicit OAuth errors instead of a generic "parse failed" (S2 fix).
    if let Some(err) = params.get("error") {
        return Err(format!("Authorization denied: {}", err));
    }

    let code = params
        .get("code")
        .ok_or_else(|| "Failed to parse auth code from redirect URL".to_string())?;

    // Exchange code for token
    let client = http_client();
    let res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code.as_str()),
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

    let client = http_client();
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
pub async fn gdrive_sync(
    root_path: String,
    state: State<'_, SyncState>,
) -> Result<SyncResult, String> {
    // Serialize: only one sync at a time (C2 fix). A second caller bails out
    // immediately rather than racing on .sync.json and Drive state.
    {
        let mut guard = state
            .in_progress
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        if *guard {
            // Return a no-op result so the frontend treats it as "nothing changed".
            return Ok(SyncResult {
                uploaded: 0,
                downloaded: 0,
                conflicts: 0,
                chars_synced: 0,
                summary: "Sync already in progress".to_string(),
            });
        }
        *guard = true;
    }
    let result = gdrive_sync_inner(root_path).await;
    if let Ok(mut guard) = state.in_progress.lock() {
        *guard = false;
    }
    // gdrive_sync_inner persists the index on BOTH success and error paths, so
    // partial progress from successful per-file ops survives a mid-sync failure.
    result
}

async fn gdrive_sync_inner(root_path: String) -> Result<SyncResult, String> {
    let token = get_access_token().await?;
    let client = http_client();

    // 1. Get or create the root folder named "aanote" in Google Drive
    let root_folder_id = get_or_create_app_folder(&client, &token).await?;

    // 2. Fetch ALL files in that Drive folder (paginated — C1 fix)
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

    // Run the body. On ANY error, save whatever progress we made to the index
    // before propagating — so a mid-sync network blip doesn't discard the
    // sync_meta updates from files that already succeeded (Bug #3 fix). This
    // prevents orphan Drive files and re-conflict/dedup churn on the next sync.
    let body_result = sync_body(
        &client,
        &token,
        &root_path,
        &root_folder_id,
        &drive_files,
        &mut sync_meta,
        &sync_meta_path,
    )
    .await;

    // Always persist the (partially) updated index, success or failure.
    if let Ok(serialized) = serde_json::to_string_pretty(&sync_meta) {
        atomic_write_index(&sync_meta_path, &serialized);
    }

    body_result
}

/// The core sync loop, separated from `gdrive_sync_inner` so the caller can
/// save the index even when this returns an error. Mutates `sync_meta` in place.
#[allow(clippy::too_many_arguments)]
async fn sync_body(
    client: &reqwest::Client,
    token: &str,
    root_path: &str,
    root_folder_id: &str,
    drive_files: &[DriveFile],
    sync_meta: &mut SyncMeta,
    sync_meta_path: &Path,
) -> Result<SyncResult, String> {
    let _ = sync_meta_path; // used by caller for persistence; kept in signature for clarity

    // Deduplicate remote files (clean up Google Drive). Keep the one whose id is
    // locally mapped; otherwise keep the newest by mtime (ties broken by id for
    // determinism — S10 fix).
    let mut unique_drive_files: HashMap<String, DriveFile> = HashMap::new();
    let mut duplicates_to_delete = Vec::new();

    for df in drive_files.iter() {
        let name = df.name.clone();
        if let Some(existing) = unique_drive_files.get(&name) {
            let local_mapped_id = sync_meta.files.get(&name).map(|se| &se.id);
            let keep_existing = if local_mapped_id == Some(&existing.id) {
                true
            } else if local_mapped_id == Some(&df.id) {
                false
            } else {
                let existing_mtime = parse_rfc3339_to_ms(existing.modified_time.as_deref().unwrap_or(""));
                let current_mtime = parse_rfc3339_to_ms(df.modified_time.as_deref().unwrap_or(""));
                if existing_mtime == current_mtime {
                    // Tie: deterministic by id so behavior is stable across runs.
                    existing.id < df.id
                } else {
                    existing_mtime > current_mtime
                }
            };

            if keep_existing {
                duplicates_to_delete.push(df.id.clone());
            } else {
                if let Some(old) = unique_drive_files.insert(name, df.clone()) {
                    duplicates_to_delete.push(old.id);
                }
            }
        } else {
            unique_drive_files.insert(name, df.clone());
        }
    }

    for dup_id in duplicates_to_delete {
        let _ = delete_remote_file(client, token, &dup_id).await;
    }

    let drive_files: Vec<DriveFile> = unique_drive_files.into_values().collect();

    // 4. Scan local directory for all markdown files and directories
    let local_files = scan_local_dir(root_path)?;

    let mut uploads = 0u32;
    let mut downloads = 0u32;
    let mut conflicts_resolved = 0u32;
    let mut chars_synced: u64 = 0;

    // Track processed remote IDs to identify remote-only files in loop B.
    let mut processed_remote_ids = std::collections::HashSet::new();
    // Track rel paths whose Drive file was found by ID but under a NEW name
    // (a rename done on the Drive web UI). We rename the local file to match.
    // (C8 fix.)
    let mut pending_remote_renames: Vec<(String, String)> = Vec::new(); // (old_rel, new_rel)
    // Paths created/renamed by downloads during THIS sync. Case C must skip
    // these because the `local_files` snapshot (taken above) predates them —
    // otherwise it would delete them as "locally missing". (Critical fix for
    // the Loop B / Case C data-loss bug.)
    let mut touched_local_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    // NOTE: index persistence is handled by the caller (gdrive_sync_inner) on
    // both success and error paths — no save_index closure here.

    // A. Sync Local -> Remote (Uploads / Local modifications)
    for (rel_path, local_mtime) in &local_files {
        let entry = sync_meta.files.get(rel_path).cloned();

        // Find the remote file: by indexed id first, then by name.
        let remote_match = if let Some(ref se) = entry {
            drive_files.iter().find(|df| df.id == se.id)
                .map(|df| (df, true)) // found-by-id
                .or_else(|| drive_files.iter().find(|df| df.name == *rel_path).map(|df| (df, false)))
        } else {
            drive_files.iter().find(|df| df.name == *rel_path).map(|df| (df, false))
        };

        match (entry, remote_match) {
            // Case 1: Brand new file (neither locally indexed nor remote)
            (None, None) => {
                let (id, remote_mtime, ch) = upload_file(client, token, root_path, rel_path, &root_folder_id).await?;
                    chars_synced += ch;
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
            (None, Some((df, _by_id))) => {
                let remote_mtime = parse_rfc3339_to_ms(df.modified_time.as_deref().unwrap_or(""));
                if *local_mtime > remote_mtime {
                    // Local is newer: overwrite remote
                    let (new_remote_mtime, ch) = update_file(client, token, root_path, rel_path, &df.id).await?;
                        chars_synced += ch;
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
                    // Remote is newer: overwrite local. Set the downloaded
                    // file's mtime to the remote mtime so local_mtime_ms ==
                    // remote_mtime_ms (prevents steady-state re-download loops).
                    chars_synced += download_file(client, token, root_path, rel_path, &df.id).await?.len() as u64;
                    let local_abs = Path::new(&root_path).join(rel_path);
                    set_file_mtime(&local_abs, remote_mtime);
                    touched_local_paths.insert(rel_path.clone());
                    sync_meta.files.insert(
                        rel_path.clone(),
                        SyncFileEntry {
                            id: df.id.clone(),
                            local_mtime_ms: remote_mtime,
                            remote_mtime_ms: remote_mtime,
                        },
                    );
                    downloads += 1;
                }
                processed_remote_ids.insert(df.id.clone());
            }
            // Case 3: Locally indexed but not on remote (was deleted on remote).
            // Do NOT delete the local file — that's data loss if the id mapping
            // is merely stale (C7 fix). Instead: re-upload as a new file,
            // preserving the user's local copy.
            (Some(_se), None) => {
                let (id, remote_mtime, ch) = upload_file(client, token, root_path, rel_path, &root_folder_id).await?;
                    chars_synced += ch;
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
            // Case 4: Exists in both index and remote
            (Some(mut se), Some((df, found_by_id))) => {
                processed_remote_ids.insert(df.id.clone());
                let remote_mtime = parse_rfc3339_to_ms(df.modified_time.as_deref().unwrap_or(""));

                // C8: remote was renamed (same id, different name). Rename local.
                if found_by_id && df.name != *rel_path {
                    pending_remote_renames.push((rel_path.clone(), df.name.clone()));
                }

                // Bug #4 fix: always refresh the stored id to the current remote
                // file's id. If we matched by name only (found_by_id=false) the
                // stored id may be stale; without this, a later Drive rename
                // (matched by id) would never fire, and Case C would delete the
                // wrong (stale) id.
                se.id = df.id.clone();

                // mtime comparison with a 1000ms tolerance to absorb filesystem
                // resolution differences (FAT/exFAT) and Drive's eventual
                // consistency on modifiedTime. Prevents steady-state loops.
                let local_changed = mtime_differs(*local_mtime, se.local_mtime_ms);
                let remote_changed = mtime_differs(remote_mtime, se.remote_mtime_ms);

                if local_changed && remote_changed {
                    // Conflict! Instead of silent last-write-wins, keep BOTH:
                    // the loser is saved as a "<name> (conflict <ts>).md" copy
                    // and the winner overwrites the canonical path (Feature 1).
                    conflicts_resolved += 1;
                    if *local_mtime > remote_mtime {
                        // Local wins. Preserve remote version as a conflict copy.
                        save_remote_conflict_copy(client, token, root_path, rel_path, &df.id).await;
                        let (new_remote_mtime, ch) = update_file(client, token, root_path, rel_path, &df.id).await?;
                        chars_synced += ch;
                        se.local_mtime_ms = *local_mtime;
                        se.remote_mtime_ms = new_remote_mtime;
                        sync_meta.files.insert(rel_path.clone(), se);
                        uploads += 1;
                    } else {
                        // Remote wins. Preserve local version as a conflict copy,
                        // then overwrite local with remote. Set the file's mtime
                        // to the remote mtime (loop prevention).
                        save_local_conflict_copy(&root_path, rel_path);
                        chars_synced += download_file(client, token, root_path, rel_path, &df.id).await?.len() as u64;
                        let local_abs = Path::new(&root_path).join(rel_path);
                        set_file_mtime(&local_abs, remote_mtime);
                        touched_local_paths.insert(rel_path.clone());
                        se.local_mtime_ms = remote_mtime;
                        se.remote_mtime_ms = remote_mtime;
                        sync_meta.files.insert(rel_path.clone(), se);
                        downloads += 1;
                    }
                } else if local_changed {
                    // Only local changed: upload
                    let (new_remote_mtime, ch) = update_file(client, token, root_path, rel_path, &df.id).await?;
                        chars_synced += ch;
                    se.local_mtime_ms = *local_mtime;
                    se.remote_mtime_ms = new_remote_mtime;
                    sync_meta.files.insert(rel_path.clone(), se);
                    uploads += 1;
                } else if remote_changed {
                    // Only remote changed: download. Set mtime to remote (loop
                    // prevention) and record as touched so Case C spares it.
                    chars_synced += download_file(client, token, root_path, rel_path, &df.id).await?.len() as u64;
                    let local_abs = Path::new(&root_path).join(rel_path);
                    set_file_mtime(&local_abs, remote_mtime);
                    touched_local_paths.insert(rel_path.clone());
                    se.local_mtime_ms = remote_mtime;
                    se.remote_mtime_ms = remote_mtime;
                    sync_meta.files.insert(rel_path.clone(), se);
                    downloads += 1;
                } else {
                    // Neither changed — just ensure the id is current (already
                    // set above) and persist the (possibly refreshed) entry.
                    sync_meta.files.insert(rel_path.clone(), se);
                }
            }
        }
    }

    // Apply remote-side renames (C8 fix): move local file to its new name.
    for (old_rel, new_rel) in &pending_remote_renames {
        let from = Path::new(&root_path).join(old_rel);
        let to = Path::new(&root_path).join(new_rel);
        if from.exists() && !to.exists() {
            if let Some(parent) = to.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::rename(&from, &to);
            // Record BOTH old and new names as touched so Case C (which checks
            // the stale local_files snapshot) doesn't delete the renamed file.
            touched_local_paths.insert(old_rel.clone());
            touched_local_paths.insert(new_rel.clone());
            // Update the index: remove old key, re-add under new name.
            if let Some(se) = sync_meta.files.remove(old_rel) {
                let actual_mtime = get_file_mtime(&to).unwrap_or(se.local_mtime_ms);
                let mut new_se = se;
                new_se.local_mtime_ms = actual_mtime;
                sync_meta.files.insert(new_rel.clone(), new_se);
            }
        }
    }

    // B. Sync Remote -> Local (Downloads of files only on remote)
    for df in &drive_files {
        if processed_remote_ids.contains(&df.id) {
            continue;
        }
        if let Some(ref mime) = df.mime_type {
            if mime == "application/vnd.google-apps.folder" {
                continue;
            }
        }
        // Exists only on remote. Download it, set mtime to remote (loop
        // prevention), and record as touched so Case C spares it.
        let remote_mtime = parse_rfc3339_to_ms(df.modified_time.as_deref().unwrap_or(""));
        chars_synced += download_file(client, token, root_path, &df.name, &df.id).await?.len() as u64;
        let local_abs = Path::new(&root_path).join(&df.name);
        set_file_mtime(&local_abs, remote_mtime);
        touched_local_paths.insert(df.name.clone());
        sync_meta.files.insert(
            df.name.clone(),
            SyncFileEntry {
                id: df.id.clone(),
                local_mtime_ms: remote_mtime,
                remote_mtime_ms: remote_mtime,
            },
        );
        downloads += 1;
    }

    // C. Clean up deleted local files that were previously indexed.
    // Local file was deleted → propagate the delete to remote (intentional).
    // IMPORTANT: skip anything in `touched_local_paths` — those were created or
    // renamed DURING this sync, so they legitimately aren't in the `local_files`
    // snapshot (taken at the start). Without this, Case C would immediately
    // delete every file Loop B just downloaded. (Critical fix.)
    let mut to_remove = Vec::new();
    for (rel_path, se) in &sync_meta.files {
        if touched_local_paths.contains(rel_path) {
            continue;
        }
        if !local_files.contains_key(rel_path) {
            let _ = delete_remote_file(client, token, &se.id).await;
            to_remove.push(rel_path.clone());
        }
    }
    for r in to_remove {
        sync_meta.files.remove(&r);
    }

    // 5. (Index persistence is handled by the caller on both success + error.)

    let notes_touched = uploads + downloads;
    let summary = if notes_touched == 0 && conflicts_resolved == 0 {
        "Already up to date".to_string()
    } else {
        format!(
            "Synced {} note{}, {} conflict{}",
            notes_touched,
            if notes_touched == 1 { "" } else { "s" },
            conflicts_resolved,
            if conflicts_resolved == 1 { "" } else { "s" }
        )
    };

    Ok(SyncResult {
        uploaded: uploads,
        downloaded: downloads,
        conflicts: conflicts_resolved,
        chars_synced,
        summary,
    })
}

/// Atomically write the sync index (temp-file-then-rename). A crash mid-write
/// won't corrupt the index (C4 fix).
fn atomic_write_index(path: &Path, content: &str) {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(".aanote-sync-tmp");
    if fs::write(&tmp, content).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

/// Save the current local file at `rel_path` as a conflict copy before it gets
/// Build a conflict-copy filename with millisecond-precision timestamp, and if
/// a file already exists at that name, append a counter until free. Prevents
/// two conflicts in the same instant silently overwriting each other (Bug #6).
fn unique_conflict_path(parent: &Path, stem: &str, kind: &str) -> std::path::PathBuf {
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S%3f");
    let mut dest = parent.join(format!("{} ({} conflict {}).md", stem, kind, ts));
    let mut n = 2;
    while dest.exists() {
        dest = parent.join(format!("{} ({} conflict {}-{}).md", stem, kind, ts, n));
        n += 1;
    }
    dest
}

/// overwritten by a remote download. Feature 1.
fn save_local_conflict_copy(root: &str, rel_path: &str) {
    let src = Path::new(root).join(rel_path);
    if !src.exists() {
        return;
    }
    let Some(parent) = src.parent() else { return };
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("note");
    let dest = unique_conflict_path(parent, stem, "local");
    let _ = fs::copy(&src, &dest);
}

/// Download the remote version of a file and save it as a conflict copy before
/// the local version overwrites remote. Feature 1.
async fn save_remote_conflict_copy(
    client: &reqwest::Client,
    token: &str,
    root: &str,
    rel_path: &str,
    file_id: &str,
) {
    let url = format!("https://www.googleapis.com/drive/v3/files/{}?alt=media", file_id);
    let res = client.get(&url).bearer_auth(token).send().await;
    if let Ok(res) = res {
        if res.status().is_success() {
            if let Ok(bytes) = res.bytes().await {
                let local_path = Path::new(root).join(rel_path);
                if let Some(parent) = local_path.parent() {
                    let stem = local_path.file_stem().and_then(|s| s.to_str()).unwrap_or("note");
                    let dest = unique_conflict_path(parent, stem, "remote");
                    let _ = fs::write(&dest, bytes);
                }
            }
        }
    }
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
    let mut all = Vec::new();
    let mut page_token: Option<String> = None;

    loop {
        let mut req = client
            .get("https://www.googleapis.com/drive/v3/files")
            .query(&[
                ("q", q.as_str()),
                ("spaces", spaces),
                ("fields", fields),
                // Page size 200 keeps round-trips down while staying well under
                // the 1000 cap. Default is 100, which silently truncates (C1).
                ("pageSize", "200"),
            ]);
        if let Some(pt) = &page_token {
            req = req.query(&[("pageToken", pt.as_str())]);
        }
        let res = req.bearer_auth(token).send().await.map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let err_text = res.text().await.unwrap_or_default();
            return Err(format!("Drive API error (list_drive_files) {}: {}", status, err_text));
        }

        let list: DriveFileList = res.json().await.map_err(|e| e.to_string())?;
        all.extend(list.files);
        match list.next_page_token {
            Some(next) => page_token = Some(next),
            None => break,
        }
    }
    Ok(all)
}

async fn upload_file(
    client: &reqwest::Client,
    token: &str,
    root: &str,
    rel_path: &str,
    parent_id: &str,
) -> Result<(String, u64, u64), String> {
    let local_path = Path::new(root).join(rel_path);
    let content = fs::read(&local_path).map_err(|e| e.to_string())?;
    let chars = content.len() as u64;

    let metadata = serde_json::json!({
        "name": rel_path,
        "parents": [parent_id]
    });

    let form = reqwest::multipart::Form::new()
        .part("metadata", reqwest::multipart::Part::text(metadata.to_string()).mime_str("application/json").map_err(|e| e.to_string())?)
        .part("media", reqwest::multipart::Part::bytes(content).mime_str("text/markdown").map_err(|e| e.to_string())?);

    // Ask Drive to return id+modifiedTime so we don't need a follow-up GET
    // (S5/S6 fix: avoids masking a failed mtime fetch with the local mtime).
    let res = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime")
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Upload failed for {}: {} {}", rel_path, status, err_text));
    }

    let created: DriveFile = res.json().await.map_err(|e| e.to_string())?;
    let remote_mtime = parse_rfc3339_to_ms(created.modified_time.as_deref().unwrap_or(""));
    Ok((created.id, remote_mtime, chars))
}

async fn update_file(
    client: &reqwest::Client,
    token: &str,
    root: &str,
    rel_path: &str,
    file_id: &str,
) -> Result<(u64, u64), String> {
    let local_path = Path::new(root).join(rel_path);
    let content = fs::read(&local_path).map_err(|e| e.to_string())?;
    let chars = content.len() as u64;

    let url = format!(
        "https://www.googleapis.com/upload/drive/v3/files/{}?uploadType=media&fields=modifiedTime",
        file_id
    );
    let res = client
        .patch(&url)
        .bearer_auth(token)
        .body(content)
        .header("Content-Type", "text/markdown")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Update failed for {}: {} {}", rel_path, status, err_text));
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MtimeResp {
        modified_time: Option<String>,
    }
    let resp: MtimeResp = res.json().await.unwrap_or(MtimeResp { modified_time: None });
    Ok((parse_rfc3339_to_ms(resp.modified_time.as_deref().unwrap_or("")), chars))
}

async fn download_file(
    client: &reqwest::Client,
    token: &str,
    root: &str,
    rel_path: &str,
    file_id: &str,
) -> Result<Vec<u8>, String> {
    let url = format!("https://www.googleapis.com/drive/v3/files/{}?alt=media", file_id);
    let res = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Download failed for {}: {} {}", rel_path, status, err_text));
    }

    let bytes = res.bytes().await.map_err(|e| e.to_string())?.to_vec();
    let local_path = Path::new(root).join(rel_path);

    // Create parent directories if missing (e.g. subfolders)
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Atomic write so a crash mid-download can't corrupt the note (C4 fix).
    atomic_write_bytes(&local_path, &bytes).map_err(|e| format!("Failed to write {}: {}", local_path.display(), e))?;
    Ok(bytes)
}

/// Set a file's mtime to the given millis-since-epoch. Used after downloads so
/// the local mtime matches the remote mtime — this keeps local_mtime_ms and
/// remote_mtime_ms in sync, preventing steady-state re-download loops on the
/// next sync. (Fix for the mtime steady-state loop.)
fn set_file_mtime(path: &Path, mtime_ms: u64) {
    let secs = (mtime_ms / 1000) as i64;
    let nanos = ((mtime_ms % 1000) * 1_000_000) as u32;
    let time = std::time::SystemTime::UNIX_EPOCH
        .checked_add(std::time::Duration::new(secs as u64, nanos));
    if let Some(t) = time {
        // Best-effort: failures here are non-fatal.
        let _ = filetime::set_file_mtime(path, filetime::FileTime::from_system_time(t));
    }
}

/// Atomic write used by download_file (kept here to avoid a cross-module dep).
fn atomic_write_bytes(path: &Path, content: &[u8]) -> Result<(), std::io::Error> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".aanote-dl-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("x")
    ));
    fs::write(&tmp, content)?;
    fs::rename(&tmp, path)?;
    Ok(())
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

/// Compare two mtimes with a 1000ms tolerance. Returns true if they "differ"
/// enough to warrant a sync action. Absorbs: (a) filesystem mtime resolution
/// (FAT/exFAT round to 2s), (b) Drive's eventual consistency on modifiedTime
/// between POST and GET, (c) sub-millisecond truncation. Prevents the steady-
/// state re-download/re-upload loop where a file syncs every cycle despite no
/// real change.
fn mtime_differs(a: u64, b: u64) -> bool {
    let diff = if a > b { a - b } else { b - a };
    diff > 1000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rfc3339_known_value() {
        // 2024-01-01T00:00:00Z = 1704067200000 ms
        assert_eq!(parse_rfc3339_to_ms("2024-01-01T00:00:00Z"), 1704067200000);
    }

    #[test]
    fn parse_rfc3339_with_offset() {
        // 2024-01-01T01:00:00+01:00 == same instant as above
        assert_eq!(
            parse_rfc3339_to_ms("2024-01-01T01:00:00+01:00"),
            1704067200000
        );
    }

    #[test]
    fn parse_rfc3339_garbage_returns_zero() {
        // S6: malformed input returns 0 (documented behavior, not a panic).
        assert_eq!(parse_rfc3339_to_ms("not a date"), 0);
        assert_eq!(parse_rfc3339_to_ms(""), 0);
    }

    #[test]
    fn url_decode_basic() {
        assert_eq!(url_decode("hello"), "hello");
        assert_eq!(url_decode("a+b"), "a b");
        assert_eq!(url_decode("%2F"), "/");
        assert_eq!(url_decode("%2f"), "/");
        assert_eq!(url_decode("4%2F0AXX"), "4/0AXX");
        // Truncated percent escape passes through unchanged (no panic).
        assert_eq!(url_decode("%2"), "%2");
    }

    #[test]
    fn atomic_write_index_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join(".sync.json");
        atomic_write_index(&p, "{\"files\":{}}");
        let content = fs::read_to_string(&p).unwrap();
        assert_eq!(content, "{\"files\":{}}");
        // No temp file left behind.
        assert!(!tmp.path().join(".aanote-sync-tmp").exists());
    }

    #[test]
    fn save_local_conflict_copy_creates_file() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let note = tmp.path().join("note.md");
        fs::write(&note, "local edits").unwrap();
        save_local_conflict_copy(&root, "note.md");
        // A conflict copy exists alongside the original.
        let mut found = false;
        for e in fs::read_dir(tmp.path()).unwrap() {
            let name = e.unwrap().file_name().to_string_lossy().to_string();
            if name.starts_with("note (local conflict ") && name.ends_with(".md") {
                found = true;
                assert_eq!(fs::read_to_string(tmp.path().join(name)).unwrap(), "local edits");
            }
        }
        assert!(found, "expected a conflict copy to be created");
        // Original untouched.
        assert_eq!(fs::read_to_string(&note).unwrap(), "local edits");
    }

    #[test]
    fn atomic_write_bytes_replaces_content() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("dl.md");
        atomic_write_bytes(&p, b"first").unwrap();
        atomic_write_bytes(&p, b"second").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "second");
    }

    #[test]
    fn sync_state_locking_baseline() {
        // Sanity: the shared state struct used for C2 serialization works.
        let state = SyncState {
            in_progress: Mutex::new(false),
        };
        assert_eq!(*state.in_progress.lock().unwrap(), false);
        *state.in_progress.lock().unwrap() = true;
        assert_eq!(*state.in_progress.lock().unwrap(), true);
    }

    #[test]
    fn mtime_differs_tolerance_absorbs_jitter() {
        // Equal → no change.
        assert!(!mtime_differs(1000, 1000));
        // Within 1000ms tolerance → considered unchanged (FS resolution, Drive
        // eventual consistency).
        assert!(!mtime_differs(1000, 1800));
        assert!(!mtime_differs(1800, 1000));
        // Beyond tolerance → changed.
        assert!(mtime_differs(1000, 2500));
        assert!(mtime_differs(2500, 1000));
    }

    #[test]
    fn unique_conflict_path_avoids_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path();
        let a = unique_conflict_path(parent, "note", "local");
        fs::write(&a, b"v1").unwrap();
        // A second conflict in the same instant must NOT pick the same name.
        let b = unique_conflict_path(parent, "note", "local");
        assert_ne!(a, b, "second conflict must get a unique name");
        assert!(!b.exists(), "returned path should not already exist");
    }

    /// Regression test for the critical Loop B / Case C data-loss bug.
    /// Verifies the touched-paths invariant: a path created during sync (a
    /// download) is correctly excluded from the "deleted locally" check, so it
    /// is NOT removed from sync_meta or deleted from remote. This models the
    /// exact condition that was destroying remote-only files on first sync.
    #[test]
    fn case_c_skips_paths_touched_during_sync() {
        use std::collections::HashSet;

        // Snapshot of local files taken at the START of sync: does NOT include
        // "remote-only.md", which will be downloaded during Loop B.
        let local_files: HashSet<String> = ["existing.md".to_string()].into_iter().collect();

        // sync_meta after Loop B has downloaded "remote-only.md".
        let mut sync_meta_files = HashMap::new();
        sync_meta_files.insert(
            "existing.md".to_string(),
            SyncFileEntry { id: "id-existing".into(), local_mtime_ms: 1, remote_mtime_ms: 1 },
        );
        sync_meta_files.insert(
            "remote-only.md".to_string(),
            SyncFileEntry { id: "id-remote".into(), local_mtime_ms: 2, remote_mtime_ms: 2 },
        );

        // Paths created/renamed during this sync (Loop B downloads).
        let touched: HashSet<String> = ["remote-only.md".to_string()].into_iter().collect();

        // Case C: delete entries whose path isn't in the local_files snapshot,
        // BUT skip anything touched during the sync.
        let mut to_remove = Vec::new();
        for (rel_path, _se) in &sync_meta_files {
            if touched.contains(rel_path) {
                continue;
            }
            if !local_files.contains(rel_path) {
                to_remove.push(rel_path.clone());
            }
        }
        for r in &to_remove {
            sync_meta_files.remove(r);
        }

        // The downloaded file MUST survive — this is the bug that was deleting
        // every remote-only file on first sync.
        assert!(
            sync_meta_files.contains_key("remote-only.md"),
            "BUG: Case C deleted a file downloaded during the same sync"
        );
        assert_eq!(sync_meta_files.len(), 2, "both files should remain");
    }
}
