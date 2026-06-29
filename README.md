# Compute

**On-chain prediction markets for trading on compute** — a Solana program (+ SDK and
web app) where users connect a wallet and trade YES/NO on compute-related outcomes
(GPU rental prices, AI milestones, …). This repo contains a working, tested MVP.

> Strategy & rationale (what to trade, mechanism choice, the oracle problem, roadmap):
> see [`docs/RESEARCH.md`](docs/RESEARCH.md).

## What's here

| Piece | Path | Status |
|---|---|---|
| Anchor program (FPMM market) | `programs/compute-markets/` | ✅ builds to BPF, tested |
| Pure AMM/payout math + unit tests | `programs/compute-markets/src/math.rs` | ✅ 13 tests incl. proptest |
| End-to-end integration tests | `tests/compute_markets.ts` | ✅ 14 tests on a real validator |
| TypeScript SDK | `sdk/` | ✅ PDAs, AMM quotes, typed client |
| Web app (wallet + trading) | `app/` | ✅ Next.js, production build green |

## How it works (mechanism)

Each market is **binary (YES / NO)** and uses a **fixed-product market maker (FPMM)**, the
Gnosis/Polymarket design: collateral (USDC, 6 decimals) is split into full sets of outcome
tokens, and a constant-product pool prices YES vs NO. Traders get continuous, always-on
pricing rather than waiting for a counterparty.

- **Buy** invests collateral → mints a full set into the pool → the constant-product swap
  returns the bought outcome to the trader.
- **Sell** returns outcome tokens → the pool merges a full set out → pays collateral.
- **Resolve** (the market's `resolver` key, an oracle stand-in) picks the winning side.
- **Redeem** burns winning tokens 1:1 for collateral. The losing side is worthless.

All rounding favors the pool, so the constant product never decreases — proven by a 2,000-case
property test. The program also tracks a conservation invariant asserted throughout the
integration suite: `vault == collateral_backing + accrued_fees`, and during trading
`yes_supply == no_supply == collateral_backing`.

Instructions: `initialize` · `create_market` · `seed_liquidity` · `buy` · `sell` · `resolve`
· `redeem` · `claim_pool` · `collect_fees`.

## Repo layout

```
programs/compute-markets/   Anchor/Rust program (lib.rs + math.rs)
sdk/                        TS SDK: pdas.ts, amm.ts, client.ts, idl/ (vendored IDL+types)
tests/                      ts-mocha integration tests (run on solana-test-validator)
app/                        Next.js frontend (wallet connect + trade/redeem/resolve)
scripts/                    setup.sh (toolchain) + test-integration.sh (test runner)
docs/RESEARCH.md            product & architecture research
```

## Quick start

Prerequisites: Rust, Node 18+, and the Solana + Anchor toolchains. A helper installs them:

```bash
bash scripts/setup.sh
```

Build and test:

```bash
cargo build-sbf            # compile the program -> target/deploy/compute_markets.so
npm run test:unit          # Rust unit tests (AMM math, proptest)
npm test                   # integration tests (boots a throwaway validator, tears it down)
```

Run the trading frontend (point it at a cluster where the program is deployed and a market seeded):

```bash
cd app
cp .env.local.example .env.local   # set NEXT_PUBLIC_RPC_URL (default http://localhost:8899)
npm run dev
```

`anchor build` regenerates the IDL/types under `target/`; the SDK vendors a copy in
`sdk/idl/` and the app in `app/lib/idl/` so both are self-contained — re-copy if the program
changes.

## Deploying

The program id is fixed in `declare_id!` / `Anchor.toml` (`8xv1L7757szxo2XPrQL5AERPGZrJaYRKgqB9RgFkQCU2`).
To deploy under your own key:

```bash
solana-keygen new -o target/deploy/compute_markets-keypair.json   # your program key
anchor keys sync                                                   # update declare_id! + Anchor.toml
anchor build && anchor deploy --provider.cluster devnet
```

## MVP scope & what's next

This MVP is intentionally focused: binary markets, FPMM trading, single-seed liquidity, and a
**trusted resolver key** standing in for the oracle. The research doc lays out the path beyond
it — the load-bearing next steps are a **real settlement oracle** (a licensed GPU index bridged
on-chain via Switchboard, plus an optimistic-oracle dispute layer) and **scalar/range markets**
for continuous compute prices. Not audited; do not use with real funds.
