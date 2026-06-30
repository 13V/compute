# Compute

**On-chain prediction markets for trading on compute** — a Solana program (+ SDK and
web app) where users connect a wallet and trade YES/NO on compute-related outcomes
(GPU rental prices, AI milestones, …). This repo contains a working, tested MVP with a
**hardened, defense-in-depth settlement path**.

> - Strategy & rationale (what to trade, mechanism choice, the oracle problem, roadmap):
>   [`docs/RESEARCH.md`](docs/RESEARCH.md).
> - Audit roadmap / path to world-class: [`docs/WORLDCLASS.md`](docs/WORLDCLASS.md).
> - Architecture, full reference, threat model, deployment, and operations docs: see
>   [Documentation](#documentation).

## What's here

| Piece | Path | Status |
|---|---|---|
| Anchor program (FPMM market) | `programs/compute-markets/` | builds to BPF, tested |
| Pure AMM/payout math + unit tests | `programs/compute-markets/src/math.rs` | unit + proptest |
| End-to-end integration tests | `tests/` | run on a real validator |
| TypeScript SDK | `sdk/` | PDAs, AMM quotes, typed client |
| Web app (wallet + trading) | `app/` | Next.js |

## How it works (mechanism)

A market is **binary (YES / NO)** or **scalar / range** and uses a **fixed-product market
maker (FPMM)**, the Gnosis/Polymarket design: collateral (USDC, 6 decimals) is split into full
sets of outcome tokens, and a constant-product pool prices the two sides. Traders get
continuous, always-on pricing rather than waiting for a counterparty.

- **Buy** invests collateral → mints a full set into the pool → the constant-product swap
  returns the bought outcome to the trader.
- **Sell** returns outcome tokens → the pool merges a full set out → pays collateral.
- **Liquidity is multi-LP.** Anyone can `add_liquidity` (mints a full set, keeps a
  price-ratio-preserving slice, mints pro-rata shares into a per-provider `LiquidityPosition`)
  or `remove_liquidity`; shares track each LP's claim on the reserves, and all rounding favors
  the pool / existing LPs.
- **Scalar / range markets** reuse the same FPMM with **YES = LONG, NO = SHORT** over a range
  `[lower, upper]`; a full set is still always worth 1 collateral. Settlement maps the resolved
  value to a fraction `f` and pays LONG `f` / SHORT `1 − f` (`redeem_scalar`).
- **Resolve** is **two steps**: the market's `resolver` *proposes* an outcome (`propose_outcome`
  binary / `propose_scalar` scalar), then — after a dispute window — anyone *finalizes* it.
- **Redeem** burns winning binary tokens 1:1 for collateral (losing side worthless), or scalar
  tokens at their settled fraction.

All rounding favors the pool, so the constant product never decreases — proven by a
property test. The program tracks a conservation invariant asserted throughout the
integration suite: `vault == market.collateral + market.fee_accrued`, and during trading
`yes_supply == no_supply == market.collateral`.

### Lifecycle

```
initialize → create_market → seed_liquidity → buy/sell (until close_time)
  → propose_outcome (resolver, at/after resolution_time)
  → [dispute window: dispute_period]
  → finalize_outcome (permissionless)  → redeem / claim_pool / collect_fees
```

States: `OPEN=0 → RESOLVING=1 → RESOLVED=2`, or `→ VOID=3`. Outcomes: `YES=0`, `NO=1`.

### Settlement defenses (the hardened part)

A manual resolver is a trusted component, so settlement is defended in depth:

- **Two-step resolution + timelock.** The resolver only *proposes*; payouts unlock only
  after `config.dispute_period` via permissionless `finalize_outcome`.
- **Guardian veto.** During the dispute window the guardian can `dispute_void` a bad
  proposal → `redeem_void` 50/50 refund (each token = half collateral).
- **Liveness escape hatch.** If the resolver never proposes, anyone may `void_stale` the
  market 7 days (`VOID_GRACE_PERIOD`) after `resolution_time`, so collateral is never
  stranded.
- **Trading halts at `close_time`** (`close_time <= resolution_time`) — no informed
  last-look.
- **Pause switch.** Admin or guardian can pause trading in an incident.
- **Two-step admin transfer** (`set_admin` → `accept_admin`).
- **Oracle-feed resolver (feed-bridge adapter).** A market may instead set
  `resolver_kind = 1` (`ORACLE_FEED`) and bind an on-chain `PriceFeed`; anyone can then
  `propose_from_oracle` after `resolution_time`, which compares the feed value to the market's
  strike and proposes the outcome — flowing through the **same** dispute window + guardian veto,
  with a staleness guard. The feed is posted to by a Switchboard On-Demand Function (TEE-attested)
  or a committee multisig; the trusted key remains the default. See [`docs/ORACLE.md`](docs/ORACLE.md).
- **Forward-compat oracles.** `resolver_kind` + 64 reserved bytes leave room for the remaining
  resolvers (native Switchboard-account parsing / Pyth / optimistic) without a layout-breaking
  change — those are not yet wired.

### Instructions (25)

`initialize` · `create_market` · `seed_liquidity` · `add_liquidity` · `remove_liquidity` ·
`buy` · `sell` · `propose_outcome` · `propose_scalar` · `propose_from_oracle` ·
`finalize_outcome` · `dispute_void` · `void_stale` · `redeem` · `redeem_scalar` ·
`redeem_void` · `claim_pool` · `collect_fees` · `init_price_feed` · `publish_price` ·
`set_paused` · `set_fee_bps` · `set_guardian` · `set_admin` · `accept_admin`.

Full surface (every instruction, account, error, event, PDA seed) is in
[`docs/REFERENCE.md`](docs/REFERENCE.md).

## Repo layout

```
programs/compute-markets/   Anchor/Rust program (lib.rs + math.rs)
sdk/                        TS SDK: pdas, amm, client, idl/ (vendored IDL+types)
tests/                      ts-mocha integration tests (run on solana-test-validator)
app/                        Next.js frontend (wallet connect + trade/redeem)
scripts/                    setup.sh (toolchain) + test-integration.sh (test runner)
docs/                       research, audit roadmap, and the docs linked below
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
`sdk/idl/` and the app in `app/lib/idl/` so both are self-contained. **Re-vendor both after
any program change** — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the exact procedure.

## Deploying

The program id is fixed in `declare_id!` / `Anchor.toml`
(`8xv1L7757szxo2XPrQL5AERPGZrJaYRKgqB9RgFkQCU2`). To deploy under your own key:

```bash
solana-keygen new -o target/deploy/compute_markets-keypair.json   # your program key
anchor keys sync                                                   # update declare_id! + Anchor.toml
anchor build && anchor deploy --provider.cluster devnet
```

After deploying, run the one-time, **irreversible** `initialize` to create the global
config, then `create_market` + `seed_liquidity`. The full runbook (including
upgrade-authority custody via a Squads multisig) is in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md); resolver/guardian/admin procedures are in
[`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Components, the FPMM split/swap math, account + PDA model, resolution state machine, event flow. |
| [`docs/REFERENCE.md`](docs/REFERENCE.md) | Exhaustive surface: PDA seeds, instructions, accounts, errors, events. |
| [`docs/ORACLE.md`](docs/ORACLE.md) | Oracle-feed resolver: the `PriceFeed` account, comparison/strike semantics, `propose_from_oracle`, wiring a Switchboard Function or committee as the feed authority. |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | Trusted roles & powers, defenses, residual trust, non-goals, proven invariants. |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Build → deploy → initialize → create/seed runbook + key custody. |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Resolver checklist, guardian playbook, cranking, fee sweeps, monitoring. |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | Product & mechanism research, the oracle problem, roadmap. |
| [`docs/WORLDCLASS.md`](docs/WORLDCLASS.md) | Audit findings and the path from MVP to world-class. |
| [`SECURITY.md`](SECURITY.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`LICENSE`](LICENSE) | Disclosure policy · dev + IDL re-vendoring · Apache-2.0. |

## MVP scope & limitations

This MVP now supports **binary and scalar/range** markets, FPMM trading, **multi-LP
liquidity** (per-provider share ledger, `add_liquidity` / `remove_liquidity`, per-LP
`claim_pool`), and a **trusted resolver key by default** (defended in depth). Settlement also
offers an **oracle feed-bridge adapter**: markets can resolve from an on-chain `PriceFeed`
posted to by a Switchboard On-Demand Function or a committee multisig, still passing through the
dispute window + guardian veto (see [`docs/ORACLE.md`](docs/ORACLE.md)) — but the trusted key
remains the default and the residual trust shifts to the feed authority rather than disappearing.
Known non-goals today: native Switchboard-account parsing / Pyth / a Solana-native optimistic
oracle remain future, taker fees are **not yet routed to LPs** (fees stay a separate admin
bucket), and the guardian can only *void* a bad proposal (50/50 refund), not correct it. The
load-bearing next steps are **hardening the oracle layer** and **fee-to-LP routing** — see
[`docs/RESEARCH.md`](docs/RESEARCH.md) and [`docs/WORLDCLASS.md`](docs/WORLDCLASS.md).
**Not audited; do not use with real funds.**
