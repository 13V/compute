#!/usr/bin/env bash
# Stand up a complete local Compute demo: a throwaway validator with the program
# loaded, the global config initialized, and one market of every kind seeded.
# Leaves the validator running so a frontend (NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8899)
# can connect — Ctrl-C to stop. Set VERIFY=1 to seed then exit (CI/self-check).
set -uo pipefail

PROGRAM_ID="8xv1L7757szxo2XPrQL5AERPGZrJaYRKgqB9RgFkQCU2"
SO="target/deploy/compute_markets.so"
RPC_PORT="${RPC_PORT:-8899}"
LEDGER="$(mktemp -d)/demo-ledger"

[ -f "$SO" ] || { echo "error: $SO missing — run 'anchor build' first." >&2; exit 1; }
pkill -f "solana-test-validator" >/dev/null 2>&1 || true
sleep 2

echo "Starting validator (program preloaded) ..."
solana-test-validator --reset --quiet --ledger "$LEDGER" \
  --bpf-program "$PROGRAM_ID" "$SO" --rpc-port "$RPC_PORT" >/dev/null 2>&1 &
VALIDATOR_PID=$!
cleanup() { kill "$VALIDATOR_PID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

curl -s --retry 60 --retry-delay 1 --retry-all-errors --retry-connrefused \
  -X POST "http://127.0.0.1:${RPC_PORT}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q ok && echo "Validator healthy."

solana config set --url "http://127.0.0.1:${RPC_PORT}" >/dev/null
solana airdrop 100 >/dev/null 2>&1 && echo "Admin funded: $(solana balance)"

echo "Seeding demo markets ..."
ANCHOR_PROVIDER_URL="http://127.0.0.1:${RPC_PORT}" npx ts-node scripts/seed-demo.ts
SEED_EXIT=$?
[ "$SEED_EXIT" -eq 0 ] || { echo "seed failed ($SEED_EXIT)"; exit "$SEED_EXIT"; }

if [ "${VERIFY:-0}" = "1" ]; then
  echo "VERIFY=1 — seeded OK, shutting down."
  exit 0
fi

echo
echo "Demo live on http://127.0.0.1:${RPC_PORT}. Start the frontend with:"
echo "  cd app && NEXT_PUBLIC_RPC_URL=http://127.0.0.1:${RPC_PORT} npm run dev"
echo "Ctrl-C to stop."
wait "$VALIDATOR_PID"
