# Compute — Reference

The exhaustive on-chain surface of the `compute_markets` program: PDA seeds,
every instruction, every account field, every error, and every event. Derived
from the program source (`programs/compute-markets/src/`) and the authoritative
IDL (`target/idl/compute_markets.json`).

- **Program ID:** `8xv1L7757szxo2XPrQL5AERPGZrJaYRKgqB9RgFkQCU2`
- **Anchor / Solana:** Anchor `0.31.1`, legacy SPL Token.
- **Decimals:** collateral and outcome tokens use 6 decimals.
- **Counts:** 25 instructions · 4 accounts · 15 events · 34 error variants.

> **Authoritative PDA layout.** The seeds below describe the **shipped binary
> FPMM program** and supersede the generic PDA sketch in `docs/RESEARCH.md` §7
> (which predates this program). When they disagree, this document is correct.

## Constants

| Name | Value | Meaning |
|---|---|---|
| `OUTCOME_YES` | `0` | YES outcome index. |
| `OUTCOME_NO` | `1` | NO outcome index. |
| `STATE_OPEN` | `0` | Open for trading. |
| `STATE_RESOLVING` | `1` | Outcome proposed; in the dispute window. |
| `STATE_RESOLVED` | `2` | Finalized to a YES/NO outcome; winners redeem 1:1. |
| `STATE_VOID` | `3` | Voided; every token redeems for half collateral. |
| `RESOLVER_TRUSTED_KEY` | `0` | Trusted single-key resolver (the default). |
| `RESOLVER_ORACLE_FEED` | `1` | Oracle-feed resolver: resolved from a `PriceFeed` (see [`ORACLE.md`](ORACLE.md)). |
| `MARKET_BINARY` | `0` | Binary YES/NO market (the default). |
| `MARKET_SCALAR` | `1` | Scalar/range market: YES=LONG, NO=SHORT; settles at a fraction `f`. |
| `PRICE_SCALE` | `1_000_000` | Fixed-point scale (1e6) for prices and the scalar settlement fraction `f`. |
| `CMP_GTE` | `0` | Oracle comparison: YES iff `feed.value >= oracle_strike`. |
| `CMP_LTE` | `1` | Oracle comparison: YES iff `feed.value <= oracle_strike`. |
| `VOID_REASON_DISPUTE` | `0` | Voided by guardian veto. |
| `VOID_REASON_STALE` | `1` | Voided by liveness escape hatch. |
| `MAX_FEE_BPS` | `1000` | Maximum protocol fee (10%). |
| `MAX_DISPUTE_PERIOD` | `2_592_000` | 30 days, sanity bound on the timelock. |
| `MAX_MARKET_HORIZON` | `~2 years` | Upper bound on `resolution_time` from creation. |
| `VOID_GRACE_PERIOD` | `604_800` | 7 days after `resolution_time` before `void_stale`. |
| `DECIMALS` | `6` | Collateral / outcome token decimals. |
| `BPS_DENOMINATOR` | `10_000` | Basis-points denominator. |

## PDA seeds

`market_id` is encoded **little-endian u64**. `market` means the Market
account's pubkey. All PDAs are derived from the program ID.

| Account | Seeds | Created by | Authority |
|---|---|---|---|
| `Config` | `["config"]` | `initialize` | — (singleton) |
| `Market` | `["market", market_id (u64 LE)]` | `create_market` | — |
| `yes_mint` | `["yes", market]` | `create_market` | mint authority = Market PDA |
| `no_mint` | `["no", market]` | `create_market` | mint authority = Market PDA |
| `vault` | `["vault", market]` | `create_market` | token authority = Market PDA |
| `pool_yes` | `["pool_yes", market]` | `seed_liquidity` | token authority = Market PDA |
| `pool_no` | `["pool_no", market]` | `seed_liquidity` | token authority = Market PDA |
| `LiquidityPosition` | `["lp", market, owner]` | `seed_liquidity` (creator) / `add_liquidity` (first add) | signer-bound to `owner` (`lp`) |

## Instructions

Twenty-five instructions. "Signer" is the privileged caller; remaining accounts are
abbreviated (full lists are in the IDL). PDAs are derived as above. The three
oracle instructions (`init_price_feed`, `publish_price`, `propose_from_oracle`) are
detailed further in [`ORACLE.md`](ORACLE.md). Scalar-market resolution
(`propose_scalar`, `redeem_scalar`) and multi-LP liquidity (`add_liquidity`,
`remove_liquidity`) are summarized below; their mechanism is in
[`ARCHITECTURE.md`](ARCHITECTURE.md) §§ 2.5–2.6.

| # | Instruction | Args | Who may call | Signer | Effect |
|---|---|---|---|---|---|
| 1 | `initialize` | `fee_bps: u16`, `dispute_period: i64`, `guardian: Pubkey` | anyone (becomes admin) | `admin` | Create the singleton `Config`. One-time, irreversible. Validates `fee_bps <= 1000` and `0 <= dispute_period <= 30d`. |
| 2 | `create_market` | `question: String`, `resolution_source: String`, `close_time: i64`, `resolution_time: i64`, `resolver: Pubkey`, `resolver_kind: u8`, `oracle_feed: Pubkey`, `oracle_strike: i64`, `oracle_comparison: u8`, `oracle_max_staleness: i64`, `market_kind: u8`, `lower_bound: i64`, `upper_bound: i64` | **anyone** (permissionless) | `creator` | Create a market + YES/NO mints + vault. Validates `close_time <= resolution_time`, `now < resolution_time <= now + horizon`, strings within length, and the resolver config **per kind** (`TRUSTED_KEY` ⇒ `resolver != default`; `ORACLE_FEED` ⇒ `oracle_feed != default`, `oracle_max_staleness > 0`, known `oracle_comparison`; else `UnsupportedResolverKind`). Also validates `market_kind`: `BINARY = 0` (bounds forced to 0), `SCALAR = 1` ⇒ `lower_bound < upper_bound` (else `InvalidScalarRange`), any other ⇒ `UnsupportedMarketKind`. Increments `market_count`. |
| 3 | `seed_liquidity` | `amount: u64` | market `creator` only, once | `lp` (= creator) | Create the YES/NO pools, deposit `amount` collateral, mint `amount` of each outcome at 50/50, set `lp`/`total_shares = amount`, and **init the creator's `LiquidityPosition` with 100% of shares**. Requires `OPEN`, not paused, not already seeded, `amount > 0`. |
| 4 | `buy` | `outcome: u8`, `collateral_in: u64`, `min_tokens_out: u64` | anyone | `user` | Invest collateral, mint a full set, swap out the bought side. Requires `OPEN`, not paused, `now < close_time`, liquidity present, `tokens_out >= min_tokens_out`. |
| 5 | `sell` | `outcome: u8`, `collateral_out: u64`, `max_tokens_in: u64` | anyone | `user` | Return outcome tokens, merge a full set out, pay collateral (net of fee). Requires `OPEN`, not paused, `now < close_time`, `collateral_out <= collateral`, `tokens_in <= max_tokens_in`. |
| 6 | `add_liquidity` | `amount: u64` | anyone | `lp` | Add funding to a seeded `OPEN` market (Gnosis `addFunding`). Deposits `amount` collateral, mints a full set into the pools, keeps `ceil(amount·reserve_i/weight)` per side and **sends the surplus of each side back** to the LP (preserves the price ratio), mints `floor(amount·total_shares/weight)` shares into the caller's `LiquidityPosition` (`init_if_needed`). Requires not paused, `OPEN`, already seeded, `amount > 0`, and `shares_minted > 0` (dust adds rejected `ZeroAmount`). Emits `LiquidityAdded`. |
| 7 | `remove_liquidity` | `shares: u64` | LP (position owner) | `lp` | Burn `shares` of the caller's position and return `floor(reserve_i·shares/total_shares)` of **each** outcome token to the LP (favors the pool). Collateral is unchanged — outcome tokens just leave the pool to the LP. Requires not paused, `OPEN`, `shares <= position.shares` (else `InsufficientShares`). Emits `LiquidityRemoved`. |
| 8 | `propose_outcome` | `outcome: u8` | market `resolver` only | `resolver` | Step 1 of resolution (trusted key, **BINARY only** ⇒ `WrongMarketKind`). `OPEN → RESOLVING`; records `proposed_outcome` + `resolved_at`. Requires `resolver_kind == TRUSTED_KEY` (else `WrongResolverKind`) and `now >= resolution_time`. Opens the dispute window. |
| 9 | `propose_scalar` | `value: i64` | market `resolver` only | `resolver` | Step 1 of resolution for **SCALAR** markets (trusted key; `WrongMarketKind` on binary). `OPEN → RESOLVING`; records `proposed_value` + `resolved_at`. Requires `resolver_kind == TRUSTED_KEY`, `now >= resolution_time`. Opens the dispute window; the value is mapped to a fraction at finalize. Emits `ScalarProposed`. |
| 10 | `propose_from_oracle` | — | **anyone** (crank) | `cranker` | Step 1 of resolution (oracle). `OPEN → RESOLVING`. For BINARY derives `proposed_outcome`; for SCALAR records the raw feed value as `proposed_value`. Requires `resolver_kind == ORACLE_FEED` (else `WrongResolverKind`), `now >= resolution_time`, `feed.published_at > 0` (else `FeedHasNoValue`), `now - published_at <= oracle_max_staleness` (else `StaleFeed`). `OutcomeProposed.resolver` is the feed pubkey. See [`ORACLE.md`](ORACLE.md). |
| 11 | `finalize_outcome` | — | **anyone** (crank) | `cranker` | Step 2 of resolution. `RESOLVING → RESOLVED`. BINARY sets `outcome = proposed_outcome`; SCALAR computes `settlement_fraction = scalar_fraction(proposed_value, lower, upper)` (clamp into `[lower,upper]` mapped to `[0,1e6]`). Requires `now >= resolved_at + dispute_period`. Reused by both resolver and market kinds. Emits `MarketResolved` (now carries `settlement_fraction`). |
| 12 | `dispute_void` | — | `guardian` only | `guardian` | Guardian veto. `RESOLVING → VOID` (reason DISPUTE). Requires `now < resolved_at + dispute_period` (within the window). Applies to both resolver and market kinds. |
| 13 | `void_stale` | — | **anyone** (crank) | `cranker` | Liveness hatch. `OPEN → VOID` (reason STALE). Requires `now > resolution_time + 7d`. |
| 14 | `redeem` | `amount: u64` | any winning-token holder | `user` | Burn `amount` winning tokens for `amount` collateral. **BINARY only** (else `WrongMarketKind`). Requires `RESOLVED`, correct `winning_mint`, `amount <= collateral`. |
| 15 | `redeem_scalar` | `amount: u64` | any LONG/SHORT holder | `user` | Burn `amount` of a **SCALAR** market's LONG (`yes_mint`) or SHORT (`no_mint`) token; pays `scalar_payout(amount, settlement_fraction, is_long)` — LONG `amount·f/1e6`, SHORT `amount·(1e6−f)/1e6` (floored). `is_long` is inferred from the held mint. Requires `RESOLVED`, market kind SCALAR (else `WrongMarketKind`), payout `<= collateral`. |
| 16 | `redeem_void` | `amount: u64` | any YES/NO holder | `user` | Burn `amount` of **either** outcome token for `amount / 2` collateral (rounded down). Requires `VOID`. |
| 17 | `claim_pool` | — | LP (position owner) | `lp` | After settlement, the caller reclaims **their** pro-rata pool slice as collateral: per-LP `slice_i = floor(reserve_i·shares/total_shares)`, then BINARY pays the winning slice 1:1, SCALAR pays LONG slice at `f` + SHORT slice at `1−f`, VOID pays half of each slice. Burns the slices, zeroes the position. Requires `RESOLVED` or `VOID`, `position.shares > 0`. Emits `PoolClaimed` (now carries `provider`). |
| 18 | `collect_fees` | — | `admin` only | `admin` | Sweep `fee_accrued` for this market to the admin's token account; resets it to 0. Requires `fee_accrued > 0`. |
| 19 | `init_price_feed` | `description: String`, `decimals: u8` | anyone (becomes `authority`) | `feed` (new keypair) + `authority` | Create a fresh (non-PDA) `PriceFeed` account. Initializes `value = 0`, `published_at = 0`; caller becomes `authority`. Requires `description` ≤ 64 bytes. Emits `PriceFeedInitialized`. |
| 20 | `publish_price` | `value: i64` | feed `authority` only | `authority` | Set `feed.value` and stamp `published_at = now`. Emits `PricePublished`. |
| 21 | `set_paused` | `paused: bool` | `admin` **or** `guardian` | `authority` | Toggle the global pause flag. Emits `PausedSet`. |
| 22 | `set_fee_bps` | `fee_bps: u16` | `admin` only | `admin` | Update the taker fee. Re-checks `fee_bps <= 1000`. |
| 23 | `set_guardian` | `guardian: Pubkey` | `admin` only | `admin` | Replace the guardian key. |
| 24 | `set_admin` | `new_admin: Pubkey` | `admin` only | `admin` | Two-step transfer step 1: nominate `pending_admin`. |
| 25 | `accept_admin` | — | the nominated `pending_admin` | `pending_admin` | Two-step transfer step 2: accept; sets `admin`, clears `pending_admin`. |

### Account lists (key accounts per instruction)

PDAs validated by seeds/address; token programs and sysvars omitted for brevity.

| Instruction | Notable accounts |
|---|---|
| `initialize` | `config` (init), `collateral_mint`, `admin` (signer) |
| `create_market` | `config` (mut), `market` (init), `yes_mint`/`no_mint`/`vault` (init), `collateral_mint`, `creator` (signer) |
| `init_price_feed` | `feed` (init, signer), `authority` (signer) |
| `publish_price` | `feed` (mut), `authority` (signer) |
| `propose_from_oracle` | `market` (mut), `feed` (= `market.oracle_feed`), `cranker` (signer) |
| `seed_liquidity` | `config`, `market` (mut), `yes_mint`/`no_mint`/`vault` (mut), `pool_yes`/`pool_no` (init), `lp_collateral`, `position` (init, PDA `["lp", market, lp]`), `lp` (signer) |
| `add_liquidity` | `config`, `market` (mut), `yes_mint`/`no_mint`/`vault`/`pool_yes`/`pool_no` (mut), `lp_collateral`/`lp_yes`/`lp_no` (mut, LP's ATAs), `position` (mut, `init_if_needed`), `lp` (signer) |
| `remove_liquidity` | `config`, `market` (mut), `pool_yes`/`pool_no` (mut), `lp_yes`/`lp_no` (mut), `position` (mut, PDA `["lp", market, lp]`), `owner`, `lp` (signer) |
| `buy` / `sell` | `config`, `market` (mut), `yes_mint`/`no_mint`/`pool_yes`/`pool_no`/`vault` (mut), `user_outcome`, `user_collateral`, `user` (signer) |
| `propose_outcome` / `propose_scalar` | `market` (mut), `resolver` (signer) |
| `finalize_outcome` | `config`, `market` (mut), `cranker` (signer) |
| `dispute_void` | `config`, `market` (mut), `guardian` (signer) |
| `void_stale` | `market` (mut), `cranker` (signer) |
| `redeem` / `redeem_scalar` / `redeem_void` | `market` (mut), `winning_mint`, `vault`, `user_outcome`, `user_collateral`, `user` (signer) |
| `claim_pool` | `market` (mut), `yes_mint`/`no_mint`/`pool_yes`/`pool_no`/`vault` (mut), `lp_collateral`, `position` (mut, PDA `["lp", market, lp]`), `lp` (signer) |
| `collect_fees` | `config`, `market` (mut), `vault`, `admin_collateral`, `admin` (signer) |
| `set_paused` | `config` (mut), `authority` (signer) |
| `set_fee_bps` / `set_guardian` / `set_admin` | `config` (mut), `admin` (signer) |
| `accept_admin` | `config` (mut), `pending_admin` (signer) |

## Accounts

### `Config` (singleton, seeds `["config"]`)

| Field | Type | Meaning |
|---|---|---|
| `admin` | `pubkey` | Sets fees/guardian, collects fees, can pause, can transfer admin. |
| `pending_admin` | `pubkey` | Nominee for the two-step admin transfer (`default` if none). |
| `guardian` | `pubkey` | Can pause and `dispute_void` during the window. |
| `collateral_mint` | `pubkey` | The single collateral mint all markets use. |
| `fee_bps` | `u16` | Taker fee in basis points (≤ 1000). |
| `dispute_period` | `i64` | Seconds between a proposed outcome and finalization. |
| `market_count` | `u64` | Monotonic counter; next market's `market_id`. |
| `paused` | `bool` | Global trading pause. |
| `bump` | `u8` | PDA bump. |

### `Market` (seeds `["market", market_id (u64 LE)]`)

| Field | Type | Meaning |
|---|---|---|
| `market_id` | `u64` | Sequential id; PDA seed. |
| `creator` | `pubkey` | Who created the market and may seed it. |
| `resolver` | `pubkey` | Key allowed to `propose_outcome`/`propose_scalar` (trusted-key markets). |
| `resolver_kind` | `u8` | Resolver type: `0` TRUSTED_KEY (default) or `1` ORACLE_FEED. |
| `market_kind` | `u8` | Market type: `0` MARKET_BINARY (default) or `1` MARKET_SCALAR. |
| `lower_bound` | `i64` | Scalar range lower bound `A` (both `0` for binary). |
| `upper_bound` | `i64` | Scalar range upper bound `B`; requires `A < B` for scalar. |
| `proposed_value` | `i64` | Raw scalar value proposed by the resolver/oracle (valid in RESOLVING for scalar). |
| `settlement_fraction` | `u32` | Resolved scalar fraction `f` scaled to `PRICE_SCALE` (1e6); set at finalize. LONG settles at `f`, SHORT at `1e6 − f`. |
| `oracle_feed` | `pubkey` | Bound `PriceFeed` (used when `resolver_kind == ORACLE_FEED`). |
| `oracle_strike` | `i64` | Strike compared against the feed value, in the feed's native integer scale. |
| `oracle_comparison` | `u8` | `0` CMP_GTE (YES iff `value >= strike`) or `1` CMP_LTE (YES iff `value <= strike`). |
| `oracle_max_staleness` | `i64` | Max allowed `now - feed.published_at` (seconds) when proposing from the oracle. |
| `collateral_mint` | `pubkey` | Collateral mint (matches `Config`). |
| `yes_mint` / `no_mint` | `pubkey` | Outcome token mints (authority = this PDA). |
| `vault` | `pubkey` | Collateral token account (authority = this PDA). |
| `pool_yes` / `pool_no` | `pubkey` | AMM reserve token accounts (set at seed). |
| `reserve_yes` / `reserve_no` | `u64` | AMM reserves (the FPMM `(r_yes, r_no)`). |
| `lp` | `pubkey` | The market creator / initial liquidity provider (set at `seed_liquidity`). |
| `total_shares` | `u64` | Total outstanding LP shares across all `LiquidityPosition`s; a provider owns `shares / total_shares` of the reserves. |
| `collateral` | `u64` | Collateral backing outstanding tokens (excludes fees). |
| `fee_accrued` | `u64` | Protocol fee bucket awaiting `collect_fees`. |
| `state` | `u8` | `0` OPEN, `1` RESOLVING, `2` RESOLVED, `3` VOID. |
| `outcome` | `u8` | Finalized winning outcome (valid once RESOLVED). |
| `proposed_outcome` | `u8` | Outcome proposed by the resolver (valid in RESOLVING). |
| `close_time` | `i64` | Unix time after which trading halts. |
| `resolution_time` | `i64` | Earliest time the outcome may be proposed. |
| `resolved_at` | `i64` | Time the outcome was proposed (dispute window start). |
| `question` | `String` | Display question (≤ 200 bytes). |
| `resolution_source` | `String` | Display resolution source (≤ 80 bytes). |
| `reserved` | `[u8; 64]` | Forward-compat padding for future oracle/market configs. |
| `bump` | `u8` | PDA bump. |

### `LiquidityPosition` (seeds `["lp", market, owner]`)

One per (market, provider). Tracks a provider's pool shares; `shares /
market.total_shares` is their fraction of the AMM reserves. Created at
`seed_liquidity` (the creator, with 100% of shares) or a provider's first
`add_liquidity` (`init_if_needed`); drained to `0` by `claim_pool`. The PDA is
**signer-bound** to `owner` — only the owner can `remove_liquidity` / `claim_pool`
against it.

| Field | Type | Meaning |
|---|---|---|
| `market` | `pubkey` | The market this position is in. |
| `owner` | `pubkey` | The provider (= `lp` signer). |
| `shares` | `u64` | This provider's pool shares (of `market.total_shares`). |
| `bump` | `u8` | PDA bump. |

### `PriceFeed` (not a PDA — fresh keypair account)

A generic on-chain numeric feed read by `RESOLVER_ORACLE_FEED` markets. Created by
`init_price_feed` (pass a new keypair as `feed`); posted to by `publish_price`. In
production its `authority` is a Switchboard On-Demand Function enclave key or a
committee multisig. See [`ORACLE.md`](ORACLE.md).

| Field | Type | Meaning |
|---|---|---|
| `authority` | `pubkey` | The only key allowed to `publish_price`. |
| `value` | `i64` | Latest posted value, in the feed's native fixed-point integer scale. |
| `decimals` | `u8` | Informational scale hint; **not** used in any on-chain comparison. |
| `published_at` | `i64` | Unix time of the last publish; `0` = never published. |
| `description` | `String` | Human label (≤ 64 bytes). |

## Events

| Event | Fields |
|---|---|
| `MarketCreated` | `market_id: u64`, `market: pubkey`, `creator: pubkey`, `resolver: pubkey`, `close_time: i64`, `resolution_time: i64` |
| `LiquiditySeeded` | `market: pubkey`, `amount: u64` |
| `LiquidityAdded` | `market: pubkey`, `provider: pubkey`, `amount: u64`, `shares_minted: u64` |
| `LiquidityRemoved` | `market: pubkey`, `provider: pubkey`, `shares: u64`, `yes_out: u64`, `no_out: u64` |
| `TradeExecuted` | `market: pubkey`, `user: pubkey`, `is_buy: bool`, `outcome: u8`, `collateral: u64` (gross), `tokens: u64` |
| `OutcomeProposed` | `market: pubkey`, `resolver: pubkey`, `outcome: u8`, `proposed_at: i64` |
| `ScalarProposed` | `market: pubkey`, `resolver: pubkey`, `value: i64`, `proposed_at: i64` |
| `MarketResolved` | `market: pubkey`, `outcome: u8`, `settlement_fraction: u32` (scalar `f`; `0` for binary), `resolved_at: i64` (finalize time) |
| `MarketVoided` | `market: pubkey`, `reason: u8` (`0` DISPUTE, `1` STALE) |
| `Redeemed` | `market: pubkey`, `user: pubkey`, `amount: u64` (burned), `payout: u64` (collateral) |
| `PoolClaimed` | `market: pubkey`, `lp: pubkey` (caller), `provider: pubkey` (`position.owner`), `payout: u64` |
| `FeesCollected` | `market: pubkey`, `amount: u64` |
| `PausedSet` | `paused: bool` |
| `PriceFeedInitialized` | `feed: pubkey`, `authority: pubkey` |
| `PricePublished` | `feed: pubkey`, `value: i64`, `published_at: i64` |

Note `OutcomeProposed` is emitted by **both** `propose_outcome` and
`propose_from_oracle` (binary path); in the oracle case its `resolver` field
carries the feed pubkey. `ScalarProposed` is the scalar analogue, emitted by
`propose_scalar` (and the scalar branch of `propose_from_oracle` records the value
similarly). Fifteen events in total.

## Errors

Anchor custom errors start at code `6000` (`0x1770`).

| Code | Name | Meaning |
|---|---|---|
| 6000 | `FeeTooHigh` | Fee exceeds the maximum (1000 bps). |
| 6001 | `InvalidParameter` | Invalid parameter (e.g. zero resolver, out-of-range dispute period). |
| 6002 | `InvalidTimeWindow` | Need `0 < now < close_time <= resolution_time <= horizon`. |
| 6003 | `StringTooLong` | `question`/`resolution_source` over the length cap. |
| 6004 | `UnsupportedResolverKind` | `resolver_kind` other than `0` (TRUSTED_KEY) or `1` (ORACLE_FEED). |
| 6005 | `MarketNotOpen` | Market is not in the OPEN state. |
| 6006 | `MarketClosed` | Trading attempted at/after `close_time`. |
| 6007 | `Paused` | Protocol is paused. |
| 6008 | `AlreadySeeded` | Liquidity already seeded. |
| 6009 | `NoLiquidity` | Market has no liquidity to trade against / not seeded. |
| 6010 | `ZeroAmount` | Amount must be greater than zero (also: an `add_liquidity` dust add that would mint 0 shares). |
| 6011 | `InsufficientShares` | Position holds fewer pool shares than requested (`remove_liquidity`). |
| 6012 | `InvalidOutcome` | Outcome must be `0` (YES) or `1` (NO). |
| 6013 | `Unauthorized` | Caller is not the required admin/guardian/resolver/lp/creator. |
| 6014 | `WrongMint` | Token account has the wrong mint for this operation. |
| 6015 | `WrongOwner` | Token account has the wrong owner. |
| 6016 | `SlippageExceeded` | Trade outside the caller's slippage tolerance. |
| 6017 | `InsufficientLiquidity` | Not enough collateral/liquidity for the trade or payout. |
| 6018 | `NotResolved` | Operation needs a RESOLVED (or terminal) market. |
| 6019 | `NotProposed` | No outcome has been proposed (not RESOLVING). |
| 6020 | `NotVoid` | Operation needs a VOID market. |
| 6021 | `DisputeWindowOpen` | Cannot finalize yet; dispute window still open. |
| 6022 | `DisputeWindowClosed` | Cannot `dispute_void`; window has closed. |
| 6023 | `TooEarlyToResolve` | `propose_outcome`/`propose_scalar` before `resolution_time`. |
| 6024 | `TooEarlyToVoid` | `void_stale` before `resolution_time + 7d`. |
| 6025 | `NothingToClaim` | Nothing to claim/collect (zero shares, reserve, or fee). |
| 6026 | `WrongResolverKind` | Instruction used on the wrong `resolver_kind` (e.g. `propose_outcome` on an oracle market, or `propose_from_oracle` on a trusted-key market). |
| 6027 | `WrongMarketKind` | Instruction used on the wrong `market_kind` (e.g. `propose_outcome`/`redeem` on a scalar market, or `propose_scalar`/`redeem_scalar` on a binary market). |
| 6028 | `UnsupportedMarketKind` | `market_kind` other than `0` (BINARY) or `1` (SCALAR). |
| 6029 | `InvalidScalarRange` | Scalar market needs `lower_bound < upper_bound`. |
| 6030 | `InvalidComparison` | Unknown `oracle_comparison` code (must be `0` GTE or `1` LTE). |
| 6031 | `FeedHasNoValue` | The bound `PriceFeed` has never been published (`published_at == 0`). |
| 6032 | `StaleFeed` | The feed value is older than `oracle_max_staleness` at proposal time. |
| 6033 | `MathOverflow` | Arithmetic overflow / checked-math failure. |

## FPMM math (off-chain reference)

The host-tested functions in `math.rs`, mirrored by the SDK quote helpers:

| Function | Returns |
|---|---|
| `quote_buy(reserve_bought, reserve_other, a)` | `tokens_out`, `new_reserve_bought = ceil(k/(reserve_other+a))`, `new_reserve_other = reserve_other + a`. |
| `quote_sell(reserve_sold, reserve_other, a)` | `tokens_in`, `new_reserve_sold = ceil(k/(reserve_other−a))`, `new_reserve_other = reserve_other − a`. Requires `a < reserve_other`. |
| `marginal_price_micro(reserve_self, reserve_other)` | `reserve_other / (reserve_self + reserve_other) · 1e6` (probability ×1e6). |
| `fee_amount(amount, fee_bps)` | `floor(amount · fee_bps / 10_000)`. |
| `oracle_is_yes(value, strike, comparison)` | `Some(value >= strike)` for `CMP_GTE`, `Some(value <= strike)` for `CMP_LTE`, `None` for any other code. Exact integer comparison; boundary inclusive. |

Scalar settlement (`PRICE_SCALE = 1e6`):

| Function | Returns |
|---|---|
| `scalar_fraction(value, lower, upper)` | `Some(f)` where `f = (clamp(value, lower, upper) − lower) · 1e6 / (upper − lower)` in `[0, 1e6]`; `None` unless `upper > lower`. i128/u128 intermediates so the full i64 span is safe. |
| `scalar_payout(amount, fraction_micro, is_long)` | LONG → `floor(amount · f / 1e6)`; SHORT → `floor(amount · (1e6 − f) / 1e6)`. Both floor, so `long + short <= amount` (no overpay / conservation). |

LP-share math (Gnosis FPMM `addFunding`/`removeFunding`; all rounding favors the
pool / existing LPs):

| Function | Returns |
|---|---|
| `pool_weight(reserve_yes, reserve_no)` | `max(reserve_yes, reserve_no)` — the `add_liquidity` funding denominator. |
| `lp_shares_minted(amount, total_shares, pool_weight)` | `Some(floor(amount · total_shares / pool_weight))`; `None` on overflow or `pool_weight == 0`. Floored so the entrant is never over-credited. |
| `lp_add_keep(amount, reserve_side, pool_weight)` | `Some(ceil(amount · reserve_side / pool_weight))` — collateral/tokens the pool keeps of one side. Ceiled so the send-back is the smaller value. |
| `lp_add_sendback(amount, reserve_side, pool_weight)` | `Some(amount − lp_add_keep(...))` — surplus of one side returned to the LP (preserves the price ratio). |
| `lp_slice(reserve_side, shares, total_shares)` | `Some(floor(reserve_side · shares / total_shares))` — a provider's pro-rata slice of one reserve; used by `remove_liquidity` and `claim_pool`. Floored so dust stays with remaining LPs. |

All trade rounding keeps the pool's constant product non-decreasing: the retained
reserve is rounded **up**, so the trader gets slightly fewer tokens on a buy and
pays slightly more on a sell. The scalar/LP rounding above is chosen the same way
— always in favor of the pool. See [`ARCHITECTURE.md`](ARCHITECTURE.md) §2.
