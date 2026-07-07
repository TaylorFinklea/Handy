import React from "react";
import { useTranslation } from "react-i18next";
import { Dropdown, DropdownOption } from "../ui/Dropdown";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import {
  THEME_OPTIONS,
  THEMES,
  SYSTEM_THEME,
  DEFAULT_THEME,
} from "../../lib/themes";

interface ThemeSelectorProps {
  grouped?: boolean;
  descriptionMode?: "inline" | "tooltip";
}

export const ThemeSelector: React.FC<ThemeSelectorProps> = ({
  grouped = true,
  descriptionMode = "tooltip",
}) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting } = useSettings();
  const selected = getSetting("theme") ?? DEFAULT_THEME;

  const options: DropdownOption[] = THEME_OPTIONS.map(({ id }) => ({
    value: id,
    // Theme names are proper nouns from the registry; only "System" is translated.
    label:
      id === SYSTEM_THEME
        ? t("settings.theme.system")
        : (THEMES.find((theme) => theme.id === id)?.label ?? id),
  }));

  return (
    <SettingContainer
      title={t("settings.theme.label")}
      description={t("settings.theme.description")}
      grouped={grouped}
      descriptionMode={descriptionMode}
      layout="horizontal"
    >
      <Dropdown
        selectedValue={selected}
        onSelect={(value) => updateSetting("theme", value)}
        options={options}
      />
    </SettingContainer>
  );
};
