#!/usr/bin/env bash
# Deploy the Compute program to devnet (or any cluster) and seed demo markets.
#
# Prerequisites:
#   - toolchain installed (bash scripts/setup.sh)
#   - program built: `anchor build` (or `cargo build-sbf`)
#   - the DEPLOYER keypair funded with >= ~6 SOL on the target cluster
#     (5.05 SOL rent-exempt for the program + transient buffer).
#     Devnet SOL: https://faucet.solana.com (browser) or transfer from a funded wallet.
#
# Usage:
#   RPC=https://api.devnet.solana.com bash scripts/deploy-devnet.sh
set -euo pipefail

RPC="${RPC:-https://api.devnet.solana.com}"
SO="target/deploy/compute_markets.so"
PROGRAM_KEYPAIR="target/deploy/compute_markets-keypair.json"
PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"

[ -f "$SO" ] || { echo "error: $SO missing — run 'anchor build' first." >&2; exit 1; }

solana config set --url "$RPC" >/dev/null
DEPLOYER="$(solana address)"
BAL="$(solana balance | awk '{print $1}')"
echo "cluster   $RPC"
echo "program   $PROGRAM_ID"
echo "deployer  $DEPLOYER  ($BAL SOL)"

# 5.05 SOL rent + buffer headroom.
if awk "BEGIN{exit !($BAL < 6)}"; then
  echo
  echo "error: deployer has $BAL SOL but the deploy needs ~6. Fund it:" >&2
  echo "  $DEPLOYER" >&2
  echo "  (https://faucet.solana.com for devnet, or transfer SOL), then re-run." >&2
  exit 1
fi

echo "deploying ..."
solana program deploy --program-id "$PROGRAM_KEYPAIR" "$SO" --url "$RPC"

echo "seeding demo markets ..."
ANCHOR_PROVIDER_URL="$RPC" npx ts-node scripts/seed-demo.ts

echo
echo "done — explorer: https://explorer.solana.com/address/$PROGRAM_ID?cluster=${RPC##*api.}"
