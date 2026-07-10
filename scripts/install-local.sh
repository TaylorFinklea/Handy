#!/usr/bin/env bash
#
# Build Handy signed with a stable identity and install it to /Applications.
#
# Why this exists: tauri.conf.json uses `signingIdentity: "-"` (ad-hoc). An ad-hoc
# signature changes on every build, so macOS sees each update as a different app and
# makes you re-grant Accessibility/Microphone. Signing with a stable Developer ID
# keeps the app's designated requirement constant, so those grants survive updates.
#
# Usage: bun run install:local
#
#   APPLE_SIGNING_IDENTITY   override the auto-detected "Developer ID Application"
#   HANDY_NO_LAUNCH=1        install without relaunching Handy afterwards

# No `set -e`: `tauri build` exits non-zero on a benign updater-signing failure.
# Every critical step is checked explicitly instead.
set -uo pipefail

APP_NAME="Handy"
BUNDLE="src-tauri/target/release/bundle/macos/${APP_NAME}.app"
DEST="/Applications/${APP_NAME}.app"

die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

[ "$(uname -s)" = "Darwin" ] || die "install:local is macOS-only."
cd "$(dirname "$0")/.." || die "cannot find repo root"

# 1. Resolve a STABLE signing identity. Never fall back to ad-hoc ("-") — that is
#    precisely what makes macOS forget permissions on every update.
if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  APPLE_SIGNING_IDENTITY=$(security find-identity -v -p codesigning |
    sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)
fi
[ -n "${APPLE_SIGNING_IDENTITY:-}" ] || die "no 'Developer ID Application' identity in your keychain.
       Set APPLE_SIGNING_IDENTITY to a stable identity — otherwise the app would be
       ad-hoc signed and macOS would reset its permissions on every update."
export APPLE_SIGNING_IDENTITY
info "signing identity: ${APPLE_SIGNING_IDENTITY}"

# 2. Build. `tauri build` exits 1 when it cannot sign the auto-updater artifact
#    (TAURI_SIGNING_PRIVATE_KEY is unset) even though the .app built fine, so judge
#    success by the artifact, not the exit code.
info "building release app (first build takes a while; later ones are cached)…"
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri build --bundles app
[ -d "$BUNDLE" ] || die "build failed: ${BUNDLE} was not produced"

# 3. Verify the signature is real and stable BEFORE installing it.
codesign --verify --deep --strict "$BUNDLE" ||
  die "built app failed signature verification"
authority=$(codesign -dvv "$BUNDLE" 2>&1 | sed -n 's/^Authority=//p' | head -1)
case "$authority" in
"Developer ID Application: "* | "Apple Development: "*) ;;
*) die "refusing to install: app is ad-hoc/unsigned (authority: '${authority:-none}').
       macOS would reset its permissions on every update." ;;
esac
info "signed by: ${authority}"

# 4. A running app must exit before its bundle is replaced.
if pgrep -x handy >/dev/null; then
  info "quitting running ${APP_NAME}…"
  osascript -e "quit app \"${APP_NAME}\"" >/dev/null 2>&1 || true
  for _ in $(seq 1 15); do
    pgrep -x handy >/dev/null || break
    sleep 1
  done
  pgrep -x handy >/dev/null && die "${APP_NAME} is still running; quit it and retry"
fi

info "installing → ${DEST}"
ditto "$BUNDLE" "$DEST" || die "failed to copy into /Applications"
codesign --verify --deep --strict "$DEST" ||
  die "installed app failed signature verification"

version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$DEST/Contents/Info.plist" 2>/dev/null)
info "installed ${APP_NAME} ${version:-?} — permissions persist across updates"

if [ -z "${HANDY_NO_LAUNCH:-}" ]; then
  info "launching…"
  open "$DEST"
fi
