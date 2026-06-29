# Contributing to Compute

Thanks for your interest in improving Compute. This guide covers local setup, the
test workflow, and — importantly — the **IDL re-vendoring procedure** you must
follow whenever you change the on-chain program.

By contributing you agree that your contributions are licensed under the
project's [Apache-2.0 License](LICENSE).

## Repository layout

```
programs/compute-markets/   Anchor/Rust program (lib.rs + math.rs)
sdk/                        TypeScript SDK: PDAs, AMM quotes, typed client, idl/ (vendored)
app/                        Next.js frontend (wallet connect + trade/redeem)
app/lib/idl/                the app's own vendored copy of the IDL + types
tests/                      ts-mocha integration tests (run on solana-test-validator)
scripts/                    setup.sh (toolchain) + test-integration.sh (test runner)
docs/                       architecture, reference, threat model, deployment, operations
target/                     build output incl. authoritative IDL + types (gitignored)
```

## Development setup

Prerequisites: Rust, Node 18+, and the Solana (Agave) + Anchor toolchains. A
helper script installs them (Linux x86_64; pins Anchor `0.31.1`, BPF
platform-tools `v1.53`):

```bash
bash scripts/setup.sh
```

This installs the Solana CLI, pre-stages the BPF platform-tools, installs the
Anchor CLI from crates.io, and runs `npm install` in both the workspace root and
`app/`. After it completes you can build and test (below).

## Building

```bash
cargo build-sbf            # compile the program -> target/deploy/compute_markets.so
# or, if the Anchor CLI is installed (also regenerates the IDL + TS types):
anchor build
```

`cargo build-sbf` is enough to build and run integration tests. **`anchor build`
is required to regenerate the IDL/types** that the SDK and app vendor — see the
next section.

## Running tests

| Command | What it runs |
|---|---|
| `npm run test:unit` | Rust **unit tests** for the FPMM math (`math.rs`), including the proptests (`cargo test -p compute-markets --lib`). |
| `npm test` (= `npm run test:integration`) | **Integration tests**: boots a throwaway `solana-test-validator` with the built program preloaded, runs the ts-mocha suite in `tests/`, then tears the validator down (`scripts/test-integration.sh`). |

Integration tests require a built `target/deploy/compute_markets.so` (run
`cargo build-sbf` or `anchor build` first) and `solana-test-validator` on your
`PATH`. The runner is self-contained: it resets the ledger, waits for validator
health, runs the suite, and cleans up on exit. Override the RPC port with
`RPC_PORT=... npm test` if 8899 is busy.

When you change the math, run the unit tests; when you change instructions,
accounts, events, or errors, run **both** — and re-vendor the IDL (below).

## IDL re-vendoring procedure (required after any program change)

The TypeScript SDK and the web app each ship a **vendored copy** of the IDL and
generated types so they are self-contained. These copies are **not** generated at
build time — they are checked in, and they **will drift** from the program unless
you re-vendor them after every change to instructions, accounts, args, events, or
errors. CI's IDL-drift check exists precisely to catch a missed re-vendor.

After any program change:

1. **Rebuild to regenerate the IDL + types:**

   ```bash
   anchor build
   ```

   This writes the authoritative artifacts to:
   - `target/idl/compute_markets.json` (the IDL)
   - `target/types/compute_markets.ts` (the generated TypeScript types)

2. **Copy both into the SDK:**

   ```bash
   cp target/idl/compute_markets.json   sdk/idl/
   cp target/types/compute_markets.ts   sdk/idl/
   ```

3. **Copy both into the app:**

   ```bash
   cp target/idl/compute_markets.json   app/lib/idl/
   cp target/types/compute_markets.ts   app/lib/idl/
   ```

4. **Keep the `sdk/` and `app/lib/` copies in sync.** They must be byte-identical
   to each other and to `target/` (modulo any header comment the toolchain may
   add). The simplest discipline: always run steps 2 and 3 together, from the same
   freshly built `target/`. A quick check:

   ```bash
   diff sdk/idl/compute_markets.json app/lib/idl/compute_markets.json
   diff sdk/idl/compute_markets.ts   app/lib/idl/compute_markets.ts
   ```

   Both diffs should be empty.

> The generated TypeScript types live under **`target/types/`**, not
> `target/idl/`. Copy the `.json` from `target/idl/` and the `.ts` from
> `target/types/` — both land in `sdk/idl/` and `app/lib/idl/`.

## Pull request checklist

- [ ] `cargo build-sbf` (or `anchor build`) succeeds.
- [ ] `npm run test:unit` passes.
- [ ] `npm test` passes (integration suite).
- [ ] If the program changed: IDL re-vendored into **both** `sdk/idl/` and
      `app/lib/idl/`, and the two copies are in sync (see above).
- [ ] `cargo fmt` / `cargo clippy` clean for Rust changes; `tsc --noEmit` clean
      for TS changes.
- [ ] Docs updated if behavior, instructions, accounts, errors, or events
      changed (`docs/REFERENCE.md` is the exhaustive surface map).
- [ ] No secrets, keypairs, or `.env` files committed.

## Reporting security issues

Do **not** file public issues for vulnerabilities. Follow
[`SECURITY.md`](SECURITY.md).
