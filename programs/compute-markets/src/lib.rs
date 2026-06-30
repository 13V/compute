//! # Compute Markets
//!
//! On-chain prediction markets for **trading on compute** (GPU/cloud/AI-compute
//! prices and milestones) on Solana.
//!
//! Each market is binary (YES / NO) and uses a **fixed-product market maker
//! (FPMM)** so traders get continuous, always-on pricing. Collateral is any SPL
//! token chosen at `initialize` time (USDC in production). The economically
//! load-bearing arithmetic lives in [`math`] and is unit-tested on the host.
//!
//! ## Lifecycle
//!
//! `initialize` → `create_market` → `seed_liquidity` → `buy`/`sell` (until
//! `close_time`) → `propose_outcome` → `finalize_outcome` (after the dispute
//! window) → `redeem` / `claim_pool` / `collect_fees`.
//!
//! Settlement is deliberately defended in depth, because a manual resolver is a
//! trusted component:
//! * **Two-step resolution.** The resolver only *proposes* an outcome; payouts
//!   unlock after a configurable `dispute_period`, giving a guardian time to veto.
//! * **Guardian veto.** During the dispute window the guardian can `dispute_void`
//!   a bad proposal, sending the market to a 50/50 refund.
//! * **Liveness escape hatch.** If the resolver never proposes, anyone may
//!   `void_stale` the market after a grace period so collateral is never stranded.
//! * **Pause switch.** The admin or guardian can pause trading in an incident.
//!
//! `resolver_kind` + a reserved padding region make room for pluggable oracle
//! resolvers (Switchboard / Pyth / optimistic) without a layout-breaking change;
//! only `TRUSTED_KEY` is wired today.
//!
//! ## Conservation invariant
//!
//! At all times `vault == market.collateral + market.fee_accrued`. Every YES is
//! matched 1:1 by a NO (minted/burned only as full sets), so on a YES/NO
//! resolution the winning-side supply equals `market.collateral`; on a void each
//! outcome token is worth exactly half of collateral, which also conserves.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

pub mod math;

declare_id!("8xv1L7757szxo2XPrQL5AERPGZrJaYRKgqB9RgFkQCU2");

/// YES outcome index.
pub const OUTCOME_YES: u8 = 0;
/// NO outcome index.
pub const OUTCOME_NO: u8 = 1;

/// Binary market: a YES/NO question; the winning side redeems 1:1.
pub const MARKET_BINARY: u8 = 0;
/// Scalar / range market: reuses the binary FPMM with YES=LONG, NO=SHORT. A full
/// set (1 LONG + 1 SHORT) is always worth 1 collateral. At settlement a fraction
/// `f` in `[0, 1]` (scaled by [`math::PRICE_SCALE`]) determines payouts: LONG
/// settles at `f`, SHORT at `1 - f`. See [`math::scalar_fraction`].
pub const MARKET_SCALAR: u8 = 1;

/// Fixed-point scale for scalar settlement fractions (re-exported from [`math`]).
pub const PRICE_SCALE: u64 = math::PRICE_SCALE;

/// Open for trading.
pub const STATE_OPEN: u8 = 0;
/// An outcome has been proposed and is in the dispute window.
pub const STATE_RESOLVING: u8 = 1;
/// Finalized to a YES/NO outcome; winning tokens redeem 1:1.
pub const STATE_RESOLVED: u8 = 2;
/// Voided/invalid; every outcome token redeems for half of collateral.
pub const STATE_VOID: u8 = 3;

/// Trusted single-key resolver: the market's `resolver` proposes the outcome.
pub const RESOLVER_TRUSTED_KEY: u8 = 0;
/// Oracle-feed resolver: the outcome is derived permissionlessly from an on-chain
/// [`PriceFeed`] (the bridge target for a Switchboard On-Demand Function or a
/// committee multisig) by comparing its value to the market's strike.
pub const RESOLVER_ORACLE_FEED: u8 = 1;
/// Optimistic-oracle resolver (UMA-style): ANYONE may `assert_outcome` by posting
/// a bond; ANYONE may `dispute_assertion` with an equal bond. An undisputed
/// assertion `finalize_assertion`s after the dispute window (the asserter reclaims
/// their bond); a disputed one is settled by the guardian via `resolve_dispute`,
/// who awards both bonds to whoever asserted the correct outcome. Bonds live in a
/// SEPARATE bond vault so the market collateral vault (and its conservation
/// invariant) is never touched. BINARY markets only.
pub const RESOLVER_OPTIMISTIC: u8 = 2;

/// Maximum protocol fee (10%).
pub const MAX_FEE_BPS: u16 = 1_000;
/// Maximum dispute period (30 days) — a sanity bound on the timelock.
pub const MAX_DISPUTE_PERIOD: i64 = 30 * 24 * 60 * 60;
/// Maximum market horizon from creation (~2 years) — bounds `resolution_time`.
pub const MAX_MARKET_HORIZON: i64 = 2 * 366 * 24 * 60 * 60;
/// Grace period after `resolution_time` before anyone may void a stale market (7 days).
pub const VOID_GRACE_PERIOD: i64 = 7 * 24 * 60 * 60;

pub const MARKET_SEED: &[u8] = b"market";
pub const CONFIG_SEED: &[u8] = b"config";
pub const YES_SEED: &[u8] = b"yes";
pub const NO_SEED: &[u8] = b"no";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POOL_YES_SEED: &[u8] = b"pool_yes";
pub const POOL_NO_SEED: &[u8] = b"pool_no";
/// Per-provider liquidity-position PDA seed: `[LP_SEED, market, owner]`.
pub const LP_SEED: &[u8] = b"lp";
/// Bond-vault PDA seed: `[BOND_SEED, market]`. A token account (collateral mint,
/// authority = market) that escrows optimistic-resolver assert/dispute bonds,
/// kept strictly separate from the market collateral vault.
pub const BOND_SEED: &[u8] = b"bond";

/// One side of a binary market. Centralizes the YES/NO ↔ reserve mapping so the
/// trade handlers never hand-mirror branches (a transposed branch would be a
/// silent fund-routing bug).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Yes,
    No,
}

impl Side {
    pub fn from_u8(o: u8) -> Result<Self> {
        match o {
            OUTCOME_YES => Ok(Side::Yes),
            OUTCOME_NO => Ok(Side::No),
            _ => err!(ErrorCode::InvalidOutcome),
        }
    }
}

#[program]
pub mod compute_markets {
    use super::*;

    /// Initialize the global config (one per deployment).
    ///
    /// * `fee_bps` — taker fee on buy/sell (e.g. 100 = 1%), capped at `MAX_FEE_BPS`.
    /// * `lp_fee_bps` — fraction OF THE TAKER FEE routed to LPs, in basis points
    ///   (0..=10_000; 10_000 = the entire fee to LPs).
    /// * `dispute_period` — seconds between a proposed outcome and payout unlock.
    /// * `guardian` — key allowed to pause and to veto a proposed outcome.
    /// * `bond_amount` — the bond required to `assert_outcome` / `dispute_assertion`
    ///   on an optimistic-resolver market (0 disables optimistic assertions).
    pub fn initialize(
        ctx: Context<Initialize>,
        fee_bps: u16,
        lp_fee_bps: u16,
        dispute_period: i64,
        guardian: Pubkey,
        bond_amount: u64,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, ErrorCode::FeeTooHigh);
        require!(
            lp_fee_bps <= math::BPS_DENOMINATOR as u16,
            ErrorCode::InvalidParameter
        );
        require!(
            (0..=MAX_DISPUTE_PERIOD).contains(&dispute_period),
            ErrorCode::InvalidParameter
        );
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.pending_admin = Pubkey::default();
        config.guardian = guardian;
        config.collateral_mint = ctx.accounts.collateral_mint.key();
        config.fee_bps = fee_bps;
        config.lp_fee_bps = lp_fee_bps;
        config.dispute_period = dispute_period;
        config.market_count = 0;
        config.paused = false;
        config.bond_amount = bond_amount;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Create a new binary market. Permissionless: anyone may create one and
    /// nominate a `resolver`. Trading halts at `close_time`; the outcome may be
    /// proposed at/after `resolution_time` (`close_time <= resolution_time`).
    #[allow(clippy::too_many_arguments)]
    pub fn create_market(
        ctx: Context<CreateMarket>,
        question: String,
        resolution_source: String,
        close_time: i64,
        resolution_time: i64,
        resolver: Pubkey,
        resolver_kind: u8,
        oracle_feed: Pubkey,
        oracle_strike: i64,
        oracle_comparison: u8,
        oracle_max_staleness: i64,
        market_kind: u8,
        lower_bound: i64,
        upper_bound: i64,
    ) -> Result<()> {
        require!(
            question.len() <= Market::MAX_QUESTION,
            ErrorCode::StringTooLong
        );
        require!(
            resolution_source.len() <= Market::MAX_SOURCE,
            ErrorCode::StringTooLong
        );
        match resolver_kind {
            RESOLVER_TRUSTED_KEY => {
                require!(resolver != Pubkey::default(), ErrorCode::InvalidParameter);
            }
            RESOLVER_ORACLE_FEED => {
                require!(
                    oracle_feed != Pubkey::default(),
                    ErrorCode::InvalidParameter
                );
                require!(oracle_max_staleness > 0, ErrorCode::InvalidParameter);
                require!(
                    math::oracle_is_yes(0, 0, oracle_comparison).is_some(),
                    ErrorCode::InvalidComparison
                );
            }
            RESOLVER_OPTIMISTIC => {
                // No oracle/strike/resolver validation: the asserter is permissionless
                // and posts a bond at `assert_outcome` time. `resolver` may be default.
            }
            _ => return err!(ErrorCode::UnsupportedResolverKind),
        }

        // Scalar markets need a non-degenerate range; binary markets ignore the
        // bounds (stored as 0).
        let (stored_lower, stored_upper) = match market_kind {
            MARKET_BINARY => (0i64, 0i64),
            MARKET_SCALAR => {
                require!(lower_bound < upper_bound, ErrorCode::InvalidScalarRange);
                (lower_bound, upper_bound)
            }
            _ => return err!(ErrorCode::UnsupportedMarketKind),
        };

        let now = Clock::get()?.unix_timestamp;
        require!(close_time <= resolution_time, ErrorCode::InvalidTimeWindow);
        require!(resolution_time > now, ErrorCode::InvalidTimeWindow);
        require!(
            resolution_time <= now + MAX_MARKET_HORIZON,
            ErrorCode::InvalidTimeWindow
        );

        let market_id = ctx.accounts.config.market_count;
        let market = &mut ctx.accounts.market;
        market.market_id = market_id;
        market.creator = ctx.accounts.creator.key();
        market.resolver = resolver;
        market.resolver_kind = resolver_kind;
        market.market_kind = market_kind;
        market.lower_bound = stored_lower;
        market.upper_bound = stored_upper;
        market.proposed_value = 0;
        market.settlement_fraction = 0;
        market.oracle_feed = oracle_feed;
        market.oracle_strike = oracle_strike;
        market.oracle_comparison = oracle_comparison;
        market.oracle_max_staleness = oracle_max_staleness;
        market.collateral_mint = ctx.accounts.collateral_mint.key();
        market.yes_mint = ctx.accounts.yes_mint.key();
        market.no_mint = ctx.accounts.no_mint.key();
        market.vault = ctx.accounts.vault.key();
        market.pool_yes = Pubkey::default();
        market.pool_no = Pubkey::default();
        market.reserve_yes = 0;
        market.reserve_no = 0;
        market.lp = Pubkey::default();
        market.total_shares = 0;
        market.collateral = 0;
        market.fee_accrued = 0;
        market.state = STATE_OPEN;
        market.outcome = 0;
        market.proposed_outcome = 0;
        market.asserter = Pubkey::default();
        market.disputer = Pubkey::default();
        market.bond = 0;
        market.disputed = false;
        market.close_time = close_time;
        market.resolution_time = resolution_time;
        market.resolved_at = 0;
        market.question = question;
        market.resolution_source = resolution_source;
        market.reserved = [0u8; Market::RESERVED];
        market.bump = ctx.bumps.market;

        ctx.accounts.config.market_count =
            market_id.checked_add(1).ok_or(ErrorCode::MathOverflow)?;

        emit!(MarketCreated {
            market_id,
            market: market.key(),
            creator: market.creator,
            resolver,
            close_time,
            resolution_time,
        });
        Ok(())
    }

    /// Seed the AMM with initial liquidity at 50/50 odds. Callable once, by the
    /// market creator, before any trading.
    pub fn seed_liquidity(ctx: Context<SeedLiquidity>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, ErrorCode::Paused);
        let market = &mut ctx.accounts.market;
        require!(market.state == STATE_OPEN, ErrorCode::MarketNotOpen);
        require!(
            ctx.accounts.lp.key() == market.creator,
            ErrorCode::Unauthorized
        );
        require!(
            market.reserve_yes == 0 && market.reserve_no == 0,
            ErrorCode::AlreadySeeded
        );
        require!(amount > 0, ErrorCode::ZeroAmount);

        market.pool_yes = ctx.accounts.pool_yes.key();
        market.pool_no = ctx.accounts.pool_no.key();
        market.lp = ctx.accounts.lp.key();
        // The creator starts with 100% of the pool: total_shares == their shares.
        market.total_shares = amount;
        market.reserve_yes = amount;
        market.reserve_no = amount;
        market.collateral = amount;

        let position = &mut ctx.accounts.position;
        position.market = market.key();
        position.owner = ctx.accounts.lp.key();
        position.shares = amount;
        position.bump = ctx.bumps.position;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.lp_collateral.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.lp.to_account_info(),
                },
            ),
            amount,
        )?;

        let id_bytes = market.market_id.to_le_bytes();
        let bump_seed = [market.bump];
        let seeds: &[&[u8]] = &[MARKET_SEED, id_bytes.as_ref(), bump_seed.as_ref()];
        let signer: &[&[&[u8]]] = &[seeds];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.yes_mint.to_account_info(),
                    to: ctx.accounts.pool_yes.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.no_mint.to_account_info(),
                    to: ctx.accounts.pool_no.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        emit!(LiquiditySeeded {
            market: market.key(),
            amount
        });
        Ok(())
    }

    /// Add liquidity to an already-seeded, OPEN market (Gnosis FPMM `addFunding`).
    ///
    /// The provider deposits `amount` collateral; the protocol mints a full set
    /// (`amount` YES + `amount` NO) into the pool and sends back the surplus of
    /// each side so the **price ratio is preserved**. Shares are minted pro-rata
    /// to `amount / max(reserve_yes, reserve_no)`.
    ///
    /// Rounding (favors the pool / existing LPs):
    /// * `shares_minted` is FLOORED — the entrant is never over-credited.
    /// * the reserve the pool keeps of each side is CEILED — the send-back to the
    ///   LP is the smaller value, so the pool retains at least its fair share.
    /// A dust add that would mint 0 shares is rejected (`ZeroAmount`).
    pub fn add_liquidity(ctx: Context<AddLiquidity>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, ErrorCode::Paused);
        require!(amount > 0, ErrorCode::ZeroAmount);

        let market = &mut ctx.accounts.market;
        require!(market.state == STATE_OPEN, ErrorCode::MarketNotOpen);
        require!(
            market.reserve_yes > 0 && market.reserve_no > 0,
            ErrorCode::NoLiquidity
        );
        require!(market.total_shares > 0, ErrorCode::NoLiquidity);

        let r_yes = market.reserve_yes;
        let r_no = market.reserve_no;
        let total = market.total_shares;
        let weight = math::pool_weight(r_yes, r_no);

        let shares_minted =
            math::lp_shares_minted(amount, total, weight).ok_or(ErrorCode::MathOverflow)?;
        // Reject dust adds that would mint 0 shares (would be free outcome tokens).
        require!(shares_minted > 0, ErrorCode::ZeroAmount);

        let sendback_yes =
            math::lp_add_sendback(amount, r_yes, weight).ok_or(ErrorCode::MathOverflow)?;
        let sendback_no =
            math::lp_add_sendback(amount, r_no, weight).ok_or(ErrorCode::MathOverflow)?;

        // 1. Pull `amount` collateral from the LP into the vault.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.lp_collateral.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.lp.to_account_info(),
                },
            ),
            amount,
        )?;
        market.collateral = market
            .collateral
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?;

        let id_bytes = market.market_id.to_le_bytes();
        let bump_seed = [market.bump];
        let seeds: &[&[u8]] = &[MARKET_SEED, id_bytes.as_ref(), bump_seed.as_ref()];
        let signer: &[&[&[u8]]] = &[seeds];

        // 2. Mint a full set (`amount` of each outcome) into the pools.
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.yes_mint.to_account_info(),
                    to: ctx.accounts.pool_yes.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.no_mint.to_account_info(),
                    to: ctx.accounts.pool_no.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        // 3. Send the surplus of each side back to the LP (price-ratio preserving).
        if sendback_yes > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.pool_yes.to_account_info(),
                        to: ctx.accounts.lp_yes.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                sendback_yes,
            )?;
        }
        if sendback_no > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.pool_no.to_account_info(),
                        to: ctx.accounts.lp_no.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                sendback_no,
            )?;
        }

        // 4. New reserves: r_i + amount - sendback_i (== r_i + keep_i). Update
        //    share bookkeeping.
        market.reserve_yes = r_yes
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_sub(sendback_yes)
            .ok_or(ErrorCode::MathOverflow)?;
        market.reserve_no = r_no
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_sub(sendback_no)
            .ok_or(ErrorCode::MathOverflow)?;
        market.total_shares = total
            .checked_add(shares_minted)
            .ok_or(ErrorCode::MathOverflow)?;

        let position = &mut ctx.accounts.position;
        position.market = market.key();
        position.owner = ctx.accounts.lp.key();
        position.shares = position
            .shares
            .checked_add(shares_minted)
            .ok_or(ErrorCode::MathOverflow)?;
        if position.bump == 0 {
            position.bump = ctx.bumps.position;
        }

        emit!(LiquidityAdded {
            market: market.key(),
            provider: ctx.accounts.lp.key(),
            amount,
            shares_minted,
        });
        Ok(())
    }

    /// Remove liquidity from an OPEN market (Gnosis FPMM `removeFunding`).
    ///
    /// Burns `shares` of the caller's pool position and transfers their pro-rata
    /// slice of each reserve out to the LP's outcome ATAs:
    /// `send_i = floor(reserve_i * shares / total_shares)` (FLOORED so remaining
    /// LPs are never short-changed). Collateral is unchanged — the outcome tokens
    /// stay outstanding, just held by the LP, who can later merge equal YES+NO via
    /// `sell` / redemption or hold to settlement.
    pub fn remove_liquidity(ctx: Context<RemoveLiquidity>, shares: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, ErrorCode::Paused);
        require!(shares > 0, ErrorCode::ZeroAmount);

        let market = &mut ctx.accounts.market;
        require!(market.state == STATE_OPEN, ErrorCode::MarketNotOpen);
        require!(
            shares <= ctx.accounts.position.shares,
            ErrorCode::InsufficientShares
        );

        let total = market.total_shares;
        require!(total > 0, ErrorCode::NoLiquidity);
        let send_yes =
            math::lp_slice(market.reserve_yes, shares, total).ok_or(ErrorCode::MathOverflow)?;
        let send_no =
            math::lp_slice(market.reserve_no, shares, total).ok_or(ErrorCode::MathOverflow)?;

        let id_bytes = market.market_id.to_le_bytes();
        let bump_seed = [market.bump];
        let seeds: &[&[u8]] = &[MARKET_SEED, id_bytes.as_ref(), bump_seed.as_ref()];
        let signer: &[&[&[u8]]] = &[seeds];

        if send_yes > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.pool_yes.to_account_info(),
                        to: ctx.accounts.lp_yes.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                send_yes,
            )?;
        }
        if send_no > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.pool_no.to_account_info(),
                        to: ctx.accounts.lp_no.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                send_no,
            )?;
        }

        market.reserve_yes = market
            .reserve_yes
            .checked_sub(send_yes)
            .ok_or(ErrorCode::MathOverflow)?;
        market.reserve_no = market
            .reserve_no
            .checked_sub(send_no)
            .ok_or(ErrorCode::MathOverflow)?;
        market.total_shares = total.checked_sub(shares).ok_or(ErrorCode::MathOverflow)?;

        let position = &mut ctx.accounts.position;
        position.shares = position
            .shares
            .checked_sub(shares)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(LiquidityRemoved {
            market: market.key(),
            provider: ctx.accounts.lp.key(),
            shares,
            yes_out: send_yes,
            no_out: send_no,
        });
        Ok(())
    }

    /// Buy `outcome` by investing `collateral_in`. Reverts if fewer than
    /// `min_tokens_out` would be received, if paused, or after `close_time`.
    pub fn buy(
        ctx: Context<Trade>,
        outcome: u8,
        collateral_in: u64,
        min_tokens_out: u64,
    ) -> Result<()> {
        let side = Side::from_u8(outcome)?;
        require!(!ctx.accounts.config.paused, ErrorCode::Paused);
        require!(collateral_in > 0, ErrorCode::ZeroAmount);

        let market = &mut ctx.accounts.market;
        require!(market.state == STATE_OPEN, ErrorCode::MarketNotOpen);
        require!(
            Clock::get()?.unix_timestamp < market.close_time,
            ErrorCode::MarketClosed
        );
        require!(
            market.reserve_yes > 0 && market.reserve_no > 0,
            ErrorCode::NoLiquidity
        );

        let bought_mint = market.outcome_mint(side);
        require_keys_eq!(
            ctx.accounts.user_outcome.mint,
            bought_mint,
            ErrorCode::WrongMint
        );
        require_keys_eq!(
            ctx.accounts.user_outcome.owner,
            ctx.accounts.user.key(),
            ErrorCode::WrongOwner
        );

        let fee = math::fee_amount(collateral_in, ctx.accounts.config.fee_bps)
            .ok_or(ErrorCode::MathOverflow)?;
        let a = collateral_in
            .checked_sub(fee)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(a > 0, ErrorCode::ZeroAmount);

        let (reserve_bought, reserve_other) = market.reserves(side);
        let quote =
            math::quote_buy(reserve_bought, reserve_other, a).ok_or(ErrorCode::MathOverflow)?;
        require!(
            quote.tokens_out >= min_tokens_out,
            ErrorCode::SlippageExceeded
        );
        require!(quote.tokens_out > 0, ErrorCode::ZeroAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_collateral.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            collateral_in,
        )?;

        let id_bytes = market.market_id.to_le_bytes();
        let bump_seed = [market.bump];
        let seeds: &[&[u8]] = &[MARKET_SEED, id_bytes.as_ref(), bump_seed.as_ref()];
        let signer: &[&[&[u8]]] = &[seeds];
        // Mint a full set into the pool.
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.yes_mint.to_account_info(),
                    to: ctx.accounts.pool_yes.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer,
            ),
            a,
        )?;
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.no_mint.to_account_info(),
                    to: ctx.accounts.pool_no.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer,
            ),
            a,
        )?;

        // Swap: deliver the bought side from its pool to the trader.
        let bought_pool = match side {
            Side::Yes => ctx.accounts.pool_yes.to_account_info(),
            Side::No => ctx.accounts.pool_no.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: bought_pool,
                    to: ctx.accounts.user_outcome.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer,
            ),
            quote.tokens_out,
        )?;

        market.set_reserves(side, quote.new_reserve_bought, quote.new_reserve_other);
        market.collateral = market
            .collateral
            .checked_add(a)
            .ok_or(ErrorCode::MathOverflow)?;

        // Split the fee: a configurable cut is reinvested as pool liquidity for
        // LPs, the rest accrues to the protocol. The LP cut is floored so the
        // protocol is never shorted.
        let lp_cut =
            math::lp_fee_cut(fee, ctx.accounts.config.lp_fee_bps).ok_or(ErrorCode::MathOverflow)?;
        let protocol_cut = fee.checked_sub(lp_cut).ok_or(ErrorCode::MathOverflow)?;
        market.fee_accrued = market
            .fee_accrued
            .checked_add(protocol_cut)
            .ok_or(ErrorCode::MathOverflow)?;

        if lp_cut > 0 {
            // Reinvest the LP cut as a full set minted into the pool reserves,
            // which lifts every LP's pro-rata claim with no per-LP accounting.
            // DELIBERATE side effect: minting an equal full set into
            // possibly-unequal reserves nudges the marginal price slightly toward
            // 0.5. This is intended (fee reinvestment) and tiny — `lp_cut` is at
            // most `fee_bps * lp_fee_bps` of a single trade. Conservation is
            // preserved: `collateral += lp_cut` and the vault already holds the
            // full `collateral_in`, so `vault == collateral + fee_accrued` holds.
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.yes_mint.to_account_info(),
                        to: ctx.accounts.pool_yes.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                lp_cut,
            )?;
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.no_mint.to_account_info(),
                        to: ctx.accounts.pool_no.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                lp_cut,
            )?;
            market.reserve_yes = market
                .reserve_yes
                .checked_add(lp_cut)
                .ok_or(ErrorCode::MathOverflow)?;
            market.reserve_no = market
                .reserve_no
                .checked_add(lp_cut)
                .ok_or(ErrorCode::MathOverflow)?;
            market.collateral = market
                .collateral
                .checked_add(lp_cut)
                .ok_or(ErrorCode::MathOverflow)?;
        }

        emit!(TradeExecuted {
            market: market.key(),
            user: ctx.accounts.user.key(),
            is_buy: true,
            outcome,
            collateral: collateral_in,
            tokens: quote.tokens_out,
        });
        Ok(())
    }

    /// Sell `outcome` to withdraw `collateral_out` (gross). Reverts if more than
    /// `max_tokens_in` would be required, if paused, or after `close_time`.
    pub fn sell(
        ctx: Context<Trade>,
        outcome: u8,
        collateral_out: u64,
        max_tokens_in: u64,
    ) -> Result<()> {
        let side = Side::from_u8(outcome)?;
        require!(!ctx.accounts.config.paused, ErrorCode::Paused);
        require!(collateral_out > 0, ErrorCode::ZeroAmount);

        let market = &mut ctx.accounts.market;
        require!(market.state == STATE_OPEN, ErrorCode::MarketNotOpen);
        require!(
            Clock::get()?.unix_timestamp < market.close_time,
            ErrorCode::MarketClosed
        );
        require!(
            collateral_out <= market.collateral,
            ErrorCode::InsufficientLiquidity
        );

        let sold_mint = market.outcome_mint(side);
        require_keys_eq!(
            ctx.accounts.user_outcome.mint,
            sold_mint,
            ErrorCode::WrongMint
        );
        require_keys_eq!(
            ctx.accounts.user_outcome.owner,
            ctx.accounts.user.key(),
            ErrorCode::WrongOwner
        );

        let (reserve_sold, reserve_other) = market.reserves(side);
        let quote = math::quote_sell(reserve_sold, reserve_other, collateral_out)
            .ok_or(ErrorCode::InsufficientLiquidity)?;
        require!(
            quote.tokens_in <= max_tokens_in,
            ErrorCode::SlippageExceeded
        );
        require!(quote.tokens_in > 0, ErrorCode::ZeroAmount);

        let fee = math::fee_amount(collateral_out, ctx.accounts.config.fee_bps)
            .ok_or(ErrorCode::MathOverflow)?;
        let to_user = collateral_out
            .checked_sub(fee)
            .ok_or(ErrorCode::MathOverflow)?;

        let sold_pool = match side {
            Side::Yes => ctx.accounts.pool_yes.to_account_info(),
            Side::No => ctx.accounts.pool_no.to_account_info(),
        };
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_outcome.to_account_info(),
                    to: sold_pool,
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            quote.tokens_in,
        )?;

        let id_bytes = market.market_id.to_le_bytes();
        let bump_seed = [market.bump];
        let seeds: &[&[u8]] = &[MARKET_SEED, id_bytes.as_ref(), bump_seed.as_ref()];
        let signer: &[&[&[u8]]] = &[seeds];
        // Merge a full set out of the pool.
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.yes_mint.to_account_info(),
                    from: ctx.accounts.pool_yes.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer,
            ),
            collateral_out,
        )?;
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.no_mint.to_account_info(),
                    from: ctx.accounts.pool_no.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer,
            ),
            collateral_out,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_collateral.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer,
            ),
            to_user,
        )?;

        market.set_reserves(side, quote.new_reserve_sold, quote.new_reserve_other);
        market.collateral = market
            .collateral
            .checked_sub(collateral_out)
            .ok_or(ErrorCode::MathOverflow)?;

        // Split the fee symmetrically with `buy`: a configurable cut is reinvested
        // as pool liquidity for LPs (floored so the protocol is never shorted),
        // the rest accrues to the protocol.
        let lp_cut =
            math::lp_fee_cut(fee, ctx.accounts.config.lp_fee_bps).ok_or(ErrorCode::MathOverflow)?;
        let protocol_cut = fee.checked_sub(lp_cut).ok_or(ErrorCode::MathOverflow)?;
        market.fee_accrued = market
            .fee_accrued
            .checked_add(protocol_cut)
            .ok_or(ErrorCode::MathOverflow)?;

        if lp_cut > 0 {
            // Reinvest the LP cut as a full set minted into the pool reserves.
            // DELIBERATE side effect: minting an equal full set into
            // possibly-unequal reserves nudges the marginal price slightly toward
            // 0.5. This is intended (fee reinvestment) and tiny. Net collateral
            // change for the sell is `-collateral_out + lp_cut`; the vault paid out
            // `collateral_out - fee`, so `vault == collateral + fee_accrued` holds
            // (the `fee = lp_cut + protocol_cut` split balances exactly).
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.yes_mint.to_account_info(),
                        to: ctx.accounts.pool_yes.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                lp_cut,
            )?;
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.no_mint.to_account_info(),
                        to: ctx.accounts.pool_no.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                lp_cut,
            )?;
            market.reserve_yes = market
                .reserve_yes
                .checked_add(lp_cut)
                .ok_or(ErrorCode::MathOverflow)?;
            market.reserve_no = market
                .reserve_no
                .checked_add(lp_cut)
                .ok_or(ErrorCode::MathOverflow)?;
            market.collateral = market
                .collateral
                .checked_add(lp_cut)
                .ok_or(ErrorCode::MathOverflow)?;
        }

        emit!(TradeExecuted {
            market: market.key(),
            user: ctx.accounts.user.key(),
            is_buy: false,
            outcome,
            collateral: collateral_out,
            tokens: quote.tokens_in,
        });
        Ok(())
    }

    /// Step 1 of resolution: the market's `resolver` proposes a winning outcome
    /// at/after `resolution_time`. Opens the dispute window; payouts stay locked.
    pub fn propose_outcome(ctx: Context<ProposeOutcome>, outcome: u8) -> Result<()> {
        let _ = Side::from_u8(outcome)?;
        let market = &mut ctx.accounts.market;
        require!(
            market.market_kind == MARKET_BINARY,
            ErrorCode::WrongMarketKind
        );
        require!(
            market.resolver_kind == RESOLVER_TRUSTED_KEY,
            ErrorCode::WrongResolverKind
        );
        require!(market.state == STATE_OPEN, ErrorCode::MarketNotOpen);
        require!(
            ctx.accounts.resolver.key() == market.resolver,
            ErrorCode::Unauthorized
        );
        let now = Clock::get()?.unix_timestamp;
        require!(now >= market.resolution_time, ErrorCode::TooEarlyToResolve);

        market.state = STATE_RESOLVING;
        market.proposed_outcome = outcome;
        market.resolved_at = now;

        emit!(OutcomeProposed {
            market: market.key(),
            resolver: ctx.accounts.resolver.key(),
            outcome,
            proposed_at: now,
        });
        Ok(())
    }

    /// Step 1 of resolution for a SCALAR market: the market's `resolver` proposes
    /// a settlement `value` at/after `resolution_time`. Mirrors `propose_outcome`
    /// but records a raw scalar value (mapped to a fraction at finalize) instead
    /// of a YES/NO outcome. Opens the same dispute window; payouts stay locked.
    pub fn propose_scalar(ctx: Context<ProposeOutcome>, value: i64) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(
            market.market_kind == MARKET_SCALAR,
            ErrorCode::WrongMarketKind
        );
        require!(
            market.resolver_kind == RESOLVER_TRUSTED_KEY,
            ErrorCode::WrongResolverKind
        );
        require!(market.state == STATE_OPEN, ErrorCode::MarketNotOpen);
        require!(
            ctx.accounts.resolver.key() == market.resolver,
            ErrorCode::Unauthorized
        );
        let now = Clock::get()?.unix_timestamp;
        require!(now >= market.resolution_time, ErrorCode::TooEarlyToResolve);

        market.state = STATE_RESOLVING;
        market.proposed_value = value;
        market.resolved_at = now;

        emit!(ScalarProposed {
            market: market.key(),
            resolver: ctx.accounts.resolver.key(),
            value,
            proposed_at: now,
        });
        Ok(())
    }

    /// Initialize an on-chain price feed. The `feed` account is created fresh
    /// (pass a new keypair). In production its `authority` is a Switchboard
    /// On-Demand Function's enclave key or a committee multisig — whichever bridges
    /// the licensed off-chain index on-chain.
    pub fn init_price_feed(
        ctx: Context<InitPriceFeed>,
        description: String,
        decimals: u8,
    ) -> Result<()> {
        require!(
            description.len() <= PriceFeed::MAX_DESC,
            ErrorCode::StringTooLong
        );
        let feed = &mut ctx.accounts.feed;
        feed.authority = ctx.accounts.authority.key();
        feed.value = 0;
        feed.decimals = decimals;
        feed.published_at = 0;
        feed.description = description;
        emit!(PriceFeedInitialized {
            feed: feed.key(),
            authority: feed.authority,
        });
        Ok(())
    }

    /// Post a new value to a price feed (feed authority only). `value` is in the
    /// feed's native fixed-point integer scale (see `decimals`).
    pub fn publish_price(ctx: Context<PublishPrice>, value: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let feed = &mut ctx.accounts.feed;
        require!(
            ctx.accounts.authority.key() == feed.authority,
            ErrorCode::Unauthorized
        );
        feed.value = value;
        feed.published_at = now;
        emit!(PricePublished {
            feed: feed.key(),
            value,
            published_at: now,
        });
        Ok(())
    }

    /// Oracle resolution (step 1, permissionless): derive the proposed outcome
    /// for a `RESOLVER_ORACLE_FEED` market by comparing the bound price feed's
    /// value to the market's strike. Enters the same dispute window as a manual
    /// proposal, so the guardian can still veto a manipulated feed.
    pub fn propose_from_oracle(ctx: Context<ProposeFromOracle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let feed_key = ctx.accounts.feed.key();
        let feed_value = ctx.accounts.feed.value;
        let feed_published = ctx.accounts.feed.published_at;

        let market = &mut ctx.accounts.market;
        require!(
            market.resolver_kind == RESOLVER_ORACLE_FEED,
            ErrorCode::WrongResolverKind
        );
        require!(market.state == STATE_OPEN, ErrorCode::MarketNotOpen);
        require!(now >= market.resolution_time, ErrorCode::TooEarlyToResolve);
        require!(feed_published > 0, ErrorCode::FeedHasNoValue);
        require!(
            now.checked_sub(feed_published)
                .ok_or(ErrorCode::MathOverflow)?
                <= market.oracle_max_staleness,
            ErrorCode::StaleFeed
        );

        match market.market_kind {
            MARKET_BINARY => {
                // Binary: compare the feed value to the strike.
                let is_yes =
                    math::oracle_is_yes(feed_value, market.oracle_strike, market.oracle_comparison)
                        .ok_or(ErrorCode::InvalidComparison)?;
                let outcome = if is_yes { OUTCOME_YES } else { OUTCOME_NO };

                market.state = STATE_RESOLVING;
                market.proposed_outcome = outcome;
                market.resolved_at = now;

                emit!(OutcomeProposed {
                    market: market.key(),
                    resolver: feed_key,
                    outcome,
                    proposed_at: now,
                });
            }
            MARKET_SCALAR => {
                // Scalar: settle on the raw feed value (mapped through the bounds
                // at finalize); no strike comparison.
                market.state = STATE_RESOLVING;
                market.proposed_value = feed_value;
                market.resolved_at = now;

                emit!(ScalarProposed {
                    market: market.key(),
                    resolver: feed_key,
                    value: feed_value,
                    proposed_at: now,
                });
            }
            _ => return err!(ErrorCode::UnsupportedMarketKind),
        }
        Ok(())
    }

    /// Optimistic resolution, step 1 (PERMISSIONLESS): anyone asserts a binary
    /// outcome by posting `config.bond_amount` collateral into the SEPARATE bond
    /// vault. Opens the dispute window; the assertion either finalizes undisputed
    /// (`finalize_assertion`, asserter reclaims the bond) or is disputed
    /// (`dispute_assertion`) and settled by the guardian (`resolve_dispute`).
    pub fn assert_outcome(ctx: Context<AssertOutcome>, outcome: u8) -> Result<()> {
        let _ = Side::from_u8(outcome)?;
        let bond_amount = ctx.accounts.config.bond_amount;
        let market = &mut ctx.accounts.market;
        require!(
            market.resolver_kind == RESOLVER_OPTIMISTIC,
            ErrorCode::WrongResolverKind
        );
        require!(
            market.market_kind == MARKET_BINARY,
            ErrorCode::WrongMarketKind
        );
        require!(market.state == STATE_OPEN, ErrorCode::MarketNotOpen);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= market.resolution_time, ErrorCode::TooEarlyToResolve);
        require!(bond_amount > 0, ErrorCode::NoBondConfigured);

        // Escrow the bond in the bond vault (NOT the market collateral vault).
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.asserter_collateral.to_account_info(),
                    to: ctx.accounts.bond_vault.to_account_info(),
                    authority: ctx.accounts.asserter.to_account_info(),
                },
            ),
            bond_amount,
        )?;

        market.state = STATE_RESOLVING;
        market.proposed_outcome = outcome;
        market.asserter = ctx.accounts.asserter.key();
        market.disputer = Pubkey::default();
        market.bond = bond_amount;
        market.disputed = false;
        market.resolved_at = now;

        emit!(OutcomeAsserted {
            market: market.key(),
            asserter: ctx.accounts.asserter.key(),
            outcome,
            bond: bond_amount,
            asserted_at: now,
        });
        Ok(())
    }

    /// Optimistic resolution, step 2a (PERMISSIONLESS): challenge an open assertion
    /// by posting an equal bond into the bond vault, within the dispute window. A
    /// disputed assertion can no longer finalize on its own — only the guardian's
    /// `resolve_dispute` settles it (awarding both bonds to the correct asserter).
    pub fn dispute_assertion(ctx: Context<DisputeAssertion>) -> Result<()> {
        let dispute_period = ctx.accounts.config.dispute_period;
        let market = &mut ctx.accounts.market;
        require!(
            market.resolver_kind == RESOLVER_OPTIMISTIC,
            ErrorCode::WrongResolverKind
        );
        require!(market.state == STATE_RESOLVING, ErrorCode::NotProposed);
        require!(!market.disputed, ErrorCode::AlreadyDisputed);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now < market
                .resolved_at
                .checked_add(dispute_period)
                .ok_or(ErrorCode::MathOverflow)?,
            ErrorCode::DisputeWindowClosed
        );
        require!(
            ctx.accounts.disputer.key() != market.asserter,
            ErrorCode::SelfDispute
        );

        // Post the matching bond into the bond vault.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.disputer_collateral.to_account_info(),
                    to: ctx.accounts.bond_vault.to_account_info(),
                    authority: ctx.accounts.disputer.to_account_info(),
                },
            ),
            market.bond,
        )?;

        market.disputer = ctx.accounts.disputer.key();
        market.disputed = true;

        emit!(AssertionDisputed {
            market: market.key(),
            disputer: ctx.accounts.disputer.key(),
        });
        Ok(())
    }

    /// Optimistic resolution, step 2b (PERMISSIONLESS): finalize an UNDISPUTED
    /// assertion once the dispute window has elapsed. Refunds the asserter's bond
    /// from the bond vault (PDA-signed) and resolves the market to the asserted
    /// outcome. Disputed assertions must go through `resolve_dispute` instead.
    pub fn finalize_assertion(ctx: Context<FinalizeAssertion>) -> Result<()> {
        let dispute_period = ctx.accounts.config.dispute_period;
        let market = &mut ctx.accounts.market;
        require!(
            market.resolver_kind == RESOLVER_OPTIMISTIC,
            ErrorCode::WrongResolverKind
        );
        require!(market.state == STATE_RESOLVING, ErrorCode::NotProposed);
        // A disputed assertion cannot finalize itself — only the guardian settles it.
        require!(!market.disputed, ErrorCode::DisputeUnresolved);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= market
                .resolved_at
                .checked_add(dispute_period)
                .ok_or(ErrorCode::MathOverflow)?,
            ErrorCode::DisputeWindowOpen
        );
        require!(
            ctx.accounts.asserter.key() == market.asserter,
            ErrorCode::Unauthorized
        );

        // Refund the asserter's bond from the bond vault (PDA-signed).
        let bond = market.bond;
        let id_bytes = market.market_id.to_le_bytes();
        let bump_seed = [market.bump];
        let seeds: &[&[u8]] = &[MARKET_SEED, id_bytes.as_ref(), bump_seed.as_ref()];
        let signer: &[&[&[u8]]] = &[seeds];
        if bond > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.bond_vault.to_account_info(),
                        to: ctx.accounts.asserter_collateral.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                bond,
            )?;
        }
        market.bond = 0;
        market.state = STATE_RESOLVED;
        market.outcome = market.proposed_outcome;

        emit!(MarketResolved {
            market: market.key(),
            outcome: market.outcome,
            settlement_fraction: market.settlement_fraction,
            resolved_at: now,
        });
        Ok(())
    }

    /// Optimistic resolution, step 2c (GUARDIAN only): settle a DISPUTED assertion.
    /// The guardian (the DVM / council stand-in) declares the `correct_outcome`;
    /// the whole `2 * bond` escrow goes to whoever asserted it (the asserter if
    /// `proposed_outcome == correct_outcome`, else the disputer), PDA-signed out of
    /// the bond vault. The market resolves to `correct_outcome`.
    pub fn resolve_dispute(ctx: Context<ResolveDispute>, correct_outcome: u8) -> Result<()> {
        let _ = Side::from_u8(correct_outcome)?;
        require!(
            ctx.accounts.guardian.key() == ctx.accounts.config.guardian,
            ErrorCode::Unauthorized
        );
        let market = &mut ctx.accounts.market;
        require!(
            market.resolver_kind == RESOLVER_OPTIMISTIC,
            ErrorCode::WrongResolverKind
        );
        require!(market.state == STATE_RESOLVING, ErrorCode::NotProposed);
        require!(market.disputed, ErrorCode::DisputeUnresolved);

        // The winner is whoever asserted the side the guardian ruled correct.
        let asserter_correct = market.proposed_outcome == correct_outcome;
        let winner = if asserter_correct {
            market.asserter
        } else {
            market.disputer
        };
        require_keys_eq!(
            ctx.accounts.winner_collateral.owner,
            winner,
            ErrorCode::WrongOwner
        );
        require_keys_eq!(
            ctx.accounts.winner_collateral.mint,
            market.collateral_mint,
            ErrorCode::WrongMint
        );

        // Pay out the full 2*bond escrow to the winner (PDA-signed).
        let payout = market.bond.checked_mul(2).ok_or(ErrorCode::MathOverflow)?;
        let id_bytes = market.market_id.to_le_bytes();
        let bump_seed = [market.bump];
        let seeds: &[&[u8]] = &[MARKET_SEED, id_bytes.as_ref(), bump_seed.as_ref()];
        let signer: &[&[&[u8]]] = &[seeds];
        if payout > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.bond_vault.to_account_info(),
                        to: ctx.accounts.winner_collateral.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                payout,
            )?;
        }
        market.bond = 0;
        market.state = STATE_RESOLVED;
        market.outcome = correct_outcome;

        emit!(DisputeResolved {
            market: market.key(),
            outcome: correct_outcome,
            winner,
        });
        Ok(())
    }

    /// Step 2 of resolution: finalize a proposed outcome once the dispute window
    /// has elapsed. Permissionless — anyone may crank it.
    pub fn finalize_outcome(ctx: Context<FinalizeOutcome>) -> Result<()> {
        let dispute_period = ctx.accounts.config.dispute_period;
        let market = &mut ctx.accounts.market;
        require!(market.state == STATE_RESOLVING, ErrorCode::NotProposed);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= market
                .resolved_at
                .checked_add(dispute_period)
                .ok_or(ErrorCode::MathOverflow)?,
            ErrorCode::DisputeWindowOpen
        );

        market.state = STATE_RESOLVED;
        match market.market_kind {
            MARKET_BINARY => {
                market.outcome = market.proposed_outcome;
            }
            MARKET_SCALAR => {
                // Map the proposed value through the bounds into a settlement
                // fraction; `outcome` stays 0 (unused for scalar redemption).
                market.settlement_fraction = math::scalar_fraction(
                    market.proposed_value,
                    market.lower_bound,
                    market.upper_bound,
                )
                .ok_or(ErrorCode::InvalidScalarRange)?;
            }
            _ => return err!(ErrorCode::UnsupportedMarketKind),
        }

        emit!(MarketResolved {
            market: market.key(),
            outcome: market.outcome,
            settlement_fraction: market.settlement_fraction,
            resolved_at: now,
        });
        Ok(())
    }

    /// Guardian veto: during the dispute window, void a proposed outcome (→ 50/50
    /// refund). Use when a proposal is wrong or the resolver is compromised.
    pub fn dispute_void(ctx: Context<GuardianAction>) -> Result<()> {
        require!(
            ctx.accounts.guardian.key() == ctx.accounts.config.guardian,
            ErrorCode::Unauthorized
        );
        let dispute_period = ctx.accounts.config.dispute_period;
        let market = &mut ctx.accounts.market;
        // Optimistic markets settle disputes via `resolve_dispute` (bond-weighted),
        // not the guardian 50/50 void path — keep the two flows from crossing.
        require!(
            market.resolver_kind != RESOLVER_OPTIMISTIC,
            ErrorCode::WrongResolverKind
        );
        require!(market.state == STATE_RESOLVING, ErrorCode::NotProposed);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now < market
                .resolved_at
                .checked_add(dispute_period)
                .ok_or(ErrorCode::MathOverflow)?,
            ErrorCode::DisputeWindowClosed
        );

        market.state = STATE_VOID;
        emit!(MarketVoided {
            market: market.key(),
            reason: VOID_REASON_DISPUTE
        });
        Ok(())
    }

    /// Liveness escape hatch: if the resolver never proposes, anyone may void a
    /// stale market `VOID_GRACE_PERIOD` after `resolution_time`, freeing collateral.
    pub fn void_stale(ctx: Context<VoidStale>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.state == STATE_OPEN, ErrorCode::MarketNotOpen);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now > market
                .resolution_time
                .checked_add(VOID_GRACE_PERIOD)
                .ok_or(ErrorCode::MathOverflow)?,
            ErrorCode::TooEarlyToVoid
        );

        market.state = STATE_VOID;
        emit!(MarketVoided {
            market: market.key(),
            reason: VOID_REASON_STALE
        });
        Ok(())
    }

    /// Redeem `amount` of the winning outcome token for `amount` collateral.
    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);
        let market = &mut ctx.accounts.market;
        require!(
            market.market_kind == MARKET_BINARY,
            ErrorCode::WrongMarketKind
        );
        require!(market.state == STATE_RESOLVED, ErrorCode::NotResolved);

        let winning_mint = market.outcome_mint(Side::from_u8(market.outcome)?);
        require_keys_eq!(
            ctx.accounts.winning_mint.key(),
            winning_mint,
            ErrorCode::WrongMint
        );
        require_keys_eq!(
            ctx.accounts.user_outcome.mint,
            winning_mint,
            ErrorCode::WrongMint
        );
        require_keys_eq!(
            ctx.accounts.user_outcome.owner,
            ctx.accounts.user.key(),
            ErrorCode::WrongOwner
        );
        require!(
            amount <= market.collateral,
            ErrorCode::InsufficientLiquidity
        );

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.winning_mint.to_account_info(),
                    from: ctx.accounts.user_outcome.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let id_bytes = market.market_id.to_le_bytes();
        let bump_seed = [market.bump];
        let seeds: &[&[u8]] = &[MARKET_SEED, id_bytes.as_ref(), bump_seed.as_ref()];
        let signer: &[&[&[u8]]] = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_collateral.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        market.collateral = market
            .collateral
            .checked_sub(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        emit!(Redeemed {
            market: market.key(),
            user: ctx.accounts.user.key(),
            amount,
            payout: amount,
        });
        Ok(())
    }

    /// Redeem `amount` of EITHER outcome token on a voided market for half of
    /// collateral per token (rounded down). 50/50 refund that conserves the vault.
    pub fn redeem_void(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);
        let market = &mut ctx.accounts.market;
        require!(market.state == STATE_VOID, ErrorCode::NotVoid);

        let mint = ctx.accounts.winning_mint.key();
        require!(
            mint == market.yes_mint || mint == market.no_mint,
            ErrorCode::WrongMint
        );
        require_keys_eq!(ctx.accounts.user_outcome.mint, mint, ErrorCode::WrongMint);
        require_keys_eq!(
            ctx.accounts.user_outcome.owner,
            ctx.accounts.user.key(),
            ErrorCode::WrongOwner
        );

        let payout = amount / 2; // half of collateral per token
        require!(
            payout <= market.collateral,
            ErrorCode::InsufficientLiquidity
        );

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.winning_mint.to_account_info(),
                    from: ctx.accounts.user_outcome.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        if payout > 0 {
            let id_bytes = market.market_id.to_le_bytes();
            let bump_seed = [market.bump];
            let seeds: &[&[u8]] = &[MARKET_SEED, id_bytes.as_ref(), bump_seed.as_ref()];
            let signer: &[&[&[u8]]] = &[seeds];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.user_collateral.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                payout,
            )?;
            market.collateral = market
                .collateral
                .checked_sub(payout)
                .ok_or(ErrorCode::MathOverflow)?;
        }

        emit!(Redeemed {
            market: market.key(),
            user: ctx.accounts.user.key(),
            amount,
            payout,
        });
        Ok(())
    }

    /// Redeem `amount` of a SCALAR market's LONG (yes_mint) or SHORT (no_mint)
    /// token for its settled value. `is_long` is inferred from which of the two
    /// mints the user's outcome ATA holds; the payout is
    /// `scalar_payout(amount, settlement_fraction, is_long)` (floor-rounded so the
    /// vault is never overpaid).
    pub fn redeem_scalar(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);
        let market = &mut ctx.accounts.market;
        require!(
            market.market_kind == MARKET_SCALAR,
            ErrorCode::WrongMarketKind
        );
        require!(market.state == STATE_RESOLVED, ErrorCode::NotResolved);

        // The redeemed side is whichever mint the user holds: yes_mint => LONG,
        // no_mint => SHORT.
        let mint = ctx.accounts.winning_mint.key();
        let is_long = if mint == market.yes_mint {
            true
        } else if mint == market.no_mint {
            false
        } else {
            return err!(ErrorCode::WrongMint);
        };
        require_keys_eq!(ctx.accounts.user_outcome.mint, mint, ErrorCode::WrongMint);
        require_keys_eq!(
            ctx.accounts.user_outcome.owner,
            ctx.accounts.user.key(),
            ErrorCode::WrongOwner
        );

        let payout = math::scalar_payout(amount, market.settlement_fraction, is_long);
        require!(
            payout <= market.collateral,
            ErrorCode::InsufficientLiquidity
        );

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.winning_mint.to_account_info(),
                    from: ctx.accounts.user_outcome.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        if payout > 0 {
            let id_bytes = market.market_id.to_le_bytes();
            let bump_seed = [market.bump];
            let seeds: &[&[u8]] = &[MARKET_SEED, id_bytes.as_ref(), bump_seed.as_ref()];
            let signer: &[&[&[u8]]] = &[seeds];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.user_collateral.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                payout,
            )?;
            market.collateral = market
                .collateral
                .checked_sub(payout)
                .ok_or(ErrorCode::MathOverflow)?;
        }

        emit!(Redeemed {
            market: market.key(),
            user: ctx.accounts.user.key(),
            amount,
            payout,
        });
        Ok(())
    }

    /// After settlement, a liquidity provider reclaims their **pro-rata slice** of
    /// the pool's outcome tokens as collateral. Claims the caller's ENTIRE
    /// position: with `shares = position.shares` and `S = total_shares`, the
    /// provider's slice of each reserve is `c_i = floor(reserve_i * shares / S)`
    /// (FLOORED so leftover dust stays with un-claimed providers / the vault).
    /// Payout per settlement state:
    /// * binary RESOLVED → the winning side's slice (`cy` if YES won, else `cn`);
    /// * scalar RESOLVED → `scalar_payout(cy, f, LONG) + scalar_payout(cn, f, SHORT)`;
    /// * VOID → `cy/2 + cn/2`.
    /// Burns `cy`/`cn` from the pools, transfers `payout` collateral out, and
    /// zeroes the caller's shares (and decrements `total_shares`).
    pub fn claim_pool(ctx: Context<ClaimPool>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(
            market.state == STATE_RESOLVED || market.state == STATE_VOID,
            ErrorCode::NotResolved
        );
        require_keys_eq!(
            ctx.accounts.yes_mint.key(),
            market.yes_mint,
            ErrorCode::WrongMint
        );
        require_keys_eq!(
            ctx.accounts.no_mint.key(),
            market.no_mint,
            ErrorCode::WrongMint
        );

        // The caller claims their full position (the `position` PDA is bound to
        // `lp` + `market` by its seeds in the accounts context).
        let shares = ctx.accounts.position.shares;
        require!(shares > 0, ErrorCode::NothingToClaim);
        let total = market.total_shares;
        require!(total > 0, ErrorCode::NothingToClaim);

        // This provider's slice of each reserve (floored => favors the pool /
        // remaining LPs).
        let cy =
            math::lp_slice(market.reserve_yes, shares, total).ok_or(ErrorCode::MathOverflow)?;
        let cn = math::lp_slice(market.reserve_no, shares, total).ok_or(ErrorCode::MathOverflow)?;

        let id_bytes = market.market_id.to_le_bytes();
        let bump_seed = [market.bump];
        let seeds: &[&[u8]] = &[MARKET_SEED, id_bytes.as_ref(), bump_seed.as_ref()];
        let signer: &[&[&[u8]]] = &[seeds];

        let payout: u64 = if market.state == STATE_RESOLVED && market.market_kind == MARKET_SCALAR {
            // Scalar: the slice of each side settles at the resolved fraction
            // (LONG at f, SHORT at 1 - f).
            let f = market.settlement_fraction;
            math::scalar_payout(cy, f, true)
                .checked_add(math::scalar_payout(cn, f, false))
                .ok_or(ErrorCode::MathOverflow)?
        } else if market.state == STATE_RESOLVED {
            // Binary: the winning-side slice redeems 1:1; the losing-side tokens
            // are worthless (but still burned to keep supply tracking the reserve).
            let side = Side::from_u8(market.outcome)?;
            match side {
                Side::Yes => cy,
                Side::No => cn,
            }
        } else {
            // Void: half of each slice.
            (cy / 2) + (cn / 2)
        };

        // Burn this provider's slice of each pool reserve.
        if cy > 0 {
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.yes_mint.to_account_info(),
                        from: ctx.accounts.pool_yes.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                cy,
            )?;
        }
        if cn > 0 {
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.no_mint.to_account_info(),
                        from: ctx.accounts.pool_no.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                cn,
            )?;
        }

        market.reserve_yes = market
            .reserve_yes
            .checked_sub(cy)
            .ok_or(ErrorCode::MathOverflow)?;
        market.reserve_no = market
            .reserve_no
            .checked_sub(cn)
            .ok_or(ErrorCode::MathOverflow)?;
        market.total_shares = total.checked_sub(shares).ok_or(ErrorCode::MathOverflow)?;
        ctx.accounts.position.shares = 0;

        require!(
            payout <= market.collateral,
            ErrorCode::InsufficientLiquidity
        );
        if payout > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.lp_collateral.to_account_info(),
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                payout,
            )?;
            market.collateral = market
                .collateral
                .checked_sub(payout)
                .ok_or(ErrorCode::MathOverflow)?;
        }

        emit!(PoolClaimed {
            market: market.key(),
            lp: ctx.accounts.lp.key(),
            provider: ctx.accounts.position.owner,
            payout
        });
        Ok(())
    }

    /// Admin withdraws accrued protocol fees for this market.
    pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.config.admin,
            ErrorCode::Unauthorized
        );
        let market = &mut ctx.accounts.market;
        let amount = market.fee_accrued;
        require!(amount > 0, ErrorCode::NothingToClaim);

        let id_bytes = market.market_id.to_le_bytes();
        let bump_seed = [market.bump];
        let seeds: &[&[u8]] = &[MARKET_SEED, id_bytes.as_ref(), bump_seed.as_ref()];
        let signer: &[&[&[u8]]] = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.admin_collateral.to_account_info(),
                    authority: market.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;
        market.fee_accrued = 0;
        emit!(FeesCollected {
            market: market.key(),
            amount
        });
        Ok(())
    }

    // ----- admin / guardian configuration -----

    /// Pause or unpause all trading. Callable by the admin or the guardian.
    pub fn set_paused(ctx: Context<AdminOrGuardian>, paused: bool) -> Result<()> {
        let is_admin = ctx.accounts.authority.key() == ctx.accounts.config.admin;
        let is_guardian = ctx.accounts.authority.key() == ctx.accounts.config.guardian;
        require!(is_admin || is_guardian, ErrorCode::Unauthorized);
        ctx.accounts.config.paused = paused;
        emit!(PausedSet { paused });
        Ok(())
    }

    /// Update the taker fee (admin only), re-checked against `MAX_FEE_BPS`.
    pub fn set_fee_bps(ctx: Context<AdminOnly>, fee_bps: u16) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.config.admin,
            ErrorCode::Unauthorized
        );
        require!(fee_bps <= MAX_FEE_BPS, ErrorCode::FeeTooHigh);
        ctx.accounts.config.fee_bps = fee_bps;
        Ok(())
    }

    /// Update the LP fee share (admin only), re-validated `<= 10_000` bps.
    pub fn set_lp_fee_bps(ctx: Context<AdminOnly>, value: u16) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.config.admin,
            ErrorCode::Unauthorized
        );
        require!(
            value <= math::BPS_DENOMINATOR as u16,
            ErrorCode::InvalidParameter
        );
        ctx.accounts.config.lp_fee_bps = value;
        Ok(())
    }

    /// Update the optimistic-resolver bond (admin only). No bound beyond type; 0
    /// disables `assert_outcome`.
    pub fn set_bond_amount(ctx: Context<AdminOnly>, value: u64) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.config.admin,
            ErrorCode::Unauthorized
        );
        ctx.accounts.config.bond_amount = value;
        Ok(())
    }

    /// Update the guardian (admin only).
    pub fn set_guardian(ctx: Context<AdminOnly>, guardian: Pubkey) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.config.admin,
            ErrorCode::Unauthorized
        );
        ctx.accounts.config.guardian = guardian;
        Ok(())
    }

    /// Two-step admin transfer, step 1: nominate a new admin.
    pub fn set_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.config.admin,
            ErrorCode::Unauthorized
        );
        ctx.accounts.config.pending_admin = new_admin;
        Ok(())
    }

    /// Two-step admin transfer, step 2: the nominee accepts.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        require!(
            ctx.accounts.pending_admin.key() == ctx.accounts.config.pending_admin
                && ctx.accounts.config.pending_admin != Pubkey::default(),
            ErrorCode::Unauthorized
        );
        ctx.accounts.config.admin = ctx.accounts.config.pending_admin;
        ctx.accounts.config.pending_admin = Pubkey::default();
        Ok(())
    }
}

// ----------------------------- State -----------------------------

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub guardian: Pubkey,
    pub collateral_mint: Pubkey,
    pub fee_bps: u16,
    /// Fraction OF THE TAKER FEE routed to LPs, in basis points (0..=10_000).
    /// The remainder of each fee accrues to the protocol (`fee_accrued`).
    pub lp_fee_bps: u16,
    pub dispute_period: i64,
    pub market_count: u64,
    pub paused: bool,
    /// Bond required to `assert_outcome` / `dispute_assertion` on an optimistic
    /// market (0 disables optimistic assertions). Settable via `set_bond_amount`.
    pub bond_amount: u64,
    pub bump: u8,
}

impl Config {
    // 8 disc + 4*32 keys + 2 fee_bps + 2 lp_fee_bps + 8 dispute_period
    //   + 8 market_count + 1 paused + 8 bond_amount + 1 bump.
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 32 + 2 + 2 + 8 + 8 + 1 + 8 + 1;
}

#[account]
pub struct Market {
    pub market_id: u64,
    pub creator: Pubkey,
    pub resolver: Pubkey,
    pub resolver_kind: u8,
    /// `MARKET_BINARY` or `MARKET_SCALAR`. Scalar markets reuse the binary FPMM
    /// (YES=LONG, NO=SHORT) and differ only in resolution + redemption.
    pub market_kind: u8,
    /// Scalar range `[lower_bound, upper_bound]` (used when `market_kind ==
    /// MARKET_SCALAR`; both 0 for binary). Settlement clamps the resolved value
    /// to this range and maps it to a fraction in `[0, PRICE_SCALE]`.
    pub lower_bound: i64,
    pub upper_bound: i64,
    /// Proposed scalar settlement value (parallels `proposed_outcome`). Set by
    /// `propose_scalar` / `propose_from_oracle` for scalar markets.
    pub proposed_value: i64,
    /// Resolved settlement fraction `f` scaled to `PRICE_SCALE`, in
    /// `[0, PRICE_SCALE]`. Set at `finalize_outcome` for scalar markets.
    pub settlement_fraction: u32,
    /// Oracle config (used when `resolver_kind == RESOLVER_ORACLE_FEED`).
    pub oracle_feed: Pubkey,
    pub oracle_strike: i64,
    pub oracle_comparison: u8,
    pub oracle_max_staleness: i64,
    pub collateral_mint: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    pub pool_yes: Pubkey,
    pub pool_no: Pubkey,
    pub reserve_yes: u64,
    pub reserve_no: u64,
    /// The initial liquidity provider (informational; the creator who seeded).
    /// Per-provider balances live in [`LiquidityPosition`] PDAs.
    pub lp: Pubkey,
    /// Total pool shares outstanding across all providers. A provider owns
    /// `position.shares / total_shares` of the AMM reserves.
    pub total_shares: u64,
    /// Collateral backing outstanding tokens (excludes accrued fees).
    pub collateral: u64,
    pub fee_accrued: u64,
    pub state: u8,
    pub outcome: u8,
    pub proposed_outcome: u8,
    /// Optimistic resolver (`RESOLVER_OPTIMISTIC`) bookkeeping. `asserter` posted
    /// the open assertion's bond; `disputer` (if any) posted the matching bond;
    /// `bond` is the per-side bond escrowed in the bond vault (0 once settled);
    /// `disputed` flags that the assertion is contested (→ `resolve_dispute`).
    pub asserter: Pubkey,
    pub disputer: Pubkey,
    pub bond: u64,
    pub disputed: bool,
    pub close_time: i64,
    pub resolution_time: i64,
    pub resolved_at: i64,
    pub question: String,
    pub resolution_source: String,
    /// Forward-compat padding for future oracle resolver configs.
    pub reserved: [u8; Market::RESERVED],
    pub bump: u8,
}

impl Market {
    pub const MAX_QUESTION: usize = 200;
    pub const MAX_SOURCE: usize = 80;
    pub const RESERVED: usize = 64;
    pub const SPACE: usize = 8 // discriminator
        + 8  // market_id
        + 32 // creator
        + 32 // resolver
        + 1  // resolver_kind
        + 1  // market_kind
        + 8  // lower_bound
        + 8  // upper_bound
        + 8  // proposed_value
        + 4  // settlement_fraction
        + 32 // oracle_feed
        + 8  // oracle_strike
        + 1  // oracle_comparison
        + 8  // oracle_max_staleness
        + 32 // collateral_mint
        + 32 // yes_mint
        + 32 // no_mint
        + 32 // vault
        + 32 // pool_yes
        + 32 // pool_no
        + 8  // reserve_yes
        + 8  // reserve_no
        + 32 // lp
        + 8  // total_shares
        + 8  // collateral
        + 8  // fee_accrued
        + 1  // state
        + 1  // outcome
        + 1  // proposed_outcome
        + 32 // asserter
        + 32 // disputer
        + 8  // bond
        + 1  // disputed
        + 8  // close_time
        + 8  // resolution_time
        + 8  // resolved_at
        + 4 + Self::MAX_QUESTION
        + 4 + Self::MAX_SOURCE
        + Self::RESERVED
        + 1; // bump

    /// Mint for a given side.
    fn outcome_mint(&self, side: Side) -> Pubkey {
        match side {
            Side::Yes => self.yes_mint,
            Side::No => self.no_mint,
        }
    }

    /// `(reserve_of_side, reserve_of_other)`.
    fn reserves(&self, side: Side) -> (u64, u64) {
        match side {
            Side::Yes => (self.reserve_yes, self.reserve_no),
            Side::No => (self.reserve_no, self.reserve_yes),
        }
    }

    /// Write back `(reserve_of_side, reserve_of_other)`.
    fn set_reserves(&mut self, side: Side, of_side: u64, of_other: u64) {
        match side {
            Side::Yes => {
                self.reserve_yes = of_side;
                self.reserve_no = of_other;
            }
            Side::No => {
                self.reserve_no = of_side;
                self.reserve_yes = of_other;
            }
        }
    }
}

/// One liquidity provider's pool position in one market. PDA seeds
/// `[LP_SEED, market, owner]`. `shares / market.total_shares` is the provider's
/// fraction of the AMM reserves; created on `seed_liquidity` (the creator) or the
/// provider's first `add_liquidity`, and drained to 0 by `claim_pool`.
#[account]
pub struct LiquidityPosition {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
    pub bump: u8,
}

impl LiquidityPosition {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 1;
}

/// An on-chain numeric price feed. Designed to be populated by a Switchboard
/// On-Demand Function (TEE-attested) or a committee multisig bridging a licensed
/// off-chain index; markets with `RESOLVER_ORACLE_FEED` read it to resolve.
#[account]
pub struct PriceFeed {
    pub authority: Pubkey,
    pub value: i64,
    pub decimals: u8,
    pub published_at: i64,
    pub description: String,
}

impl PriceFeed {
    pub const MAX_DESC: usize = 64;
    pub const SPACE: usize = 8 + 32 + 8 + 1 + 8 + 4 + Self::MAX_DESC;
}

// ----------------------------- Contexts -----------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = Config::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        init,
        payer = creator,
        space = Market::SPACE,
        seeds = [MARKET_SEED, config.market_count.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init, payer = creator, seeds = [YES_SEED, market.key().as_ref()], bump,
        mint::decimals = math::DECIMALS, mint::authority = market,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init, payer = creator, seeds = [NO_SEED, market.key().as_ref()], bump,
        mint::decimals = math::DECIMALS, mint::authority = market,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(
        init, payer = creator, seeds = [VAULT_SEED, market.key().as_ref()], bump,
        token::mint = collateral_mint, token::authority = market,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(address = config.collateral_mint)]
    pub collateral_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SeedLiquidity<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init, payer = lp, seeds = [POOL_YES_SEED, market.key().as_ref()], bump,
        token::mint = yes_mint, token::authority = market,
    )]
    pub pool_yes: Box<Account<'info, TokenAccount>>,
    #[account(
        init, payer = lp, seeds = [POOL_NO_SEED, market.key().as_ref()], bump,
        token::mint = no_mint, token::authority = market,
    )]
    pub pool_no: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = lp_collateral.mint == market.collateral_mint @ ErrorCode::WrongMint,
        constraint = lp_collateral.owner == lp.key() @ ErrorCode::WrongOwner,
    )]
    pub lp_collateral: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = lp,
        space = LiquidityPosition::SPACE,
        seeds = [LP_SEED, market.key().as_ref(), lp.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, LiquidityPosition>>,

    #[account(mut)]
    pub lp: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.pool_yes)]
    pub pool_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.pool_no)]
    pub pool_no: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = lp_collateral.mint == market.collateral_mint @ ErrorCode::WrongMint,
        constraint = lp_collateral.owner == lp.key() @ ErrorCode::WrongOwner,
    )]
    pub lp_collateral: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = lp_yes.mint == market.yes_mint @ ErrorCode::WrongMint,
        constraint = lp_yes.owner == lp.key() @ ErrorCode::WrongOwner,
    )]
    pub lp_yes: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = lp_no.mint == market.no_mint @ ErrorCode::WrongMint,
        constraint = lp_no.owner == lp.key() @ ErrorCode::WrongOwner,
    )]
    pub lp_no: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = lp,
        space = LiquidityPosition::SPACE,
        seeds = [LP_SEED, market.key().as_ref(), lp.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, LiquidityPosition>>,

    #[account(mut)]
    pub lp: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, address = market.pool_yes)]
    pub pool_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.pool_no)]
    pub pool_no: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = lp_yes.mint == market.yes_mint @ ErrorCode::WrongMint,
        constraint = lp_yes.owner == lp.key() @ ErrorCode::WrongOwner,
    )]
    pub lp_yes: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = lp_no.mint == market.no_mint @ ErrorCode::WrongMint,
        constraint = lp_no.owner == lp.key() @ ErrorCode::WrongOwner,
    )]
    pub lp_no: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [LP_SEED, market.key().as_ref(), lp.key().as_ref()],
        bump = position.bump,
        has_one = market @ ErrorCode::Unauthorized,
        has_one = owner @ ErrorCode::Unauthorized,
    )]
    pub position: Box<Account<'info, LiquidityPosition>>,
    /// CHECK: bound to `position.owner` via `has_one`; must equal the signer `lp`.
    #[account(address = lp.key() @ ErrorCode::Unauthorized)]
    pub owner: UncheckedAccount<'info>,

    pub lp: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.pool_yes)]
    pub pool_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.pool_no)]
    pub pool_no: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user_outcome: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = user_collateral.mint == market.collateral_mint @ ErrorCode::WrongMint,
        constraint = user_collateral.owner == user.key() @ ErrorCode::WrongOwner,
    )]
    pub user_collateral: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ProposeOutcome<'info> {
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    pub resolver: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitPriceFeed<'info> {
    #[account(init, payer = authority, space = PriceFeed::SPACE)]
    pub feed: Box<Account<'info, PriceFeed>>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PublishPrice<'info> {
    #[account(mut)]
    pub feed: Box<Account<'info, PriceFeed>>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ProposeFromOracle<'info> {
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(address = market.oracle_feed)]
    pub feed: Box<Account<'info, PriceFeed>>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct AssertOutcome<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(address = market.collateral_mint)]
    pub collateral_mint: Box<Account<'info, Mint>>,

    /// The bond escrow, created on first assert. SEPARATE from `market.vault`, so
    /// bonds never touch the collateral-conservation invariant.
    #[account(
        init_if_needed,
        payer = asserter,
        seeds = [BOND_SEED, market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market,
    )]
    pub bond_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = asserter_collateral.mint == market.collateral_mint @ ErrorCode::WrongMint,
        constraint = asserter_collateral.owner == asserter.key() @ ErrorCode::WrongOwner,
    )]
    pub asserter_collateral: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub asserter: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DisputeAssertion<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, seeds = [BOND_SEED, market.key().as_ref()], bump)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = disputer_collateral.mint == market.collateral_mint @ ErrorCode::WrongMint,
        constraint = disputer_collateral.owner == disputer.key() @ ErrorCode::WrongOwner,
    )]
    pub disputer_collateral: Box<Account<'info, TokenAccount>>,

    pub disputer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FinalizeAssertion<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, seeds = [BOND_SEED, market.key().as_ref()], bump)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = asserter_collateral.mint == market.collateral_mint @ ErrorCode::WrongMint,
        constraint = asserter_collateral.owner == market.asserter @ ErrorCode::WrongOwner,
    )]
    pub asserter_collateral: Box<Account<'info, TokenAccount>>,

    /// The original asserter (must match `market.asserter`); reclaims the bond.
    pub asserter: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, seeds = [BOND_SEED, market.key().as_ref()], bump)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,

    /// The winner's collateral ATA — its owner/mint are checked in the handler
    /// against the guardian's ruling (asserter or disputer).
    #[account(mut)]
    pub winner_collateral: Box<Account<'info, TokenAccount>>,

    pub guardian: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FinalizeOutcome<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct GuardianAction<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    pub guardian: Signer<'info>,
}

#[derive(Accounts)]
pub struct VoidStale<'info> {
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut)]
    pub winning_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user_outcome: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = user_collateral.mint == market.collateral_mint @ ErrorCode::WrongMint,
        constraint = user_collateral.owner == user.key() @ ErrorCode::WrongOwner,
    )]
    pub user_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimPool<'info> {
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.pool_yes)]
    pub pool_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.pool_no)]
    pub pool_no: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = lp_collateral.mint == market.collateral_mint @ ErrorCode::WrongMint,
        constraint = lp_collateral.owner == lp.key() @ ErrorCode::WrongOwner,
    )]
    pub lp_collateral: Box<Account<'info, TokenAccount>>,
    /// The caller's own position (seeds bind it to `market` + `lp`), so each LP
    /// claims exactly their pro-rata slice.
    #[account(
        mut,
        seeds = [LP_SEED, market.key().as_ref(), lp.key().as_ref()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, LiquidityPosition>>,
    pub lp: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, address = market.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = admin_collateral.mint == market.collateral_mint @ ErrorCode::WrongMint,
        constraint = admin_collateral.owner == admin.key() @ ErrorCode::WrongOwner,
    )]
    pub admin_collateral: Box<Account<'info, TokenAccount>>,
    pub admin: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminOrGuardian<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub pending_admin: Signer<'info>,
}

// ----------------------------- Events -----------------------------

pub const VOID_REASON_DISPUTE: u8 = 0;
pub const VOID_REASON_STALE: u8 = 1;

#[event]
pub struct MarketCreated {
    pub market_id: u64,
    pub market: Pubkey,
    pub creator: Pubkey,
    pub resolver: Pubkey,
    pub close_time: i64,
    pub resolution_time: i64,
}

#[event]
pub struct LiquiditySeeded {
    pub market: Pubkey,
    pub amount: u64,
}

#[event]
pub struct TradeExecuted {
    pub market: Pubkey,
    pub user: Pubkey,
    pub is_buy: bool,
    pub outcome: u8,
    pub collateral: u64,
    pub tokens: u64,
}

#[event]
pub struct OutcomeProposed {
    pub market: Pubkey,
    pub resolver: Pubkey,
    pub outcome: u8,
    pub proposed_at: i64,
}

#[event]
pub struct MarketResolved {
    pub market: Pubkey,
    pub outcome: u8,
    /// Scalar settlement fraction (0 for binary markets).
    pub settlement_fraction: u32,
    pub resolved_at: i64,
}

#[event]
pub struct OutcomeAsserted {
    pub market: Pubkey,
    pub asserter: Pubkey,
    pub outcome: u8,
    pub bond: u64,
    pub asserted_at: i64,
}

#[event]
pub struct AssertionDisputed {
    pub market: Pubkey,
    pub disputer: Pubkey,
}

#[event]
pub struct DisputeResolved {
    pub market: Pubkey,
    pub outcome: u8,
    pub winner: Pubkey,
}

#[event]
pub struct ScalarProposed {
    pub market: Pubkey,
    pub resolver: Pubkey,
    pub value: i64,
    pub proposed_at: i64,
}

#[event]
pub struct MarketVoided {
    pub market: Pubkey,
    pub reason: u8,
}

#[event]
pub struct Redeemed {
    pub market: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub payout: u64,
}

#[event]
pub struct LiquidityAdded {
    pub market: Pubkey,
    pub provider: Pubkey,
    pub amount: u64,
    pub shares_minted: u64,
}

#[event]
pub struct LiquidityRemoved {
    pub market: Pubkey,
    pub provider: Pubkey,
    pub shares: u64,
    pub yes_out: u64,
    pub no_out: u64,
}

#[event]
pub struct PoolClaimed {
    pub market: Pubkey,
    /// The signer who claimed (kept for compatibility).
    pub lp: Pubkey,
    /// The position owner whose shares were claimed (== `lp`).
    pub provider: Pubkey,
    pub payout: u64,
}

#[event]
pub struct FeesCollected {
    pub market: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PausedSet {
    pub paused: bool,
}

#[event]
pub struct PriceFeedInitialized {
    pub feed: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct PricePublished {
    pub feed: Pubkey,
    pub value: i64,
    pub published_at: i64,
}

// ----------------------------- Errors -----------------------------

#[error_code]
pub enum ErrorCode {
    #[msg("Fee exceeds the maximum (1000 bps)")]
    FeeTooHigh,
    #[msg("Invalid parameter")]
    InvalidParameter,
    #[msg("Invalid time window (need 0 < now < close_time <= resolution_time <= horizon)")]
    InvalidTimeWindow,
    #[msg("String exceeds maximum length")]
    StringTooLong,
    #[msg("Unsupported resolver kind")]
    UnsupportedResolverKind,
    #[msg("Market is not open for trading")]
    MarketNotOpen,
    #[msg("Market is closed for trading")]
    MarketClosed,
    #[msg("Protocol is paused")]
    Paused,
    #[msg("Market has already been seeded with liquidity")]
    AlreadySeeded,
    #[msg("Market has no liquidity")]
    NoLiquidity,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Insufficient pool shares for this operation")]
    InsufficientShares,
    #[msg("Invalid outcome (must be 0=YES or 1=NO)")]
    InvalidOutcome,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Wrong token mint for this account")]
    WrongMint,
    #[msg("Wrong owner for this token account")]
    WrongOwner,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Insufficient liquidity for this trade")]
    InsufficientLiquidity,
    #[msg("Market has not been resolved yet")]
    NotResolved,
    #[msg("No outcome has been proposed")]
    NotProposed,
    #[msg("Market is not voided")]
    NotVoid,
    #[msg("Dispute window is still open")]
    DisputeWindowOpen,
    #[msg("Dispute window has closed")]
    DisputeWindowClosed,
    #[msg("Too early to resolve this market")]
    TooEarlyToResolve,
    #[msg("Too early to void this market")]
    TooEarlyToVoid,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Wrong resolver kind for this instruction")]
    WrongResolverKind,
    #[msg("Wrong market kind for this instruction")]
    WrongMarketKind,
    #[msg("Unsupported market kind")]
    UnsupportedMarketKind,
    #[msg("Invalid scalar range (need lower_bound < upper_bound)")]
    InvalidScalarRange,
    #[msg("Invalid oracle comparison code")]
    InvalidComparison,
    #[msg("Price feed has no published value yet")]
    FeedHasNoValue,
    #[msg("Price feed value is too stale to resolve")]
    StaleFeed,
    #[msg("No bond is configured for optimistic assertions")]
    NoBondConfigured,
    #[msg("Assertion has already been disputed")]
    AlreadyDisputed,
    #[msg("Cannot dispute your own assertion")]
    SelfDispute,
    #[msg("Disputed assertion must be settled by the guardian")]
    DisputeUnresolved,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
