import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { PlayIcon, FolderOpenIcon, XIcon } from "lucide-react";
import { Button } from "../ui/Button";
import { Dropdown, DropdownOption } from "../ui/Dropdown";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSettings } from "../../hooks/useSettings";
import type { SoundTheme } from "@/bindings";

const AUDIO_EXTENSIONS = ["wav", "mp3", "flac", "ogg"];

type Slot = "start" | "stop";

const SLOTS: {
  slot: Slot;
  themeKey: "start_sound" | "stop_sound";
  fileKey: "custom_start_sound" | "custom_stop_sound";
}[] = [
  { slot: "start", themeKey: "start_sound", fileKey: "custom_start_sound" },
  { slot: "stop", themeKey: "stop_sound", fileKey: "custom_stop_sound" },
];

const hasAudioExtension = (path: string): boolean => {
  const ext = path.split(".").pop()?.toLowerCase();
  return !!ext && AUDIO_EXTENSIONS.includes(ext);
};

interface SoundPickerProps {
  grouped?: boolean;
  descriptionMode?: "inline" | "tooltip";
  disabled?: boolean;
}

export const SoundPicker: React.FC<SoundPickerProps> = ({
  grouped = true,
  descriptionMode = "tooltip",
  disabled = false,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting } = useSettings();
  const playTestSound = useSettingsStore((state) => state.playTestSound);
  const setCustomSound = useSettingsStore((state) => state.setCustomSound);
  const clearCustomSound = useSettingsStore((state) => state.clearCustomSound);

  const [dragSlot, setDragSlot] = useState<Slot | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Slot, string>>>({});

  // Latest disabled flag for the drag-drop listener, which is registered once.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const themeOptions: DropdownOption[] = [
    { value: "handpan", label: t("settings.sound.theme.handpan") },
    { value: "marimba", label: t("settings.sound.theme.marimba") },
    { value: "pop", label: t("settings.sound.theme.pop") },
    { value: "custom", label: t("settings.sound.theme.custom") },
  ];

  const importSound = async (slot: Slot, path: string) => {
    if (!hasAudioExtension(path)) {
      setErrors((e) => ({
        ...e,
        [slot]: t("settings.sound.unsupportedFormat"),
      }));
      return;
    }
    try {
      await setCustomSound(slot, path);
      setErrors((e) => ({ ...e, [slot]: undefined }));
    } catch (err) {
      setErrors((e) => ({ ...e, [slot]: String(err) }));
    }
  };

  const chooseFile = async (slot: Slot) => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
    });
    if (typeof selected === "string") {
      await importSound(slot, selected);
    }
    // A cancelled picker leaves the setting untouched, so the dropdown reverts.
  };

  const handleThemeSelect = async (
    slot: Slot,
    themeKey: "start_sound" | "stop_sound",
    fileKey: "custom_start_sound" | "custom_stop_sound",
    value: string,
  ) => {
    if (value === "custom") {
      // Reuse an already-imported file; otherwise prompt for one.
      if (getSetting(fileKey)) {
        await updateSetting(themeKey, "custom" as SoundTheme);
      } else {
        await chooseFile(slot);
      }
    } else {
      await updateSetting(themeKey, value as SoundTheme);
    }
  };

  const resetSlot = async (slot: Slot) => {
    try {
      await clearCustomSound(slot);
      setErrors((e) => ({ ...e, [slot]: undefined }));
    } catch (err) {
      setErrors((e) => ({ ...e, [slot]: String(err) }));
    }
  };

  // Native drag-drop: a webview-global event carrying real filesystem paths and a
  // physical-pixel cursor position. Hit-test the position against the slot rows to
  // route the drop to the slot under the cursor.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const slotAt = (x: number, y: number): Slot | null => {
      const dpr = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(x / dpr, y / dpr);
      const marked = el?.closest("[data-sound-slot]");
      const slot = marked?.getAttribute("data-sound-slot");
      return slot === "start" || slot === "stop" ? slot : null;
    };

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disabledRef.current) {
          setDragSlot(null);
          return;
        }
        const payload = event.payload;
        if (payload.type === "over") {
          setDragSlot(slotAt(payload.position.x, payload.position.y));
        } else if (payload.type === "drop") {
          const slot = slotAt(payload.position.x, payload.position.y);
          setDragSlot(null);
          if (slot) {
            const path =
              payload.paths.find(hasAudioExtension) ?? payload.paths[0];
            if (path) {
              void importSound(slot, path);
            }
          }
        } else {
          setDragSlot(null);
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // Registered once; importSound reads current state via store setters.
  }, []);

  return (
    <>
      {SLOTS.map(({ slot, themeKey, fileKey }) => {
        const theme = getSetting(themeKey) ?? "marimba";
        const fileName = getSetting(fileKey) ?? undefined;
        const isCustom = theme === "custom";
        const error = errors[slot];

        return (
          <SettingContainer
            key={slot}
            title={t(`settings.sound.${slot}Sound.label`)}
            description={error ?? t(`settings.sound.${slot}Sound.description`)}
            grouped={grouped}
            descriptionMode={error ? "inline" : descriptionMode}
            layout="horizontal"
            disabled={disabled}
          >
            <div
              data-sound-slot={slot}
              className={`flex items-center gap-2 rounded-md transition-colors ${
                dragSlot === slot
                  ? "ring-2 ring-logo-primary/60 bg-logo-primary/5"
                  : ""
              }`}
              title={
                isCustom && fileName ? fileName : t("settings.sound.dropHint")
              }
            >
              {isCustom && fileName && (
                <span className="max-w-[8rem] truncate text-xs text-text/70">
                  {fileName}
                </span>
              )}
              <Dropdown
                selectedValue={theme}
                onSelect={(value) =>
                  handleThemeSelect(slot, themeKey, fileKey, value)
                }
                options={themeOptions}
                disabled={disabled}
              />
              {isCustom && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => chooseFile(slot)}
                    disabled={disabled}
                    title={t("settings.sound.chooseFile")}
                  >
                    <FolderOpenIcon className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => resetSlot(slot)}
                    disabled={disabled}
                    title={t("settings.sound.reset")}
                  >
                    <XIcon className="h-4 w-4" />
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => playTestSound(slot)}
                disabled={disabled}
                title={t("settings.sound.preview")}
              >
                <PlayIcon className="h-4 w-4" />
              </Button>
            </div>
          </SettingContainer>
        );
      })}
    </>
  );
};
