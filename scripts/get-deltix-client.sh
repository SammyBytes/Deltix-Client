#!/usr/bin/env bash
# ==============================================================================
# Deltix-Client one-line installer (Linux/macOS).
#
# Downloads the prebuilt Deltix-Client binary for your OS/arch from GitHub
# Releases, verifies its SHA-256 against the value GitHub publishes for the
# release asset, and installs it to ~/.local/bin (no sudo required).
#
#   curl -fsSL https://raw.githubusercontent.com/SammyBytes/Deltix-Client/main/scripts/get-deltix-client.sh | bash
#
# Pin a version (defaults to the latest release):
#   curl -fsSL .../get-deltix-client.sh | VERSION=0.7.0 bash
#
# Install system-wide instead of ~/.local/bin (uses sudo):
#   curl -fsSL .../get-deltix-client.sh | sudo bash -s -- --system
# ==============================================================================

set -euo pipefail

REPO="SammyBytes/Deltix-Client"
VERSION="${VERSION:-}"
INSTALL_DIR="${INSTALL_DIR:-}"
SYSTEM=false
for arg in "$@"; do
  [ "$arg" = "--system" ] && SYSTEM=true
done

log_info()  { printf '[INFO]  %s\n' "$*"; }
log_warn()  { printf '[WARN]  %s\n' "$*" >&2; }
log_error() { printf '[ERROR] %s\n' "$*" >&2; }

require() { command -v "$1" >/dev/null 2>&1 || { log_error "Required command '$1' not found."; exit 1; }; }
require curl

# --- Detect platform -> release asset name -----------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux)  platform="linux" ;;
  Darwin) platform="darwin" ;;
  MINGW*|MSYS*|CYGWIN*)
    log_error "On Windows, install via Scoop: scoop bucket add deltix https://github.com/SammyBytes/deltix-bucket && scoop install deltix"
    exit 1 ;;
  *) log_error "Unsupported OS: $os"; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64)  a="x64" ;;
  arm64|aarch64) a="arm64" ;;
  *) log_error "Unsupported architecture: $arch"; exit 1 ;;
esac
ASSET="deltix-${platform}-${a}"

# --- Resolve version ----------------------------------------------------------
if [ -z "$VERSION" ]; then
  log_info "Resolving latest ${REPO} release..."
  # Fetch the JSON to a variable first, then parse WITHOUT an early-exiting
  # consumer (grep -m1/head closes the pipe -> SIGPIPE -> curl error 23 under
  # `set -o pipefail`). sed reads the whole input and prints the one match.
  LATEST_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")"
  VERSION="$(printf '%s' "$LATEST_JSON" \
    | sed -nE 's/.*"tag_name": *"v?([^"]+)".*/\1/p' \
    | tr -d '\n')"
  [ -n "$VERSION" ] || { log_error "Could not resolve the latest release. Set VERSION=x.y.z."; exit 1; }
fi
TAG="v${VERSION#v}"

# --- Fetch release metadata and extract URL + expected digest -----------------
# Uses python3 (present by default on Arch/macOS) to parse JSON robustly; falls
# back to jq if python3 is unavailable.
RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/tags/${TAG}")"
extract() {
  # $1 = field (url|digest)
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$RELEASE_JSON" | python3 -c '
import sys, json
want = sys.argv[1]
rel = json.load(sys.stdin)
for a in rel.get("assets", []):
    if a.get("name") == sys.argv[2]:
        print(a["browser_download_url"] if want == "url" else (a.get("digest") or ""))
        break
' "$1" "$ASSET"
  elif command -v jq >/dev/null 2>&1; then
    printf '%s' "$RELEASE_JSON" | jq -r --arg n "$ASSET" \
      '.assets[] | select(.name==$n) | (if "'"$1"'"=="url" then .browser_download_url else (.digest // "") end)'
  else
    log_error "Need python3 or jq to parse the release manifest."
    exit 1
  fi
}

DOWNLOAD_URL="$(extract url)"
DIGEST="$(extract digest)"
[ -n "$DOWNLOAD_URL" ] || { log_error "Asset '${ASSET}' not found in ${TAG}."; exit 1; }

# --- Download to a temp file --------------------------------------------------
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
log_info "Downloading ${ASSET} (${TAG})..."
curl -fL --progress-bar -o "$TMP" "$DOWNLOAD_URL"

# --- Verify SHA-256 against GitHub's published asset digest -------------------
if [ -n "$DIGEST" ]; then
  expected="${DIGEST#sha256:}"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$TMP" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$TMP" | awk '{print $1}')"
  else
    actual=""
  fi
  if [ -n "$actual" ]; then
    [ "$actual" = "$expected" ] || { log_error "SHA-256 mismatch: got ${actual}, expected ${expected}."; exit 1; }
    log_info "SHA-256 verified."
  else
    log_warn "No sha256sum/shasum found; skipping integrity check."
  fi
else
  log_warn "Release asset has no published digest; skipping integrity check."
fi

# --- Install ------------------------------------------------------------------
if [ "$SYSTEM" = true ]; then
  INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
else
  INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
fi
mkdir -p "$INSTALL_DIR"
BIN="${INSTALL_DIR}/deltix"
if [ "$platform" = "windows" ]; then BIN="${BIN}.exe"; fi
install -m 0755 "$TMP" "$BIN" 2>/dev/null || { cp "$TMP" "$BIN"; chmod 0755 "$BIN"; }
log_info "Installed ${BIN}"

# --- PATH hint ----------------------------------------------------------------
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) : ;;
  *) log_warn "${INSTALL_DIR} is not on your PATH. Add it:"
     echo "    export PATH=\"${INSTALL_DIR}:\$PATH\"   # e.g. add to ~/.bashrc or ~/.zshrc" ;;
esac

log_info "Done. Try: deltix version"
