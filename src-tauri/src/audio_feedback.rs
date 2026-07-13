use crate::settings::SoundTheme;
use crate::settings::{self, AppSettings};
use cpal::traits::{DeviceTrait, HostTrait};
use log::{debug, error, warn};
use rodio::OutputStreamBuilder;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::thread;
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy)]
pub enum SoundType {
    Start,
    Stop,
}

impl SoundType {
    /// The built-in resource path for `theme` in this slot.
    fn builtin_path(self, theme: SoundTheme) -> String {
        match self {
            SoundType::Start => theme.to_start_path(),
            SoundType::Stop => theme.to_stop_path(),
        }
    }
}

/// The theme selected for a slot and its imported custom filename (if any).
fn slot_sound(settings: &AppSettings, sound_type: SoundType) -> (SoundTheme, Option<&String>) {
    match sound_type {
        SoundType::Start => (settings.start_sound, settings.custom_start_sound.as_ref()),
        SoundType::Stop => (settings.stop_sound, settings.custom_stop_sound.as_ref()),
    }
}

fn resolve_sound_path(
    app: &AppHandle,
    settings: &AppSettings,
    sound_type: SoundType,
) -> Option<PathBuf> {
    let (theme, custom) = slot_sound(settings, sound_type);

    if theme == SoundTheme::Custom {
        // Use the imported file when it is set and still present on disk;
        // otherwise fall back to the default built-in sound for this slot.
        if let Some(name) = custom {
            if let Ok(path) = crate::portable::resolve_app_data(app, name) {
                if path.exists() {
                    return Some(path);
                }
            }
        }
        let fallback = sound_type.builtin_path(SoundTheme::Marimba);
        return app
            .path()
            .resolve(&fallback, tauri::path::BaseDirectory::Resource)
            .ok();
    }

    let sound_file = sound_type.builtin_path(theme);
    app.path()
        .resolve(&sound_file, tauri::path::BaseDirectory::Resource)
        .ok()
}

pub fn play_feedback_sound(app: &AppHandle, sound_type: SoundType) {
    let settings = settings::get_settings(app);
    if !settings.audio_feedback {
        return;
    }
    if let Some(path) = resolve_sound_path(app, &settings, sound_type) {
        play_sound_async(app, path);
    }
}

pub fn play_feedback_sound_blocking(app: &AppHandle, sound_type: SoundType) {
    let settings = settings::get_settings(app);
    if !settings.audio_feedback {
        return;
    }
    if let Some(path) = resolve_sound_path(app, &settings, sound_type) {
        play_sound_blocking(app, &path);
    }
}

pub fn play_test_sound(app: &AppHandle, sound_type: SoundType) {
    let settings = settings::get_settings(app);
    if let Some(path) = resolve_sound_path(app, &settings, sound_type) {
        play_sound_blocking(app, &path);
    }
}

fn play_sound_async(app: &AppHandle, path: PathBuf) {
    let app_handle = app.clone();
    thread::spawn(move || {
        if let Err(e) = play_sound_at_path(&app_handle, path.as_path()) {
            error!("Failed to play sound '{}': {}", path.display(), e);
        }
    });
}

fn play_sound_blocking(app: &AppHandle, path: &Path) {
    if let Err(e) = play_sound_at_path(app, path) {
        error!("Failed to play sound '{}': {}", path.display(), e);
    }
}

fn play_sound_at_path(app: &AppHandle, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let settings = settings::get_settings(app);
    let volume = settings.audio_feedback_volume;
    let selected_device = settings.selected_output_device.clone();
    play_audio_file(path, selected_device, volume)
}

fn play_audio_file(
    path: &std::path::Path,
    selected_device: Option<String>,
    volume: f32,
) -> Result<(), Box<dyn std::error::Error>> {
    let stream_builder = if let Some(device_name) = selected_device {
        if device_name == "Default" {
            debug!("Using default device");
            OutputStreamBuilder::from_default_device()?
        } else {
            let host = crate::audio_toolkit::get_cpal_host();
            let devices = host.output_devices()?;

            let mut found_device = None;
            for device in devices {
                if device.name()? == device_name {
                    found_device = Some(device);
                    break;
                }
            }

            match found_device {
                Some(device) => OutputStreamBuilder::from_device(device)?,
                None => {
                    warn!("Device '{}' not found, using default device", device_name);
                    OutputStreamBuilder::from_default_device()?
                }
            }
        }
    } else {
        debug!("Using default device");
        OutputStreamBuilder::from_default_device()?
    };

    let stream_handle = stream_builder.open_stream()?;
    let mixer = stream_handle.mixer();

    let file = File::open(path)?;
    let buf_reader = BufReader::new(file);

    let sink = rodio::play(mixer, buf_reader)?;
    sink.set_volume(volume);
    sink.sleep_until_end();

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::get_default_settings;

    #[test]
    fn builtin_path_matches_theme_and_slot() {
        assert_eq!(
            SoundType::Start.builtin_path(SoundTheme::Pop),
            "resources/pop_start.wav"
        );
        assert_eq!(
            SoundType::Stop.builtin_path(SoundTheme::Marimba),
            "resources/marimba_stop.wav"
        );
    }

    #[test]
    fn slot_sound_reads_slots_independently() {
        let mut s = get_default_settings();
        s.start_sound = SoundTheme::Custom;
        s.custom_start_sound = Some("custom_start.mp3".to_string());
        s.stop_sound = SoundTheme::Pop;
        s.custom_stop_sound = None;

        let (start_theme, start_custom) = slot_sound(&s, SoundType::Start);
        assert_eq!(start_theme, SoundTheme::Custom);
        assert_eq!(start_custom.map(String::as_str), Some("custom_start.mp3"));

        let (stop_theme, stop_custom) = slot_sound(&s, SoundType::Stop);
        assert_eq!(stop_theme, SoundTheme::Pop);
        assert_eq!(stop_custom, None);
    }
}
