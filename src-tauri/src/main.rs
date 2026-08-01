#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fs_commands;
mod gdrive;

use fs_commands::*;
use gdrive::*;
use std::sync::Mutex;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(gdrive::SyncState {
            in_progress: Mutex::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            // filesystem
            scan_directory,
            read_note,
            save_note,
            save_note_if_unchanged,
            file_mtime,
            move_node,
            create_note,
            create_folder,
            search_notes,
            search_notes_snippet,
            delete_node,
            trash_node,
            restore_from_trash,
            empty_trash,
            list_recent,
            open_external_url,
            // google drive
            gdrive_status,
            gdrive_login,
            gdrive_logout,
            gdrive_sync,
            gdrive_reset_sync,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
