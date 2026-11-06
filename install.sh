#!/usr/bin/env bash
#
# Install the BulkDeleteDm plugin into a Vencord install.
#
# There is no runtime plugin folder in Vencord, so a user plugin has to be
# compiled into the Vencord bundle. This script does that for you:
#
#   1. clone Vencord at the version you already run
#   2. drop this plugin into src/userplugins/bulkDeleteDm/
#   3. build it
#   4. install the result over your current Vencord
#
# Usage:
#   ./install.sh                     # auto-detect the install type
#   ./install.sh --standalone        # Discord for Mac (standalone Vencord)
#   ./install.sh --regular           # regular Vencord (Windows/Linux/Mac installer)
#   ./install.sh --help
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$HERE/src/userplugins/bulkDeleteDm/index.tsx"
CLONE="${VENCORD_CLONE:-$HOME/vencord-bulk-delete-dm-build}"
REPO="https://github.com/Vendicated/Vencord.git"
MODE="auto"

while [ $# -gt 0 ]; do
    case "$1" in
        --standalone) MODE="standalone" ;;
        --regular) MODE="regular" ;;
        --help|-h)
            sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
    esac
    shift
done

command -v git >/dev/null || { echo "ERROR: git is required" >&2; exit 1; }
command -v node >/dev/null || { echo "ERROR: node is required" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "ERROR: pnpm is required (https://pnpm.io/installation)" >&2; exit 1; }
[ -f "$PLUGIN_SRC" ] || { echo "ERROR: plugin source not found at $PLUGIN_SRC" >&2; exit 1; }

# ---------------------------------------------------------------- detect ----
DATA_DIR="${VENCORD_USER_DATA_DIR:-$HOME/Library/Application Support/Vencord}"

if [ "$MODE" = "auto" ]; then
    if [ -d "$DATA_DIR/dist" ]; then
        MODE="standalone"
    else
        MODE="regular"
    fi
    echo "==> Detected install type: $MODE"
fi

# ----------------------------------------------------------------- clone ----
if [ ! -d "$CLONE/.git" ]; then
    echo "==> Cloning Vencord into $CLONE"
    git clone "$REPO" "$CLONE"
fi

cd "$CLONE"

# Prefer the exact commit your installed Vencord was built from, so the
# rebuild differs only by this plugin. Read it from the installed bundle.
TARGET_COMMIT=""
if [ "$MODE" = "standalone" ] && [ -f "$DATA_DIR/dist/renderer.js" ]; then
    TARGET_COMMIT="$(grep -o 'Vencord v[0-9.]*[^"]*"' "$DATA_DIR/dist/renderer.js" 2>/dev/null | head -1 | grep -oE '[0-9a-f]{7,40}' || true)"
fi

git fetch --all --tags --quiet

if [ -n "$TARGET_COMMIT" ] && git cat-file -e "$TARGET_COMMIT^{commit}" 2>/dev/null; then
    echo "==> Using commit $TARGET_COMMIT"
    git checkout --quiet "$TARGET_COMMIT"
else
    echo "==> Using latest Vencord ($(git rev-parse --short origin/main))"
    git checkout --quiet origin/main
fi

# ---------------------------------------------------------------- plugin ----
echo "==> Installing plugin into src/userplugins/bulkDeleteDm"
mkdir -p src/userplugins/bulkDeleteDm
cp "$PLUGIN_SRC" src/userplugins/bulkDeleteDm/index.tsx

# ----------------------------------------------------------------- build ----
if [ ! -d node_modules ]; then
    echo "==> Installing dependencies (this takes a few minutes)"
    pnpm install --frozen-lockfile
fi

echo "==> Building Vencord (this takes a few minutes)"
if [ "$MODE" = "standalone" ]; then
    pnpm build --standalone
else
    pnpm build
fi

# ---------------------------------------------------------------- install ---
if [ "$MODE" = "standalone" ]; then
    DIST="$DATA_DIR/dist"
    [ -d "$DIST" ] || { echo "ERROR: $DIST not found" >&2; exit 1; }

    echo "==> Backing up current renderer"
    cp -p "$DIST/renderer.js" "$DIST/renderer.js.bak"
    [ -f "$DIST/renderer.js.map" ] && cp -p "$DIST/renderer.js.map" "$DIST/renderer.js.map.bak" || true

    echo "==> Installing"
    cp -p dist/renderer.js "$DIST/renderer.js"
    cp -p dist/renderer.js.map "$DIST/renderer.js.map" 2>/dev/null || true
    cp -p dist/renderer.js.LEGAL.txt "$DIST/renderer.js.LEGAL.txt" 2>/dev/null || true

    cat <<'EOF'

==> Done. Restart Discord (Cmd+Q, then reopen).

    Note: Vencord's auto-updater replaces renderer.js with the official
    build, which does not contain this plugin. Re-run this script after a
    Vencord update.

EOF
else
    echo "==> Installing into Discord via the Vencord installer"
    pnpm inject

    cat <<'EOF'

==> Done. Restart Discord.

    Note: if Vencord auto-updates, re-run this script to rebuild.

EOF
fi
