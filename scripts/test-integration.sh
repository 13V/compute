#!/usr/bin/env bash
# Self-contained integration test runner: boots a fresh solana-test-validator with
# the program preloaded, runs the LiteSVM-free ts-mocha suite against it, then tears
# the validator down. Requires: solana-test-validator on PATH, a built program at
# target/deploy/compute_markets.so, and `npm install` already run.
set -uo pipefail

PROGRAM_ID="8xv1L7757szxo2XPrQL5AERPGZrJaYRKgqB9RgFkQCU2"
SO="target/deploy/compute_markets.so"
RPC_PORT="${RPC_PORT:-8899}"
LEDGER="$(mktemp -d)/test-ledger"

if [[ ! -f "$SO" ]]; then
  echo "error: $SO not found — run 'anchor build' (or 'cargo build-sbf') first." >&2
  exit 1
fi

# Stop any validator already bound to the RPC port.
pkill -f "solana-test-validator" >/dev/null 2>&1 || true

echo "Starting solana-test-validator (ledger: $LEDGER) ..."
solana-test-validator \
  --reset --quiet \
  --ledger "$LEDGER" \
  --bpf-program "$PROGRAM_ID" "$SO" \
  --rpc-port "$RPC_PORT" &
VALIDATOR_PID=$!
cleanup() { kill "$VALIDATOR_PID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Waiting for validator health ..."
curl -s --retry 60 --retry-delay 1 --retry-all-errors --retry-connrefused \
  -X POST "http://127.0.0.1:${RPC_PORT}" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null

echo "Running tests ..."
ANCHOR_PROVIDER_URL="http://127.0.0.1:${RPC_PORT}" \
  npx ts-mocha -p ./tsconfig.json -t 1000000 "tests/**/*.ts"
EXIT=$?

exit $EXIT
