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
    /// * `dispute_period` — seconds between a proposed outcome and payout unlock.
    /// * `guardian` — key allowed to pause and to veto a proposed outcome.
    pub fn initialize(
        ctx: Context<Initialize>,
        fee_bps: u16,
        dispute_period: i64,
        guardian: Pubkey,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, ErrorCode::FeeTooHigh);
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
        config.dispute_period = dispute_period;
        config.market_count = 0;
        config.paused = false;
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
            _ => return err!(ErrorCode::UnsupportedResolverKind),
        }

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
        market.lp_shares = 0;
        market.collateral = 0;
        market.fee_accrued = 0;
        market.state = STATE_OPEN;
        market.outcome = 0;
        market.proposed_outcome = 0;
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
        market.lp_shares = amount;
        market.reserve_yes = amount;
        market.reserve_no = amount;
        market.collateral = amount;

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
        market.fee_accrued = market
            .fee_accrued
            .checked_add(fee)
            .ok_or(ErrorCode::MathOverflow)?;

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
        market.fee_accrued = market
            .fee_accrued
            .checked_add(fee)
            .ok_or(ErrorCode::MathOverflow)?;

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
        market.outcome = market.proposed_outcome;

        emit!(MarketResolved {
            market: market.key(),
            outcome: market.outcome,
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

    /// After settlement, the LP reclaims the pool's outcome tokens as collateral:
    /// the winning-side reserve on a YES/NO resolution, or half of each reserve on
    /// a void.
    pub fn claim_pool(ctx: Context<ClaimPool>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(
            market.state == STATE_RESOLVED || market.state == STATE_VOID,
            ErrorCode::NotResolved
        );
        require!(ctx.accounts.lp.key() == market.lp, ErrorCode::Unauthorized);
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

        let id_bytes = market.market_id.to_le_bytes();
        let bump_seed = [market.bump];
        let seeds: &[&[u8]] = &[MARKET_SEED, id_bytes.as_ref(), bump_seed.as_ref()];
        let signer: &[&[&[u8]]] = &[seeds];

        let payout: u64 = if market.state == STATE_RESOLVED {
            // Winning-side reserve redeems 1:1; the losing-side pool tokens are worthless.
            let side = Side::from_u8(market.outcome)?;
            let (winning_reserve, winning_pool, winning_mint) = match side {
                Side::Yes => (
                    market.reserve_yes,
                    ctx.accounts.pool_yes.to_account_info(),
                    ctx.accounts.yes_mint.to_account_info(),
                ),
                Side::No => (
                    market.reserve_no,
                    ctx.accounts.pool_no.to_account_info(),
                    ctx.accounts.no_mint.to_account_info(),
                ),
            };
            require!(winning_reserve > 0, ErrorCode::NothingToClaim);
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: winning_mint,
                        from: winning_pool,
                        authority: market.to_account_info(),
                    },
                    signer,
                ),
                winning_reserve,
            )?;
            market.reserve_yes = 0;
            market.reserve_no = 0;
            winning_reserve
        } else {
            // Void: half of each reserve.
            let ry = market.reserve_yes;
            let rn = market.reserve_no;
            require!(ry > 0 || rn > 0, ErrorCode::NothingToClaim);
            if ry > 0 {
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
                    ry,
                )?;
            }
            if rn > 0 {
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
                    rn,
                )?;
            }
            market.reserve_yes = 0;
            market.reserve_no = 0;
            (ry / 2) + (rn / 2)
        };

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
    pub dispute_period: i64,
    pub market_count: u64,
    pub paused: bool,
    pub bump: u8,
}

impl Config {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 32 + 2 + 8 + 8 + 1 + 1;
}

#[account]
pub struct Market {
    pub market_id: u64,
    pub creator: Pubkey,
    pub resolver: Pubkey,
    pub resolver_kind: u8,
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
    pub lp: Pubkey,
    pub lp_shares: u64,
    /// Collateral backing outstanding tokens (excludes accrued fees).
    pub collateral: u64,
    pub fee_accrued: u64,
    pub state: u8,
    pub outcome: u8,
    pub proposed_outcome: u8,
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
        + 8  // lp_shares
        + 8  // collateral
        + 8  // fee_accrued
        + 1  // state
        + 1  // outcome
        + 1  // proposed_outcome
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

    #[account(mut)]
    pub lp: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
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
    pub resolved_at: i64,
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
pub struct PoolClaimed {
    pub market: Pubkey,
    pub lp: Pubkey,
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
    #[msg("Invalid oracle comparison code")]
    InvalidComparison,
    #[msg("Price feed has no published value yet")]
    FeedHasNoValue,
    #[msg("Price feed value is too stale to resolve")]
    StaleFeed,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
