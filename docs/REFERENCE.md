# Compute — Reference

The exhaustive on-chain surface of the `compute_markets` program: PDA seeds,
every instruction, every account field, every error, and every event. Derived
from the program source (`programs/compute-markets/src/`) and the authoritative
IDL (`target/idl/compute_markets.json`).

- **Program ID:** `8xv1L7757szxo2XPrQL5AERPGZrJaYRKgqB9RgFkQCU2`
- **Anchor / Solana:** Anchor `0.31.1`, legacy SPL Token.
- **Decimals:** collateral and outcome tokens use 6 decimals.
- **Counts:** 18 instructions · 2 accounts · 10 events · 26 error variants.

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
| `RESOLVER_TRUSTED_KEY` | `0` | The only `resolver_kind` wired today. |
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

## Instructions

Eighteen instructions. "Signer" is the privileged caller; remaining accounts are
abbreviated (full lists are in the IDL). PDAs are derived as above.

| # | Instruction | Args | Who may call | Signer | Effect |
|---|---|---|---|---|---|
| 1 | `initialize` | `fee_bps: u16`, `dispute_period: i64`, `guardian: Pubkey` | anyone (becomes admin) | `admin` | Create the singleton `Config`. One-time, irreversible. Validates `fee_bps <= 1000` and `0 <= dispute_period <= 30d`. |
| 2 | `create_market` | `question: String`, `resolution_source: String`, `close_time: i64`, `resolution_time: i64`, `resolver: Pubkey`, `resolver_kind: u8` | **anyone** (permissionless) | `creator` | Create a market + YES/NO mints + vault. Requires `resolver_kind == 0`, `resolver != default`, `close_time <= resolution_time`, `now < resolution_time <= now + horizon`, strings within length. Increments `market_count`. |
| 3 | `seed_liquidity` | `amount: u64` | market `creator` only, once | `lp` (= creator) | Create the YES/NO pools, deposit `amount` collateral, mint `amount` of each outcome at 50/50, set `lp`/`lp_shares`. Requires `OPEN`, not paused, not already seeded, `amount > 0`. |
| 4 | `buy` | `outcome: u8`, `collateral_in: u64`, `min_tokens_out: u64` | anyone | `user` | Invest collateral, mint a full set, swap out the bought side. Requires `OPEN`, not paused, `now < close_time`, liquidity present, `tokens_out >= min_tokens_out`. |
| 5 | `sell` | `outcome: u8`, `collateral_out: u64`, `max_tokens_in: u64` | anyone | `user` | Return outcome tokens, merge a full set out, pay collateral (net of fee). Requires `OPEN`, not paused, `now < close_time`, `collateral_out <= collateral`, `tokens_in <= max_tokens_in`. |
| 6 | `propose_outcome` | `outcome: u8` | market `resolver` only | `resolver` | Step 1 of resolution. `OPEN → RESOLVING`; records `proposed_outcome` + `resolved_at`. Requires `now >= resolution_time`. Opens the dispute window. |
| 7 | `finalize_outcome` | — | **anyone** (crank) | `cranker` | Step 2 of resolution. `RESOLVING → RESOLVED`; sets `outcome = proposed_outcome`. Requires `now >= resolved_at + dispute_period`. |
| 8 | `dispute_void` | — | `guardian` only | `guardian` | Guardian veto. `RESOLVING → VOID` (reason DISPUTE). Requires `now < resolved_at + dispute_period` (within the window). |
| 9 | `void_stale` | — | **anyone** (crank) | `cranker` | Liveness hatch. `OPEN → VOID` (reason STALE). Requires `now > resolution_time + 7d`. |
| 10 | `redeem` | `amount: u64` | any winning-token holder | `user` | Burn `amount` winning tokens for `amount` collateral. Requires `RESOLVED`, correct `winning_mint`, `amount <= collateral`. |
| 11 | `redeem_void` | `amount: u64` | any YES/NO holder | `user` | Burn `amount` of **either** outcome token for `amount / 2` collateral (rounded down). Requires `VOID`. |
| 12 | `claim_pool` | — | market `lp` only | `lp` | After settlement, LP reclaims pool reserves as collateral: winning reserve (RESOLVED) or half of each reserve (VOID). Requires `RESOLVED` or `VOID`, something to claim. |
| 13 | `collect_fees` | — | `admin` only | `admin` | Sweep `fee_accrued` for this market to the admin's token account; resets it to 0. Requires `fee_accrued > 0`. |
| 14 | `set_paused` | `paused: bool` | `admin` **or** `guardian` | `authority` | Toggle the global pause flag. Emits `PausedSet`. |
| 15 | `set_fee_bps` | `fee_bps: u16` | `admin` only | `admin` | Update the taker fee. Re-checks `fee_bps <= 1000`. |
| 16 | `set_guardian` | `guardian: Pubkey` | `admin` only | `admin` | Replace the guardian key. |
| 17 | `set_admin` | `new_admin: Pubkey` | `admin` only | `admin` | Two-step transfer step 1: nominate `pending_admin`. |
| 18 | `accept_admin` | — | the nominated `pending_admin` | `pending_admin` | Two-step transfer step 2: accept; sets `admin`, clears `pending_admin`. |

### Account lists (key accounts per instruction)

PDAs validated by seeds/address; token programs and sysvars omitted for brevity.

| Instruction | Notable accounts |
|---|---|
| `initialize` | `config` (init), `collateral_mint`, `admin` (signer) |
| `create_market` | `config` (mut), `market` (init), `yes_mint`/`no_mint`/`vault` (init), `collateral_mint`, `creator` (signer) |
| `seed_liquidity` | `config`, `market` (mut), `yes_mint`/`no_mint`/`vault` (mut), `pool_yes`/`pool_no` (init), `lp_collateral`, `lp` (signer) |
| `buy` / `sell` | `config`, `market` (mut), `yes_mint`/`no_mint`/`pool_yes`/`pool_no`/`vault` (mut), `user_outcome`, `user_collateral`, `user` (signer) |
| `propose_outcome` | `market` (mut), `resolver` (signer) |
| `finalize_outcome` | `config`, `market` (mut), `cranker` (signer) |
| `dispute_void` | `config`, `market` (mut), `guardian` (signer) |
| `void_stale` | `market` (mut), `cranker` (signer) |
| `redeem` / `redeem_void` | `market` (mut), `winning_mint`, `vault`, `user_outcome`, `user_collateral`, `user` (signer) |
| `claim_pool` | `market` (mut), `yes_mint`/`no_mint`/`pool_yes`/`pool_no`/`vault` (mut), `lp_collateral`, `lp` (signer) |
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
| `resolver` | `pubkey` | Key allowed to `propose_outcome`. |
| `resolver_kind` | `u8` | Resolver type. Only `0` (TRUSTED_KEY) is accepted today. |
| `collateral_mint` | `pubkey` | Collateral mint (matches `Config`). |
| `yes_mint` / `no_mint` | `pubkey` | Outcome token mints (authority = this PDA). |
| `vault` | `pubkey` | Collateral token account (authority = this PDA). |
| `pool_yes` / `pool_no` | `pubkey` | AMM reserve token accounts (set at seed). |
| `reserve_yes` / `reserve_no` | `u64` | AMM reserves (the FPMM `(r_yes, r_no)`). |
| `lp` | `pubkey` | The single liquidity provider (= creator). |
| `lp_shares` | `u64` | LP's recorded seed amount (single-seed MVP). |
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
| `reserved` | `[u8; 64]` | Forward-compat padding for future oracle configs. |
| `bump` | `u8` | PDA bump. |

## Events

| Event | Fields |
|---|---|
| `MarketCreated` | `market_id: u64`, `market: pubkey`, `creator: pubkey`, `resolver: pubkey`, `close_time: i64`, `resolution_time: i64` |
| `LiquiditySeeded` | `market: pubkey`, `amount: u64` |
| `TradeExecuted` | `market: pubkey`, `user: pubkey`, `is_buy: bool`, `outcome: u8`, `collateral: u64` (gross), `tokens: u64` |
| `OutcomeProposed` | `market: pubkey`, `resolver: pubkey`, `outcome: u8`, `proposed_at: i64` |
| `MarketResolved` | `market: pubkey`, `outcome: u8`, `resolved_at: i64` (finalize time) |
| `MarketVoided` | `market: pubkey`, `reason: u8` (`0` DISPUTE, `1` STALE) |
| `Redeemed` | `market: pubkey`, `user: pubkey`, `amount: u64` (burned), `payout: u64` (collateral) |
| `PoolClaimed` | `market: pubkey`, `lp: pubkey`, `payout: u64` |
| `FeesCollected` | `market: pubkey`, `amount: u64` |
| `PausedSet` | `paused: bool` |

## Errors

Anchor custom errors start at code `6000` (`0x1770`).

| Code | Name | Meaning |
|---|---|---|
| 6000 | `FeeTooHigh` | Fee exceeds the maximum (1000 bps). |
| 6001 | `InvalidParameter` | Invalid parameter (e.g. zero resolver, out-of-range dispute period). |
| 6002 | `InvalidTimeWindow` | Need `0 < now < close_time <= resolution_time <= horizon`. |
| 6003 | `StringTooLong` | `question`/`resolution_source` over the length cap. |
| 6004 | `UnsupportedResolverKind` | `resolver_kind` other than `0` (TRUSTED_KEY). |
| 6005 | `MarketNotOpen` | Market is not in the OPEN state. |
| 6006 | `MarketClosed` | Trading attempted at/after `close_time`. |
| 6007 | `Paused` | Protocol is paused. |
| 6008 | `AlreadySeeded` | Liquidity already seeded. |
| 6009 | `NoLiquidity` | Market has no liquidity to trade against. |
| 6010 | `ZeroAmount` | Amount must be greater than zero. |
| 6011 | `InvalidOutcome` | Outcome must be `0` (YES) or `1` (NO). |
| 6012 | `Unauthorized` | Caller is not the required admin/guardian/resolver/lp/creator. |
| 6013 | `WrongMint` | Token account has the wrong mint for this operation. |
| 6014 | `WrongOwner` | Token account has the wrong owner. |
| 6015 | `SlippageExceeded` | Trade outside the caller's slippage tolerance. |
| 6016 | `InsufficientLiquidity` | Not enough collateral/liquidity for the trade or payout. |
| 6017 | `NotResolved` | Operation needs a RESOLVED (or terminal) market. |
| 6018 | `NotProposed` | No outcome has been proposed (not RESOLVING). |
| 6019 | `NotVoid` | Operation needs a VOID market. |
| 6020 | `DisputeWindowOpen` | Cannot finalize yet; dispute window still open. |
| 6021 | `DisputeWindowClosed` | Cannot `dispute_void`; window has closed. |
| 6022 | `TooEarlyToResolve` | `propose_outcome` before `resolution_time`. |
| 6023 | `TooEarlyToVoid` | `void_stale` before `resolution_time + 7d`. |
| 6024 | `NothingToClaim` | Nothing to claim/collect (zero reserve or fee). |
| 6025 | `MathOverflow` | Arithmetic overflow / checked-math failure. |

## FPMM math (off-chain reference)

The host-tested functions in `math.rs`, mirrored by the SDK quote helpers:

| Function | Returns |
|---|---|
| `quote_buy(reserve_bought, reserve_other, a)` | `tokens_out`, `new_reserve_bought = ceil(k/(reserve_other+a))`, `new_reserve_other = reserve_other + a`. |
| `quote_sell(reserve_sold, reserve_other, a)` | `tokens_in`, `new_reserve_sold = ceil(k/(reserve_other−a))`, `new_reserve_other = reserve_other − a`. Requires `a < reserve_other`. |
| `marginal_price_micro(reserve_self, reserve_other)` | `reserve_other / (reserve_self + reserve_other) · 1e6` (probability ×1e6). |
| `fee_amount(amount, fee_bps)` | `floor(amount · fee_bps / 10_000)`. |

All rounding keeps the pool's constant product non-decreasing: the retained
reserve is rounded **up**, so the trader gets slightly fewer tokens on a buy and
pays slightly more on a sell. See [`ARCHITECTURE.md`](ARCHITECTURE.md) §2.
