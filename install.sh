#!/usr/bin/env sh
# Install or update Hydemods as an Oh My Pi extension.
#
#   curl -fsSL https://raw.githubusercontent.com/emmahyde/hydemods/main/install.sh | sh
#
# Clones (or pulls) the repository into ~/.omp/agent/extensions/hydemods, where OMP
# discovers directory extensions, then installs its dependencies with Bun.
# Override the destination with HYDEMODS_DIR or the source with HYDEMODS_REPO.
set -eu

REPO="${HYDEMODS_REPO:-https://github.com/emmahyde/hydemods.git}"
DEST="${HYDEMODS_DIR:-$HOME/.omp/agent/extensions/hydemods}"

need() {
	command -v "$1" >/dev/null 2>&1 || { echo "install.sh: $1 is required but not on PATH" >&2; exit 1; }
}
need git
need bun
command -v omp >/dev/null 2>&1 || echo "install.sh: warning: omp not found on PATH; the extension loads once OMP is installed" >&2

if [ -d "$DEST/.git" ]; then
	echo "Updating hydemods in $DEST"
	git -C "$DEST" pull --ff-only
elif [ -e "$DEST" ]; then
	echo "install.sh: $DEST exists and is not a git checkout; move it aside or set HYDEMODS_DIR" >&2
	exit 1
else
	echo "Cloning hydemods into $DEST"
	mkdir -p "$(dirname "$DEST")"
	git clone --depth 1 "$REPO" "$DEST"
fi

echo "Installing dependencies"
bun install --cwd "$DEST" --frozen-lockfile

echo
echo "Hydemods installed. Restart OMP (or run /reload-plugins in a session), then open /hydemods."
