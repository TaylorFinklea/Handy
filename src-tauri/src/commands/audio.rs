use crate::audio_feedback;
use crate::audio_toolkit::audio::{list_input_devices, list_output_devices};
use crate::managers::audio::{AudioRecordingManager, MicrophoneMode};
use crate::settings::{get_settings, write_settings, SoundTheme};
use log::warn;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use winreg::{
    enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
    RegKey, HKEY,
};

/// Audio formats accepted for custom feedback sounds. `rodio` can decode all of
/// these; files are copied as-is and stored with their original extension.
const ALLOWED_SOUND_EXTENSIONS: [&str; 4] = ["wav", "mp3", "flac", "ogg"];

/// Upper bound on an imported sound file. Start/stop cues are short; this rejects
/// accidental imports of large media while leaving ample headroom.
const MAX_CUSTOM_SOUND_BYTES: u64 = 5 * 1024 * 1024;

/// Normalize the `sound_type` argument shared by the custom-sound commands.
fn parse_sound_slot(sound_type: &str) -> Result<&'static str, String> {
    match sound_type {
        "start" => Ok("start"),
        "stop" => Ok("stop"),
        other => Err(format!("Unknown sound type: {}", other)),
    }
}

/// Remove previously-imported custom files for a slot. `keep_ext` (the extension
/// just written) is skipped so a fresh import isn't deleted while clearing stale
/// files left by an earlier import in a different container.
fn remove_custom_sound_files(app: &AppHandle, slot: &str, keep_ext: Option<&str>) {
    for ext in ALLOWED_SOUND_EXTENSIONS {
        if keep_ext == Some(ext) {
            continue;
        }
        if let Ok(path) =
            crate::portable::resolve_app_data(app, &format!("custom_{}.{}", slot, ext))
        {
            let _ = fs::remove_file(path);
        }
    }
}

/// Import a user-selected audio file as the custom sound for a slot ("start" or
/// "stop"). Validates the format, copies it into the app data dir as
/// `custom_{slot}.{ext}`, and points the slot at it. Returns the stored filename.
#[tauri::command]
#[specta::specta]
pub fn set_custom_sound(
    app: AppHandle,
    sound_type: String,
    source_path: String,
) -> Result<String, String> {
    let slot = parse_sound_slot(&sound_type)?;
    let source = Path::new(&source_path);

    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or_else(|| "The selected file has no extension.".to_string())?;
    if !ALLOWED_SOUND_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "Unsupported format \".{}\". Use WAV, MP3, FLAC, or OGG.",
            ext
        ));
    }

    let metadata =
        fs::metadata(source).map_err(|e| format!("Couldn't read the selected file: {}", e))?;
    if !metadata.is_file() {
        return Err("The selected path is not a file.".to_string());
    }
    if metadata.len() > MAX_CUSTOM_SOUND_BYTES {
        return Err("That file is too large (max 5 MB).".to_string());
    }

    // Confirm the file actually decodes before we adopt it, so a corrupt or
    // mislabeled file fails here instead of silently during playback.
    {
        let file = fs::File::open(source)
            .map_err(|e| format!("Couldn't open the selected file: {}", e))?;
        rodio::Decoder::new(std::io::BufReader::new(file))
            .map_err(|_| "That file isn't a playable audio file.".to_string())?;
    }

    let dest_name = format!("custom_{}.{}", slot, ext);
    let dest = crate::portable::resolve_app_data(&app, &dest_name).map_err(|e| e.to_string())?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Couldn't prepare the sounds folder: {}", e))?;
    }

    // Copy to a temporary file, then atomically rename it into place. A failed or
    // partial copy therefore never destroys the slot's existing sound and never
    // leaves a truncated file at the live path (which the resolver, checking only
    // existence, would otherwise play). This also handles source == dest, since the
    // copy reads the source before anything at the destination is replaced.
    let tmp = dest.with_file_name(format!(".{}.tmp", dest_name));
    fs::copy(source, &tmp).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Couldn't save the sound: {}", e)
    })?;
    fs::rename(&tmp, &dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Couldn't save the sound: {}", e)
    })?;
    // The new file is safely in place; drop any stale file for this slot that used
    // a different format.
    remove_custom_sound_files(&app, slot, Some(ext.as_str()));

    let mut settings = get_settings(&app);
    match slot {
        "start" => {
            settings.start_sound = SoundTheme::Custom;
            settings.custom_start_sound = Some(dest_name.clone());
        }
        _ => {
            settings.stop_sound = SoundTheme::Custom;
            settings.custom_stop_sound = Some(dest_name.clone());
        }
    }
    write_settings(&app, settings);

    Ok(dest_name)
}

/// Clear a slot's custom sound: delete the stored file and reset the slot back to
/// the default built-in theme.
#[tauri::command]
#[specta::specta]
pub fn clear_custom_sound(app: AppHandle, sound_type: String) -> Result<(), String> {
    let slot = parse_sound_slot(&sound_type)?;
    remove_custom_sound_files(&app, slot, None);

    let mut settings = get_settings(&app);
    match slot {
        "start" => {
            settings.start_sound = SoundTheme::Tone;
            settings.custom_start_sound = None;
        }
        _ => {
            settings.stop_sound = SoundTheme::Tone;
            settings.custom_stop_sound = None;
        }
    }
    write_settings(&app, settings);

    Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct AudioDevice {
    pub index: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum PermissionAccess {
    Allowed,
    Denied,
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct WindowsMicrophonePermissionStatus {
    pub supported: bool,
    pub overall_access: PermissionAccess,
    pub device_access: PermissionAccess,
    pub app_access: PermissionAccess,
    pub desktop_app_access: PermissionAccess,
}

#[cfg(target_os = "windows")]
fn read_registry_permission_access(root_hkey: HKEY, path: &str) -> PermissionAccess {
    let root = RegKey::predef(root_hkey);
    let Ok(key) = root.open_subkey(path) else {
        return PermissionAccess::Unknown;
    };

    let Ok(value) = key.get_value::<String, _>("Value") else {
        return PermissionAccess::Unknown;
    };

    match value.to_ascii_lowercase().as_str() {
        "allow" => PermissionAccess::Allowed,
        "deny" => PermissionAccess::Denied,
        _ => PermissionAccess::Unknown,
    }
}

#[cfg(target_os = "windows")]
fn get_windows_microphone_permission_status_impl() -> WindowsMicrophonePermissionStatus {
    const MICROPHONE_PATH: &str =
        "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
    const DESKTOP_APPS_PATH: &str =
        "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged";

    let device_access = read_registry_permission_access(HKEY_LOCAL_MACHINE, MICROPHONE_PATH);
    let app_access = read_registry_permission_access(HKEY_CURRENT_USER, MICROPHONE_PATH);
    let desktop_app_access = read_registry_permission_access(HKEY_CURRENT_USER, DESKTOP_APPS_PATH);

    let overall_access = if [device_access, app_access, desktop_app_access]
        .into_iter()
        .any(|access| access == PermissionAccess::Denied)
    {
        PermissionAccess::Denied
    } else if [device_access, app_access, desktop_app_access]
        .into_iter()
        .all(|access| access == PermissionAccess::Allowed)
    {
        PermissionAccess::Allowed
    } else {
        PermissionAccess::Unknown
    };

    WindowsMicrophonePermissionStatus {
        supported: true,
        overall_access,
        device_access,
        app_access,
        desktop_app_access,
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_windows_microphone_permission_status() -> WindowsMicrophonePermissionStatus {
    #[cfg(target_os = "windows")]
    {
        get_windows_microphone_permission_status_impl()
    }

    #[cfg(not(target_os = "windows"))]
    {
        WindowsMicrophonePermissionStatus {
            supported: false,
            overall_access: PermissionAccess::Unknown,
            device_access: PermissionAccess::Unknown,
            app_access: PermissionAccess::Unknown,
            desktop_app_access: PermissionAccess::Unknown,
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn open_microphone_privacy_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:privacy-microphone"])
            .spawn()
            .map_err(|e| format!("Failed to open Windows microphone privacy settings: {}", e))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Opening microphone privacy settings is only supported on Windows".to_string())
    }
}

#[tauri::command]
#[specta::specta]
pub fn update_microphone_mode(app: AppHandle, always_on: bool) -> Result<(), String> {
    // Update settings
    let mut settings = get_settings(&app);
    settings.always_on_microphone = always_on;
    write_settings(&app, settings);

    // Update the audio manager mode
    let rm = app.state::<Arc<AudioRecordingManager>>();
    let new_mode = if always_on {
        MicrophoneMode::AlwaysOn
    } else {
        MicrophoneMode::OnDemand
    };

    rm.update_mode(new_mode)
        .map_err(|e| format!("Failed to update microphone mode: {}", e))
}

#[tauri::command]
#[specta::specta]
pub fn get_microphone_mode(app: AppHandle) -> Result<bool, String> {
    let settings = get_settings(&app);
    Ok(settings.always_on_microphone)
}

#[tauri::command]
#[specta::specta]
pub fn get_available_microphones() -> Result<Vec<AudioDevice>, String> {
    let devices =
        list_input_devices().map_err(|e| format!("Failed to list audio devices: {}", e))?;

    let mut result = vec![AudioDevice {
        index: "default".to_string(),
        name: "Default".to_string(),
        is_default: true,
    }];

    result.extend(devices.into_iter().map(|d| AudioDevice {
        index: d.index,
        name: d.name,
        is_default: false, // The explicit default is handled separately
    }));

    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn set_selected_microphone(app: AppHandle, device_name: String) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.selected_microphone = if device_name == "default" {
        None
    } else {
        Some(device_name)
    };
    write_settings(&app, settings);

    // Update the audio manager to use the new device
    let rm = app.state::<Arc<AudioRecordingManager>>();
    rm.update_selected_device()
        .map_err(|e| format!("Failed to update selected device: {}", e))?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_selected_microphone(app: AppHandle) -> Result<String, String> {
    let settings = get_settings(&app);
    Ok(settings
        .selected_microphone
        .unwrap_or_else(|| "default".to_string()))
}

#[tauri::command]
#[specta::specta]
pub fn get_available_output_devices() -> Result<Vec<AudioDevice>, String> {
    let devices =
        list_output_devices().map_err(|e| format!("Failed to list output devices: {}", e))?;

    let mut result = vec![AudioDevice {
        index: "default".to_string(),
        name: "Default".to_string(),
        is_default: true,
    }];

    result.extend(devices.into_iter().map(|d| AudioDevice {
        index: d.index,
        name: d.name,
        is_default: false, // The explicit default is handled separately
    }));

    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn set_selected_output_device(app: AppHandle, device_name: String) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.selected_output_device = if device_name == "default" {
        None
    } else {
        Some(device_name)
    };
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_selected_output_device(app: AppHandle) -> Result<String, String> {
    let settings = get_settings(&app);
    Ok(settings
        .selected_output_device
        .unwrap_or_else(|| "default".to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn play_test_sound(app: AppHandle, sound_type: String) {
    let sound = match sound_type.as_str() {
        "start" => audio_feedback::SoundType::Start,
        "stop" => audio_feedback::SoundType::Stop,
        _ => {
            warn!("Unknown sound type: {}", sound_type);
            return;
        }
    };
    audio_feedback::play_test_sound(&app, sound);
}

#[tauri::command]
#[specta::specta]
pub fn set_clamshell_microphone(app: AppHandle, device_name: String) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.clamshell_microphone = if device_name == "default" {
        None
    } else {
        Some(device_name)
    };
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_clamshell_microphone(app: AppHandle) -> Result<String, String> {
    let settings = get_settings(&app);
    Ok(settings
        .clamshell_microphone
        .unwrap_or_else(|| "default".to_string()))
}

#[tauri::command]
#[specta::specta]
pub fn is_recording(app: AppHandle) -> bool {
    let audio_manager = app.state::<Arc<AudioRecordingManager>>();
    audio_manager.is_recording()
}
