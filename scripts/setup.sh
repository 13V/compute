#!/usr/bin/env bash
# One-time toolchain setup for building & testing the Compute Markets program.
# Installs the Solana (Agave) CLI, the BPF platform-tools, the Anchor CLI, and
# Node dependencies. Tested on Linux x86_64.
#
# Usage:  bash scripts/setup.sh
set -uo pipefail

SOLANA_VERSION="stable"
ANCHOR_VERSION="0.31.1"
PLATFORM_TOOLS_VERSION="v1.53"

echo "==> Installing Solana (Agave) CLI ($SOLANA_VERSION) ..."
sh -c "$(curl -sSfL https://release.anza.xyz/${SOLANA_VERSION}/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version

# `cargo build-sbf` downloads platform-tools from GitHub. In some sandboxes the
# bundled downloader does not trust a corporate TLS-intercepting proxy. If so,
# pre-stage the tarball with curl (which uses the system trust store) so the
# build skips the download. Harmless if the normal download already works.
CACHE="$HOME/.cache/solana/${PLATFORM_TOOLS_VERSION}"
if [[ ! -d "$CACHE/platform-tools" ]]; then
  echo "==> Pre-staging BPF platform-tools ($PLATFORM_TOOLS_VERSION) ..."
  mkdir -p "$CACHE/platform-tools"
  URL="https://github.com/anza-xyz/platform-tools/releases/download/${PLATFORM_TOOLS_VERSION}/platform-tools-linux-x86_64.tar.bz2"
  if curl -fsSL -o "$CACHE/pt.tar.bz2" "$URL"; then
    tar -xjf "$CACHE/pt.tar.bz2" -C "$CACHE/platform-tools" && rm -f "$CACHE/pt.tar.bz2"
  else
    echo "   (could not pre-stage; cargo build-sbf will try its own download)"
    rmdir "$CACHE/platform-tools" 2>/dev/null || true
  fi
fi

echo "==> Installing Anchor CLI ($ANCHOR_VERSION) from crates.io ..."
cargo install anchor-cli --version "$ANCHOR_VERSION" --locked || \
  echo "   (anchor-cli install failed; 'cargo build-sbf' still works without it, but IDL regen needs it)"

echo "==> Installing Node dependencies ..."
npm install --no-audit --no-fund
( cd app && npm install --no-audit --no-fund )

echo
echo "Setup complete. Next:"
echo "  cargo build-sbf            # build the program -> target/deploy/compute_markets.so"
echo "  npm run test:unit          # Rust unit tests (math)"
echo "  npm test                   # integration tests on a throwaway validator"
echo "  cd app && npm run dev      # the trading frontend"
