import React from "react";
import ReactDOM from "react-dom/client";
import { platform } from "@tauri-apps/plugin-os";
import App from "./App";
import { applyTheme, readCachedThemePreference } from "./lib/themes";

// Set platform before render so CSS can scope per-platform (e.g. scrollbar styles)
document.documentElement.dataset.platform = platform();

// Apply the cached theme synchronously, before first paint, to avoid a flash of
// the wrong theme. useTheme (mounted in App) reconciles this with the persisted
// setting once it loads and keeps localStorage in sync.
applyTheme(readCachedThemePreference());

// Initialize i18n
import "./i18n";

// Initialize model store (loads models and sets up event listeners)
import { useModelStore } from "./stores/modelStore";
useModelStore.getState().initialize();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
