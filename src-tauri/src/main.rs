#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fs_commands;

use fs_commands::*;

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
