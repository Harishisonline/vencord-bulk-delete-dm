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
PLUGIN_NAME="BulkDeleteDm"
PLUGIN_DIR="bulkDeleteDm"
PLUGIN_SRC="$HERE/src/userplugins/$PLUGIN_DIR/index.tsx"
CLONE="${VENCORD_CLONE:-$HOME/vencord-dm-plugins-build}"
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

# Prefer the exact Vencord version your installed build was made from, so the
# rebuild differs only by this plugin. The standalone bundle embeds its
# version as `Vencord:v1.15.16`.
TARGET_VERSION=""
if [ "$MODE" = "standalone" ] && [ -f "$DATA_DIR/dist/renderer.js" ]; then
    TARGET_VERSION="$(grep -oE 'Vencord:`v[0-9]+\.[0-9]+\.[0-9]+' "$DATA_DIR/dist/renderer.js" 2>/dev/null | head -1 | sed 's/^Vencord:`//' || true)"
fi

git fetch --all --tags --quiet

if [ -n "$TARGET_VERSION" ] && git rev-parse -q --verify "refs/tags/$TARGET_VERSION" >/dev/null; then
    echo "==> Using Vencord $TARGET_VERSION (matches your installed build)"
    git checkout --quiet "refs/tags/$TARGET_VERSION"
elif [ -n "$TARGET_VERSION" ]; then
    echo "==> Vencord $TARGET_VERSION not found as a tag, using latest instead"
    git checkout --quiet origin/main
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

    # The Vencord bundle is replaced as a whole. This build keeps every
    # plugin already present in the shared checkout, so the other DM
    # plugins stay. Anything that was in the old bundle but is not in this
    # build would disappear, so say so rather than letting the user
    # discover it.
    INSTALLED_PLUGINS="$(grep -oE 'userplugins/[a-zA-Z0-9_-]+' "$DIST/renderer.js" 2>/dev/null \
        | sed 's|userplugins/||' | sort -u || true)"
    DROPPED=""
    for p in $INSTALLED_PLUGINS; do
        [ "$p" = "$PLUGIN_DIR" ] && continue
        [ -d "src/userplugins/$p" ] || DROPPED="$DROPPED $p"
    done
    if [ -n "$DROPPED" ]; then
        echo ""
        echo "WARNING: these custom plugins are in your current bundle but are"
        echo "not in this build, so they will be removed:"
        for p in $DROPPED; do echo "    $p"; done
        echo ""
    fi

    KEPT_PLUGINS="$(ls -1 src/userplugins 2>/dev/null | grep -v "^$PLUGIN_DIR$" || true)"
    if [ -n "$KEPT_PLUGINS" ]; then
        echo "    also building:"
        for p in $KEPT_PLUGINS; do echo "        $p"; done
    fi

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
