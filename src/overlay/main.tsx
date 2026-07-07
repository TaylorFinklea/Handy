import React from "react";
import ReactDOM from "react-dom/client";
import RecordingOverlay from "./RecordingOverlay";
import "@/i18n";
import { applyTheme, readCachedThemePreference } from "@/lib/themes";

// The overlay is its own window; apply the cached theme so its --color-* tokens
// match the chosen theme instead of falling back to the bare-:root default.
applyTheme(readCachedThemePreference());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RecordingOverlay />
  </React.StrictMode>,
);
