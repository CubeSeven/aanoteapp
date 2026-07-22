#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fs_commands;
mod gdrive;

use fs_commands::*;
use gdrive::*;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_directory,
            read_note,
            save_note,
            move_node,
            create_note,
            create_folder,
            search_notes,
            delete_node,
            gdrive_status,
            gdrive_login,
            gdrive_logout,
            gdrive_sync,
            gdrive_reset_sync,
            open_external_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
