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
//! Lifecycle: `initialize` → `create_market` → `seed_liquidity` → `buy`/`sell`
//! (trading) → `resolve` → `redeem` (+ `claim_pool`, `collect_fees`).
//!
//! ## Conservation invariant
//!
//! At all times the collateral vault balance equals
//! `market.collateral` (backing every outstanding full set) `+ market.fee_accrued`.
//! Every YES in existence is matched 1:1 by a NO (both are minted/burned only as
//! full sets), so after resolution the winning-side supply exactly equals
//! `market.collateral`, and redemptions drain the vault to the accrued fees.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

pub mod math;

declare_id!("8xv1L7757szxo2XPrQL5AERPGZrJaYRKgqB9RgFkQCU2");

/// YES outcome index.
pub const OUTCOME_YES: u8 = 0;
/// NO outcome index.
pub const OUTCOME_NO: u8 = 1;

/// Market is open for trading.
pub const STATE_OPEN: u8 = 0;
/// Market has been resolved; redemptions are enabled.
pub const STATE_RESOLVED: u8 = 1;

pub const MARKET_SEED: &[u8] = b"market";
pub const CONFIG_SEED: &[u8] = b"config";
pub const YES_SEED: &[u8] = b"yes";
pub const NO_SEED: &[u8] = b"no";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POOL_YES_SEED: &[u8] = b"pool_yes";
pub const POOL_NO_SEED: &[u8] = b"pool_no";

#[program]
pub mod compute_markets {
    use super::*;

    /// Initialize the global config (one per deployment). `fee_bps` is the taker
    /// fee charged on `buy`/`sell` (e.g. 100 = 1%), capped at 10% (1000 bps).
    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 1_000, ErrorCode::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.collateral_mint = ctx.accounts.collateral_mint.key();
        config.fee_bps = fee_bps;
        config.market_count = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Create a new binary market. Permissionless: anyone may create one and
    /// nominate a `resolver` (the trusted oracle key for this market). The market
    /// id is the current `config.market_count`, which is then incremented.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        question: String,
        resolution_source: String,
        resolution_time: i64,
        resolver: Pubkey,
    ) -> Result<()> {
        require!(question.len() <= Market::MAX_QUESTION, ErrorCode::StringTooLong);
        require!(
            resolution_source.len() <= Market::MAX_SOURCE,
            ErrorCode::StringTooLong
        );

        let market_id = ctx.accounts.config.market_count;
        let market = &mut ctx.accounts.market;
        market.market_id = market_id;
        market.creator = ctx.accounts.creator.key();
        market.resolver = resolver;
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
        market.resolution_time = resolution_time;
        market.question = question;
        market.resolution_source = resolution_source;
        market.bump = ctx.bumps.market;

        ctx.accounts.config.market_count = market_id.checked_add(1).ok_or(ErrorCode::MathOverflow)?;

        emit!(MarketCreated {
            market_id,
            market: market.key(),
            creator: market.creator,
            resolver,
        });
        Ok(())
    }

    /// Seed the AMM with initial liquidity at 50/50 odds. Callable once, by the
    /// market creator, before any trading. Mints `amount` of each outcome into
    /// the pool and deposits `amount` collateral.
    pub fn seed_liquidity(ctx: Context<SeedLiquidity>, amount: u64) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.state == STATE_OPEN, ErrorCode::MarketNotOpen);
        require!(
            ctx.accounts.lp.key() == market.creator,
            ErrorCode::Unauthorized
        );
        require!(market.reserve_yes == 0 && market.reserve_no == 0, ErrorCode::AlreadySeeded);
        require!(amount > 0, ErrorCode::ZeroAmount);

        // Record pool accounts now that they exist.
        market.pool_yes = ctx.accounts.pool_yes.key();
        market.pool_no = ctx.accounts.pool_no.key();
        market.lp = ctx.accounts.lp.key();
        market.lp_shares = amount;
        market.reserve_yes = amount;
        market.reserve_no = amount;
        market.collateral = amount;

        // Pull collateral from the LP into the vault.
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

        // Mint a full set into the pool.
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
            amount,
        });
        Ok(())
    }

    /// Buy `outcome` (YES=0/NO=1) by investing `collateral_in`. A taker fee is
    /// deducted, a full set is minted into the pool, and the constant-product
    /// swap returns outcome tokens to the trader. Reverts if fewer than
    /// `min_tokens_out` would be received.
    pub fn buy(
        ctx: Context<Trade>,
        outcome: u8,
        collateral_in: u64,
        min_tokens_out: u64,
    ) -> Result<()> {
        require!(outcome == OUTCOME_YES || outcome == OUTCOME_NO, ErrorCode::InvalidOutcome);
        require!(collateral_in > 0, ErrorCode::ZeroAmount);

        let market = &mut ctx.accounts.market;
        require!(market.state == STATE_OPEN, ErrorCode::MarketNotOpen);
        require!(market.reserve_yes > 0 && market.reserve_no > 0, ErrorCode::NoLiquidity);

        // The user's outcome token account must be for the bought side and owned by them.
        let bought_mint = if outcome == OUTCOME_YES { market.yes_mint } else { market.no_mint };
        require_keys_eq!(ctx.accounts.user_outcome.mint, bought_mint, ErrorCode::WrongMint);
        require_keys_eq!(ctx.accounts.user_outcome.owner, ctx.accounts.user.key(), ErrorCode::WrongOwner);

        let fee = math::fee_amount(collateral_in, ctx.accounts.config.fee_bps)
            .ok_or(ErrorCode::MathOverflow)?;
        let a = collateral_in.checked_sub(fee).ok_or(ErrorCode::MathOverflow)?;
        require!(a > 0, ErrorCode::ZeroAmount);

        let (reserve_bought, reserve_other) = if outcome == OUTCOME_YES {
            (market.reserve_yes, market.reserve_no)
        } else {
            (market.reserve_no, market.reserve_yes)
        };
        let quote = math::quote_buy(reserve_bought, reserve_other, a).ok_or(ErrorCode::MathOverflow)?;
        require!(quote.tokens_out >= min_tokens_out, ErrorCode::SlippageExceeded);
        require!(quote.tokens_out > 0, ErrorCode::ZeroAmount);

        // Collateral in.
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

        // Mint a full set into the pool.
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
        let bought_pool = if outcome == OUTCOME_YES {
            ctx.accounts.pool_yes.to_account_info()
        } else {
            ctx.accounts.pool_no.to_account_info()
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

        if outcome == OUTCOME_YES {
            market.reserve_yes = quote.new_reserve_bought;
            market.reserve_no = quote.new_reserve_other;
        } else {
            market.reserve_no = quote.new_reserve_bought;
            market.reserve_yes = quote.new_reserve_other;
        }
        market.collateral = market.collateral.checked_add(a).ok_or(ErrorCode::MathOverflow)?;
        market.fee_accrued = market.fee_accrued.checked_add(fee).ok_or(ErrorCode::MathOverflow)?;

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

    /// Sell `outcome` to withdraw `collateral_out` of collateral (gross). The
    /// trader returns outcome tokens to the pool, a full set is merged out, the
    /// taker fee is deducted, and the remainder is paid to the trader. Reverts if
    /// more than `max_tokens_in` outcome tokens would be required.
    pub fn sell(
        ctx: Context<Trade>,
        outcome: u8,
        collateral_out: u64,
        max_tokens_in: u64,
    ) -> Result<()> {
        require!(outcome == OUTCOME_YES || outcome == OUTCOME_NO, ErrorCode::InvalidOutcome);
        require!(collateral_out > 0, ErrorCode::ZeroAmount);

        let market = &mut ctx.accounts.market;
        require!(market.state == STATE_OPEN, ErrorCode::MarketNotOpen);
        require!(collateral_out <= market.collateral, ErrorCode::InsufficientLiquidity);

        let sold_mint = if outcome == OUTCOME_YES { market.yes_mint } else { market.no_mint };
        require_keys_eq!(ctx.accounts.user_outcome.mint, sold_mint, ErrorCode::WrongMint);
        require_keys_eq!(ctx.accounts.user_outcome.owner, ctx.accounts.user.key(), ErrorCode::WrongOwner);

        let (reserve_sold, reserve_other) = if outcome == OUTCOME_YES {
            (market.reserve_yes, market.reserve_no)
        } else {
            (market.reserve_no, market.reserve_yes)
        };
        let quote =
            math::quote_sell(reserve_sold, reserve_other, collateral_out).ok_or(ErrorCode::InsufficientLiquidity)?;
        require!(quote.tokens_in <= max_tokens_in, ErrorCode::SlippageExceeded);
        require!(quote.tokens_in > 0, ErrorCode::ZeroAmount);

        let fee = math::fee_amount(collateral_out, ctx.accounts.config.fee_bps)
            .ok_or(ErrorCode::MathOverflow)?;
        let to_user = collateral_out.checked_sub(fee).ok_or(ErrorCode::MathOverflow)?;

        // Trader returns the sold outcome tokens into the pool.
        let sold_pool = if outcome == OUTCOME_YES {
            ctx.accounts.pool_yes.to_account_info()
        } else {
            ctx.accounts.pool_no.to_account_info()
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

        // Merge a full set out of the pool (burn `collateral_out` of each side).
        let id_bytes = market.market_id.to_le_bytes();
        let bump_seed = [market.bump];
        let seeds: &[&[u8]] = &[MARKET_SEED, id_bytes.as_ref(), bump_seed.as_ref()];
        let signer: &[&[&[u8]]] = &[seeds];
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

        // Pay the trader (net of fee) from the vault.
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

        if outcome == OUTCOME_YES {
            market.reserve_yes = quote.new_reserve_sold;
            market.reserve_no = quote.new_reserve_other;
        } else {
            market.reserve_no = quote.new_reserve_sold;
            market.reserve_yes = quote.new_reserve_other;
        }
        market.collateral = market.collateral.checked_sub(collateral_out).ok_or(ErrorCode::MathOverflow)?;
        market.fee_accrued = market.fee_accrued.checked_add(fee).ok_or(ErrorCode::MathOverflow)?;

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

    /// Resolve the market to a winning `outcome`. Only the market's `resolver`
    /// may call, and only at/after `resolution_time`.
    pub fn resolve(ctx: Context<Resolve>, outcome: u8) -> Result<()> {
        require!(outcome == OUTCOME_YES || outcome == OUTCOME_NO, ErrorCode::InvalidOutcome);
        let market = &mut ctx.accounts.market;
        require!(market.state == STATE_OPEN, ErrorCode::MarketNotOpen);
        require!(ctx.accounts.resolver.key() == market.resolver, ErrorCode::Unauthorized);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= market.resolution_time, ErrorCode::TooEarlyToResolve);

        market.outcome = outcome;
        market.state = STATE_RESOLVED;

        emit!(MarketResolved {
            market: market.key(),
            outcome,
        });
        Ok(())
    }

    /// Redeem `amount` of the winning outcome token for `amount` collateral.
    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);
        let market = &mut ctx.accounts.market;
        require!(market.state == STATE_RESOLVED, ErrorCode::NotResolved);

        let winning_mint = if market.outcome == OUTCOME_YES { market.yes_mint } else { market.no_mint };
        require_keys_eq!(ctx.accounts.winning_mint.key(), winning_mint, ErrorCode::WrongMint);
        require_keys_eq!(ctx.accounts.user_outcome.mint, winning_mint, ErrorCode::WrongMint);
        require_keys_eq!(ctx.accounts.user_outcome.owner, ctx.accounts.user.key(), ErrorCode::WrongOwner);
        require!(amount <= market.collateral, ErrorCode::InsufficientLiquidity);

        // Burn the winning tokens.
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

        // Pay collateral 1:1.
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

        market.collateral = market.collateral.checked_sub(amount).ok_or(ErrorCode::MathOverflow)?;
        Ok(())
    }

    /// After resolution, the LP claims the winning-side pool reserve as collateral.
    pub fn claim_pool(ctx: Context<ClaimPool>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.state == STATE_RESOLVED, ErrorCode::NotResolved);
        require!(ctx.accounts.lp.key() == market.lp, ErrorCode::Unauthorized);

        let (winning_mint, winning_reserve, winning_pool) = if market.outcome == OUTCOME_YES {
            (market.yes_mint, market.reserve_yes, ctx.accounts.pool_yes.to_account_info())
        } else {
            (market.no_mint, market.reserve_no, ctx.accounts.pool_no.to_account_info())
        };
        require_keys_eq!(ctx.accounts.winning_mint.key(), winning_mint, ErrorCode::WrongMint);
        require!(winning_reserve > 0, ErrorCode::NothingToClaim);
        require!(winning_reserve <= market.collateral, ErrorCode::InsufficientLiquidity);

        let id_bytes = market.market_id.to_le_bytes();
        let bump_seed = [market.bump];
        let seeds: &[&[u8]] = &[MARKET_SEED, id_bytes.as_ref(), bump_seed.as_ref()];
        let signer: &[&[&[u8]]] = &[seeds];
        // Burn the pool's winning tokens.
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.winning_mint.to_account_info(),
                    from: winning_pool,
                    authority: market.to_account_info(),
                },
                signer,
            ),
            winning_reserve,
        )?;
        // Pay the LP.
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
            winning_reserve,
        )?;

        market.collateral = market.collateral.checked_sub(winning_reserve).ok_or(ErrorCode::MathOverflow)?;
        if market.outcome == OUTCOME_YES {
            market.reserve_yes = 0;
        } else {
            market.reserve_no = 0;
        }
        Ok(())
    }

    /// Admin withdraws accrued protocol fees for this market.
    pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
        require!(ctx.accounts.admin.key() == ctx.accounts.config.admin, ErrorCode::Unauthorized);
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
        Ok(())
    }
}

// ----------------------------- Accounts (state) -----------------------------

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub collateral_mint: Pubkey,
    pub fee_bps: u16,
    pub market_count: u64,
    pub bump: u8,
}

impl Config {
    pub const SPACE: usize = 8 + 32 + 32 + 2 + 8 + 1;
}

#[account]
pub struct Market {
    pub market_id: u64,
    pub creator: Pubkey,
    pub resolver: Pubkey,
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
    /// Collateral backing outstanding full sets (excludes accrued fees).
    pub collateral: u64,
    pub fee_accrued: u64,
    pub state: u8,
    pub outcome: u8,
    pub resolution_time: i64,
    pub question: String,
    pub resolution_source: String,
    pub bump: u8,
}

impl Market {
    pub const MAX_QUESTION: usize = 200;
    pub const MAX_SOURCE: usize = 80;
    pub const SPACE: usize = 8 // discriminator
        + 8  // market_id
        + 32 // creator
        + 32 // resolver
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
        + 8  // resolution_time
        + 4 + Self::MAX_QUESTION   // question
        + 4 + Self::MAX_SOURCE     // resolution_source
        + 1; // bump
}

// ----------------------------- Contexts -----------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = Config::SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
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
        init,
        payer = creator,
        seeds = [YES_SEED, market.key().as_ref()],
        bump,
        mint::decimals = math::DECIMALS,
        mint::authority = market,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        seeds = [NO_SEED, market.key().as_ref()],
        bump,
        mint::decimals = math::DECIMALS,
        mint::authority = market,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market,
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
    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(mut, address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = lp,
        seeds = [POOL_YES_SEED, market.key().as_ref()],
        bump,
        token::mint = yes_mint,
        token::authority = market,
    )]
    pub pool_yes: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = lp,
        seeds = [POOL_NO_SEED, market.key().as_ref()],
        bump,
        token::mint = no_mint,
        token::authority = market,
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

    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
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

    /// The trader's outcome-token account for the side being traded (validated in handler).
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
pub struct Resolve<'info> {
    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,
    pub resolver: Signer<'info>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
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
    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(mut)]
    pub winning_mint: Box<Account<'info, Mint>>,
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
    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
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

// ----------------------------- Events -----------------------------

#[event]
pub struct MarketCreated {
    pub market_id: u64,
    pub market: Pubkey,
    pub creator: Pubkey,
    pub resolver: Pubkey,
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
pub struct MarketResolved {
    pub market: Pubkey,
    pub outcome: u8,
}

// ----------------------------- Errors -----------------------------

#[error_code]
pub enum ErrorCode {
    #[msg("Fee exceeds the maximum (1000 bps)")]
    FeeTooHigh,
    #[msg("String exceeds maximum length")]
    StringTooLong,
    #[msg("Market is not open for trading")]
    MarketNotOpen,
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
    #[msg("Too early to resolve this market")]
    TooEarlyToResolve,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
