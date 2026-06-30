//! Pure, dependency-free market math for the fixed-product market maker (FPMM).
//!
//! These functions contain ALL the economically load-bearing arithmetic and are
//! intentionally free of any Solana / Anchor types so they can be exhaustively
//! unit-tested on the host with `cargo test` (no SBF toolchain required).
//!
//! ## Model
//!
//! A binary market has two outcome tokens, YES and NO, each redeemable for 1 unit
//! of collateral (USDC, 6 decimals) if it is the winning outcome. The AMM holds
//! reserves `(r_yes, r_no)` of the two outcome tokens and preserves the constant
//! product `k = r_yes * r_no` across trades.
//!
//! Trading is implemented with the Gnosis/Polymarket "split & swap" technique:
//!
//! * **buy(outcome, a)** — the trader invests `a` collateral. The protocol mints a
//!   full set (`a` YES + `a` NO) into the pool, then returns `y` of the bought
//!   outcome to the trader such that the constant product is preserved.
//! * **sell(outcome, a)** — the trader withdraws `a` collateral. They return `r` of
//!   the sold outcome to the pool; the protocol then merges `a` YES + `a` NO out of
//!   the pool (burning a full set) and pays the trader `a` collateral.
//!
//! ## Rounding policy (safety critical)
//!
//! Every rounding decision is made so that the pool's constant product **never
//! decreases**. Concretely, the reserve that the pool keeps is rounded **up**
//! (`ceil`), which means the trader receives slightly fewer tokens on a buy and
//! pays slightly more tokens on a sell. This guarantees the invariant
//! `r_yes' * r_no' >= r_yes * r_no` and prevents value from leaking out of the pool
//! through repeated trades. The unit tests assert this property directly.

/// Number of decimals for collateral and outcome tokens (USDC convention).
pub const DECIMALS: u8 = 6;

/// Basis-points denominator.
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Ceiling division for u128. Returns `ceil(a / b)`. Overflow-proof: computed as
/// `a / b + (a % b != 0)` so it never forms the `a + b - 1` intermediate. Callers
/// ensure `b > 0`.
#[inline]
fn ceil_div(a: u128, b: u128) -> u128 {
    a / b + if a.is_multiple_of(b) { 0 } else { 1 }
}

/// Result of a buy quote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuyQuote {
    /// Outcome tokens of the bought side delivered to the trader.
    pub tokens_out: u64,
    /// New reserve of the bought side after the trade.
    pub new_reserve_bought: u64,
    /// New reserve of the other side after the trade.
    pub new_reserve_other: u64,
}

/// Result of a sell quote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SellQuote {
    /// Outcome tokens of the sold side the trader must deliver to the pool.
    pub tokens_in: u64,
    /// New reserve of the sold side after the trade.
    pub new_reserve_sold: u64,
    /// New reserve of the other side after the trade.
    pub new_reserve_other: u64,
}

/// Quote a buy of `collateral_in` (net of fees) into the `bought` reserve.
///
/// Given reserves `(reserve_bought, reserve_other)` and an investment of `a`
/// collateral, the pool first gains `a` of each outcome (the minted full set),
/// then returns `y` of the bought outcome so that the product is preserved:
///
/// ```text
/// (reserve_bought + a - y) * (reserve_other + a) >= reserve_bought * reserve_other
/// ```
///
/// `keep = ceil(k / (reserve_other + a))` is the bought reserve the pool retains
/// (rounded up for safety), and `y = reserve_bought + a - keep`.
///
/// Returns `None` on arithmetic overflow. `a == 0` yields a zero-token quote.
pub fn quote_buy(reserve_bought: u64, reserve_other: u64, a: u64) -> Option<BuyQuote> {
    let rb = reserve_bought as u128;
    let ro = reserve_other as u128;
    let a = a as u128;

    if a == 0 {
        return Some(BuyQuote {
            tokens_out: 0,
            new_reserve_bought: reserve_bought,
            new_reserve_other: reserve_other,
        });
    }
    // Both reserves must be positive for a meaningful constant product.
    if rb == 0 || ro == 0 {
        return None;
    }

    let k = rb.checked_mul(ro)?;
    let denom = ro.checked_add(a)?;
    let keep = ceil_div(k, denom); // bought reserve retained (rounded up => safe)
    let new_bought = keep; // == reserve_bought + a - y
    let new_other = ro.checked_add(a)?;
    // y = (rb + a) - keep. keep <= rb (since k/(ro+a) < rb), so this never underflows.
    let y = rb.checked_add(a)?.checked_sub(keep)?;

    Some(BuyQuote {
        tokens_out: u64::try_from(y).ok()?,
        new_reserve_bought: u64::try_from(new_bought).ok()?,
        new_reserve_other: u64::try_from(new_other).ok()?,
    })
}

/// Quote a sell that withdraws `a` collateral from the `sold` reserve.
///
/// The trader returns `r` of the sold outcome, then the pool merges `a` of each
/// outcome out (burning a full set) to release `a` collateral:
///
/// ```text
/// (reserve_sold + r - a) * (reserve_other - a) >= reserve_sold * reserve_other
/// ```
///
/// `need = ceil(k / (reserve_other - a))` is the sold reserve the pool must hold
/// afterwards (rounded up for safety), and `r = need + a - reserve_sold`.
///
/// Returns `None` if `a >= reserve_other` (cannot remove the entire other reserve)
/// or on overflow. `a == 0` yields a zero-token quote.
pub fn quote_sell(reserve_sold: u64, reserve_other: u64, a: u64) -> Option<SellQuote> {
    let rs = reserve_sold as u128;
    let ro = reserve_other as u128;
    let a = a as u128;

    if a == 0 {
        return Some(SellQuote {
            tokens_in: 0,
            new_reserve_sold: reserve_sold,
            new_reserve_other: reserve_other,
        });
    }
    if rs == 0 || ro == 0 {
        return None;
    }
    // Must leave a strictly positive `other` reserve.
    if a >= ro {
        return None;
    }

    let k = rs.checked_mul(ro)?;
    let denom = ro.checked_sub(a)?;
    let need = ceil_div(k, denom); // sold reserve required afterwards (rounded up => safe)
    let new_other = ro.checked_sub(a)?;
    // r = need + a - rs. need >= rs (since ro/(ro-a) >= 1), so this never underflows.
    let r = need.checked_add(a)?.checked_sub(rs)?;

    Some(SellQuote {
        tokens_in: u64::try_from(r).ok()?,
        new_reserve_sold: u64::try_from(need).ok()?,
        new_reserve_other: u64::try_from(new_other).ok()?,
    })
}

/// Marginal price (probability) of the outcome whose reserve is `reserve_self`,
/// scaled by 1e6 (so 500_000 == 0.50). Price of an outcome = other_reserve /
/// (self_reserve + other_reserve). Returns `None` if the pool is empty.
pub fn marginal_price_micro(reserve_self: u64, reserve_other: u64) -> Option<u64> {
    let total = (reserve_self as u128).checked_add(reserve_other as u128)?;
    if total == 0 {
        return None;
    }
    let price = (reserve_other as u128)
        .checked_mul(1_000_000)?
        .checked_div(total)?;
    u64::try_from(price).ok()
}

/// Compute the protocol fee for `amount` at `fee_bps`, rounded down.
pub fn fee_amount(amount: u64, fee_bps: u16) -> Option<u64> {
    let f = (amount as u128)
        .checked_mul(fee_bps as u128)?
        .checked_div(BPS_DENOMINATOR as u128)?;
    u64::try_from(f).ok()
}

/// Fixed-point scale for scalar-market settlement fractions: a fraction `f` in
/// `[0, 1]` is represented as the integer `f * PRICE_SCALE`, so `PRICE_SCALE`
/// means 1.0 and `PRICE_SCALE / 2` means 0.5. (Matches the 1e6 price scale used
/// by [`marginal_price_micro`].)
pub const PRICE_SCALE: u64 = 1_000_000;

/// Map a scalar settlement `value` to a settlement fraction `f` in
/// `[0, PRICE_SCALE]`, where `f = (clamp(value, lower, upper) - lower) /
/// (upper - lower)`. LONG (=YES) tokens settle at `f`, SHORT (=NO) at `1 - f`.
///
/// `value` is clamped to `[lower, upper]` first, so out-of-range settlements map
/// to the nearest bound (0 or PRICE_SCALE). Returns `None` unless `upper > lower`.
/// All arithmetic uses i128/u128 intermediates so the full i64 bound range is safe
/// (`upper - lower` can approach 2^64, which overflows i64 but not i128/u128).
pub fn scalar_fraction(value: i64, lower: i64, upper: i64) -> Option<u32> {
    if upper <= lower {
        return None;
    }
    let lo = lower as i128;
    let hi = upper as i128;
    let v = (value as i128).clamp(lo, hi);
    // Both differences are >= 0 and `hi - lo > 0` after the guard above.
    let num = (v - lo) as u128;
    let span = (hi - lo) as u128;
    let f = num.checked_mul(PRICE_SCALE as u128)? / span;
    // `num <= span` after clamping, so `f <= PRICE_SCALE` and fits in u32.
    u32::try_from(f).ok()
}

/// Payout (in collateral base units) for `amount` outcome tokens of a scalar
/// market that resolved to `fraction_micro` (a value in `[0, PRICE_SCALE]`).
///
/// LONG settles at the fraction, SHORT at its complement:
/// * LONG  → `amount * fraction_micro / PRICE_SCALE`
/// * SHORT → `amount * (PRICE_SCALE - fraction_micro) / PRICE_SCALE`
///
/// Rounds **down** (floor) so the vault is never overpaid. Because both sides
/// floor, `long_payout + short_payout <= amount` for any single `amount` — the
/// no-overpay / conservation property the unit tests assert. `fraction_micro` is
/// assumed `<= PRICE_SCALE` (guaranteed by [`scalar_fraction`]); larger values
/// saturate the complement to zero rather than underflowing.
pub fn scalar_payout(amount: u64, fraction_micro: u32, is_long: bool) -> u64 {
    let frac = if is_long {
        fraction_micro as u128
    } else {
        (PRICE_SCALE as u128).saturating_sub(fraction_micro as u128)
    };
    let payout = (amount as u128) * frac / PRICE_SCALE as u128;
    // payout <= amount <= u64::MAX, so this never truncates.
    payout as u64
}

// ----------------------------- Liquidity provider (LP) share math -----------------------------
//
// Multi-LP pooling follows the Gnosis FPMM `addFunding` / `removeFunding` design.
// Pool shares track each provider's pro-rata claim on the AMM reserves. ALL
// rounding here is chosen to favor the pool / existing LPs and never the entrant
// or remover, mirroring the trade rounding policy above.
//
// * Adding funding: the new LP deposits `amount` collateral, the protocol mints a
//   full set (`amount` of each outcome) into the pool, then sends back the surplus
//   of each side so the **price ratio is preserved**. Shares minted are
//   proportional to `amount / pool_weight`, FLOORED — the entrant never gets more
//   shares than fair.
// * Removing / claiming: a provider's slice of each reserve is
//   `reserve_i * shares / total_shares`, FLOORED — the remover never pulls more
//   than fair, so leftover dust stays with the remaining LPs / the pool.

/// Pool weight used to price `add_liquidity`: the larger of the two reserves.
/// (Gnosis uses `max(reserves)` as the funding denominator.)
#[inline]
pub fn pool_weight(reserve_yes: u64, reserve_no: u64) -> u64 {
    reserve_yes.max(reserve_no)
}

/// Pool shares minted for an `add_liquidity(amount)` against an existing pool.
///
/// `shares_minted = floor(amount * total_shares / pool_weight)`.
///
/// FLOORED so a new LP is never credited more shares than their pro-rata deposit
/// warrants (favoring existing LPs). Returns `None` on overflow or when
/// `pool_weight == 0` (an unseeded pool — callers reject that earlier).
pub fn lp_shares_minted(amount: u64, total_shares: u64, pool_weight: u64) -> Option<u64> {
    if pool_weight == 0 {
        return None;
    }
    let minted = (amount as u128)
        .checked_mul(total_shares as u128)?
        .checked_div(pool_weight as u128)?;
    u64::try_from(minted).ok()
}

/// Collateral the pool KEEPS of one side on an `add_liquidity`, rounded UP
/// (`ceil`). The full set minted in is `amount` per side; the pool keeps
/// `ceil(amount * reserve_i / pool_weight)` and the rest is sent back to the LP.
///
/// Ceiling the kept amount means the LP's send-back is the SMALLER value, so the
/// pool retains at least its fair share (favoring existing LPs). `reserve_i <=
/// pool_weight`, so the result never exceeds `amount` and the send-back is
/// non-negative. Returns `None` on overflow or `pool_weight == 0`.
pub fn lp_add_keep(amount: u64, reserve_side: u64, pool_weight: u64) -> Option<u64> {
    if pool_weight == 0 {
        return None;
    }
    let keep = ceil_div(
        (amount as u128).checked_mul(reserve_side as u128)?,
        pool_weight as u128,
    );
    u64::try_from(keep).ok()
}

/// Outcome tokens sent back to the LP for one side on an `add_liquidity`:
/// `amount - lp_add_keep(...)`. Always `>= 0` because `reserve_side <=
/// pool_weight` implies `keep <= amount`. Returns `None` on overflow.
pub fn lp_add_sendback(amount: u64, reserve_side: u64, pool_weight: u64) -> Option<u64> {
    let keep = lp_add_keep(amount, reserve_side, pool_weight)?;
    amount.checked_sub(keep)
}

/// A provider's pro-rata slice of one reserve given their `shares` out of
/// `total_shares`: `floor(reserve_side * shares / total_shares)`.
///
/// FLOORED so a remover / claimer never pulls more than their fair fraction;
/// leftover dust stays with the remaining LPs (or the pool). Used by both
/// `remove_liquidity` and `claim_pool`. Returns `None` on overflow or when
/// `total_shares == 0` (callers reject that earlier).
pub fn lp_slice(reserve_side: u64, shares: u64, total_shares: u64) -> Option<u64> {
    if total_shares == 0 {
        return None;
    }
    let slice = (reserve_side as u128)
        .checked_mul(shares as u128)?
        .checked_div(total_shares as u128)?;
    u64::try_from(slice).ok()
}

/// Oracle comparison: YES iff the feed value is `>=` the strike.
pub const CMP_GTE: u8 = 0;
/// Oracle comparison: YES iff the feed value is `<=` the strike.
pub const CMP_LTE: u8 = 1;

/// Map an oracle `value` and `strike` to a binary outcome under `comparison`.
/// Returns `Some(true)` for a YES resolution, `Some(false)` for NO, and `None`
/// for an unknown comparison code. Both `value` and `strike` are in the feed's
/// native fixed-point integer scale (so the comparison is exact integer math).
pub fn oracle_is_yes(value: i64, strike: i64, comparison: u8) -> Option<bool> {
    match comparison {
        CMP_GTE => Some(value >= strike),
        CMP_LTE => Some(value <= strike),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn product(a: u64, b: u64) -> u128 {
        a as u128 * b as u128
    }

    #[test]
    fn buy_returns_at_least_invested_at_even_odds() {
        // 50/50 pool: buying with `a` should yield > a tokens (price < 1).
        let q = quote_buy(1_000_000, 1_000_000, 100_000).unwrap();
        assert!(q.tokens_out >= 100_000, "got {}", q.tokens_out);
    }

    #[test]
    fn buy_preserves_or_increases_constant_product() {
        let k0 = product(1_000_000, 1_000_000);
        let q = quote_buy(1_000_000, 1_000_000, 250_000).unwrap();
        let k1 = product(q.new_reserve_bought, q.new_reserve_other);
        assert!(k1 >= k0, "k decreased: {} -> {}", k0, k1);
    }

    #[test]
    fn sell_preserves_or_increases_constant_product() {
        let k0 = product(1_000_000, 1_000_000);
        let q = quote_sell(1_000_000, 1_000_000, 250_000).unwrap();
        let k1 = product(q.new_reserve_sold, q.new_reserve_other);
        assert!(k1 >= k0, "k decreased: {} -> {}", k0, k1);
    }

    #[test]
    fn buy_then_sell_is_not_profitable_for_trader() {
        // A buy immediately followed by selling back the same collateral amount
        // must cost the trader at least as many tokens as they received (no free money).
        let (ry, rn) = (5_000_000u64, 5_000_000u64);
        let a = 500_000u64;
        let buy = quote_buy(ry, rn, a).unwrap(); // buy YES
                                                 // Now sell `a` collateral worth back out of the new pool.
        let sell = quote_sell(buy.new_reserve_bought, buy.new_reserve_other, a).unwrap();
        assert!(
            sell.tokens_in >= buy.tokens_out,
            "round trip profitable: received {} YES on buy, only need {} YES to pull {} back out",
            buy.tokens_out,
            sell.tokens_in,
            a
        );
    }

    #[test]
    fn sell_rejects_draining_other_reserve() {
        assert!(quote_sell(1_000_000, 1_000_000, 1_000_000).is_none());
        assert!(quote_sell(1_000_000, 1_000_000, 2_000_000).is_none());
        assert!(quote_sell(1_000_000, 1_000_000, 999_999).is_some());
    }

    #[test]
    fn zero_amount_is_noop() {
        let b = quote_buy(123, 456, 0).unwrap();
        assert_eq!(b.tokens_out, 0);
        assert_eq!((b.new_reserve_bought, b.new_reserve_other), (123, 456));
        let s = quote_sell(123, 456, 0).unwrap();
        assert_eq!(s.tokens_in, 0);
        assert_eq!((s.new_reserve_sold, s.new_reserve_other), (123, 456));
    }

    #[test]
    fn empty_pool_is_rejected() {
        assert!(quote_buy(0, 0, 100).is_none());
        assert!(quote_buy(0, 100, 100).is_none());
        assert!(quote_sell(100, 0, 1).is_none());
    }

    #[test]
    fn price_moves_toward_bought_side() {
        let (ry, rn) = (1_000_000u64, 1_000_000u64);
        let p0 = marginal_price_micro(ry, rn).unwrap();
        assert_eq!(p0, 500_000);
        // Buy YES -> YES reserve falls, YES price rises.
        let q = quote_buy(ry, rn, 400_000).unwrap();
        let p1 = marginal_price_micro(q.new_reserve_bought, q.new_reserve_other).unwrap();
        assert!(
            p1 > p0,
            "yes price should rise after buying yes: {} -> {}",
            p0,
            p1
        );
    }

    #[test]
    fn oracle_decision() {
        // value >= strike => YES
        assert_eq!(oracle_is_yes(250, 220, CMP_GTE), Some(true));
        assert_eq!(oracle_is_yes(220, 220, CMP_GTE), Some(true)); // boundary inclusive
        assert_eq!(oracle_is_yes(219, 220, CMP_GTE), Some(false));
        // value <= strike => YES
        assert_eq!(oracle_is_yes(150, 220, CMP_LTE), Some(true));
        assert_eq!(oracle_is_yes(220, 220, CMP_LTE), Some(true));
        assert_eq!(oracle_is_yes(221, 220, CMP_LTE), Some(false));
        // negative values compare correctly
        assert_eq!(oracle_is_yes(-5, -10, CMP_GTE), Some(true));
        // unknown comparison rejected
        assert_eq!(oracle_is_yes(1, 1, 7), None);
    }

    #[test]
    fn scalar_fraction_basic() {
        // Range [200, 300] ($2.00–$3.00 in cents).
        assert_eq!(scalar_fraction(200, 200, 300), Some(0)); // at lower
        assert_eq!(scalar_fraction(300, 200, 300), Some(PRICE_SCALE as u32)); // at upper
        assert_eq!(scalar_fraction(250, 200, 300), Some(500_000)); // midpoint
        assert_eq!(scalar_fraction(290, 200, 300), Some(900_000)); // near upper
        assert_eq!(scalar_fraction(210, 200, 300), Some(100_000)); // near lower

        // Clamping: below lower -> 0, above upper -> PRICE_SCALE.
        assert_eq!(scalar_fraction(199, 200, 300), Some(0));
        assert_eq!(scalar_fraction(-50, 200, 300), Some(0));
        assert_eq!(scalar_fraction(301, 200, 300), Some(PRICE_SCALE as u32));
        assert_eq!(scalar_fraction(10_000, 200, 300), Some(PRICE_SCALE as u32));
        // Negative bounds compare/clamp correctly.
        assert_eq!(scalar_fraction(0, -100, 100), Some(500_000));
        assert_eq!(scalar_fraction(-50, -100, 100), Some(250_000));
        // Degenerate / inverted ranges rejected.
        assert_eq!(scalar_fraction(5, 10, 10), None);
        assert_eq!(scalar_fraction(5, 10, 0), None);
    }

    #[test]
    fn scalar_fraction_no_overflow_at_extremes() {
        // upper - lower approaches 2^64 (overflows i64, fine in i128/u128).
        let f = scalar_fraction(0, i64::MIN, i64::MAX).unwrap();
        assert!(f <= PRICE_SCALE as u32);
        // Value at the upper extreme maps to PRICE_SCALE.
        assert_eq!(
            scalar_fraction(i64::MAX, i64::MIN, i64::MAX),
            Some(PRICE_SCALE as u32)
        );
        assert_eq!(scalar_fraction(i64::MIN, i64::MIN, i64::MAX), Some(0));
    }

    #[test]
    fn scalar_payout_basic() {
        // f = 0: LONG gets nothing, SHORT gets everything.
        assert_eq!(scalar_payout(1_000_000, 0, true), 0);
        assert_eq!(scalar_payout(1_000_000, 0, false), 1_000_000);
        // f = PRICE_SCALE: LONG gets everything, SHORT gets nothing.
        assert_eq!(
            scalar_payout(1_000_000, PRICE_SCALE as u32, true),
            1_000_000
        );
        assert_eq!(scalar_payout(1_000_000, PRICE_SCALE as u32, false), 0);
        // f = half: both get half.
        assert_eq!(scalar_payout(1_000_000, 500_000, true), 500_000);
        assert_eq!(scalar_payout(1_000_000, 500_000, false), 500_000);
        // Floor rounding: an odd amount at half loses 1 base unit total.
        assert_eq!(scalar_payout(1, 500_000, true), 0);
        assert_eq!(scalar_payout(1, 500_000, false), 0);
        // 90/10 split.
        assert_eq!(scalar_payout(1_000_000, 900_000, true), 900_000);
        assert_eq!(scalar_payout(1_000_000, 900_000, false), 100_000);
    }

    #[test]
    fn lp_share_math_basic() {
        // Seeded 1000/1000, total_shares == 1000 (== seed amount). Weight = 1000.
        let w = pool_weight(1_000, 1_000);
        assert_eq!(w, 1_000);
        // Adding 1000 against a balanced 1000/1000 pool mints 1000 shares (doubles
        // the pool) and sends back 0 of each side (full set is kept on both).
        assert_eq!(lp_shares_minted(1_000, 1_000, w).unwrap(), 1_000);
        assert_eq!(lp_add_sendback(1_000, 1_000, w).unwrap(), 0);

        // Skewed pool 2000 YES / 1000 NO (YES cheaper). Weight = 2000.
        let w = pool_weight(2_000, 1_000);
        assert_eq!(w, 2_000);
        // Add 2000: mint 2000 of each side in; pool keeps all 2000 YES (the heavy
        // side) and ceil(2000*1000/2000)=1000 NO, sending back 1000 NO. Shares
        // minted = 2000*total/2000 = total (doubles).
        assert_eq!(lp_add_keep(2_000, 2_000, w).unwrap(), 2_000); // YES kept
        assert_eq!(lp_add_sendback(2_000, 2_000, w).unwrap(), 0); // YES sendback
        assert_eq!(lp_add_keep(2_000, 1_000, w).unwrap(), 1_000); // NO kept
        assert_eq!(lp_add_sendback(2_000, 1_000, w).unwrap(), 1_000); // NO sendback

        // Pro-rata slice: half the shares pulls (floored) half of each reserve.
        assert_eq!(lp_slice(1_000, 500, 1_000).unwrap(), 500);
        assert_eq!(lp_slice(999, 500, 1_000).unwrap(), 499); // floor, not 499.5
    }

    #[test]
    fn lp_add_keep_ceils_in_pool_favor() {
        // amount*reserve/weight = 3*1/2 = 1.5 -> keep ceils to 2, sendback = 1.
        // (Flooring would keep 1 and send back 2, leaking value to the entrant.)
        assert_eq!(lp_add_keep(3, 1, 2).unwrap(), 2);
        assert_eq!(lp_add_sendback(3, 1, 2).unwrap(), 1);
    }

    #[test]
    fn lp_share_math_rejects_degenerate() {
        assert!(lp_shares_minted(100, 1_000, 0).is_none()); // zero weight
        assert!(lp_add_keep(100, 50, 0).is_none());
        assert!(lp_slice(100, 50, 0).is_none()); // zero total shares
    }

    #[test]
    fn fee_math() {
        assert_eq!(fee_amount(1_000_000, 100).unwrap(), 10_000); // 1%
        assert_eq!(fee_amount(1_000_000, 0).unwrap(), 0);
        assert_eq!(fee_amount(0, 100).unwrap(), 0);
        assert_eq!(fee_amount(999, 100).unwrap(), 9); // rounds down
    }

    #[test]
    fn large_values_do_not_overflow() {
        // Reserves near 1e15 (1e9 tokens at 6 decimals). Product ~1e30 fits in u128.
        let big = 1_000_000_000_000_000u64;
        let q = quote_buy(big, big, 1_000_000_000).unwrap();
        let k0 = product(big, big);
        let k1 = product(q.new_reserve_bought, q.new_reserve_other);
        assert!(k1 >= k0);
    }

    use proptest::prelude::*;

    // Reserves are SPL u64 token balances; outcome tokens at 6 decimals reach
    // ~1.8e13 for 18M tokens, but exercise much further toward the u64 envelope
    // (~9.2e18) so the u128 intermediates are stressed. The product of two such
    // reserves approaches ~8.5e37, still inside u128 (~3.4e38).
    const RMAX: u64 = 3_000_000_000_000_000_000; // 3e18

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(4000))]

        #[test]
        fn prop_buy_invariants(
            rb in 1u64..RMAX,
            ro in 1u64..RMAX,
            a in 0u64..RMAX,
        ) {
            if let Some(q) = quote_buy(rb, ro, a) {
                // 1. Constant product never decreases (no value leaks from the pool).
                prop_assert!(product(q.new_reserve_bought, q.new_reserve_other) >= product(rb, ro));
                // 2. No-underflow: the retained reserve `keep` never exceeds rb+a.
                prop_assert!(q.new_reserve_bought as u128 <= rb as u128 + a as u128);
                // 3. Marginal price <= 1: trader receives at least `a` tokens.
                prop_assert!(q.tokens_out >= a);
                // 4. Other reserve grows by exactly `a` (full set minted in).
                prop_assert_eq!(q.new_reserve_other as u128, ro as u128 + a as u128);
                // 5. Token accounting closes: bought reserve = rb + a - tokens_out.
                prop_assert_eq!(q.new_reserve_bought as u128, rb as u128 + a as u128 - q.tokens_out as u128);
                // 6. Ceil-tightness: `keep` is the smallest value preserving the product.
                let keep = q.new_reserve_bought as u128;
                let denom = ro as u128 + a as u128;
                if keep > 0 {
                    prop_assert!((keep - 1) * denom < product(rb, ro));
                }
            }
        }

        #[test]
        fn prop_sell_invariants(
            rs in 1u64..RMAX,
            ro in 2u64..RMAX,
            a in 0u64..RMAX,
        ) {
            if let Some(q) = quote_sell(rs, ro, a) {
                prop_assert!(product(q.new_reserve_sold, q.new_reserve_other) >= product(rs, ro));
                // No-underflow: required reserve `need` is at least rs.
                prop_assert!(q.new_reserve_sold >= rs);
                prop_assert!(q.tokens_in >= a);
                prop_assert_eq!(q.new_reserve_other as u128, ro as u128 - a as u128);
                prop_assert_eq!(q.new_reserve_sold as u128, rs as u128 + q.tokens_in as u128 - a as u128);
            }
        }

        // Buy then immediately sell the same collateral back out of the resulting
        // pool: the trader can never extract more tokens than they received (no
        // free money), across the full reserve envelope.
        #[test]
        fn prop_round_trip_not_profitable(
            ry in 1_000u64..RMAX,
            rn in 1_000u64..RMAX,
            a in 1u64..1_000_000_000_000u64,
        ) {
            if let Some(buy) = quote_buy(ry, rn, a) {
                if let Some(sell) = quote_sell(buy.new_reserve_bought, buy.new_reserve_other, a) {
                    prop_assert!(sell.tokens_in >= buy.tokens_out);
                }
            }
        }

        // Scalar settlement never overpays the vault: for the SAME `amount`, a
        // LONG payout plus a SHORT payout is at most `amount` (both floor), and
        // each side is individually <= amount. `fraction` spans the full valid
        // [0, PRICE_SCALE] range.
        #[test]
        fn prop_scalar_payout_no_overpay(
            amount in 0u64..u64::MAX,
            fraction in 0u32..=(PRICE_SCALE as u32),
        ) {
            let long = scalar_payout(amount, fraction, true);
            let short = scalar_payout(amount, fraction, false);
            prop_assert!(long <= amount);
            prop_assert!(short <= amount);
            // No-overpay / conservation: the two halves of one position never
            // redeem for more than the collateral that backs it.
            prop_assert!(long as u128 + short as u128 <= amount as u128);
        }

        // LP add-funding rounding favors the pool: shares are floored (entrant
        // never over-credited) and the kept reserve is ceiled / send-back floored
        // (pool keeps at least its fair share). Reserves stay within the trade
        // envelope so the u128 products are exercised but never overflow.
        #[test]
        fn prop_lp_add_rounding_favors_pool(
            ry in 1u64..RMAX,
            rn in 1u64..RMAX,
            amount in 1u64..1_000_000_000_000u64,
        ) {
            let w = pool_weight(ry, rn);
            prop_assume!(w > 0);
            let total = w; // the seed-equivalent: total_shares == weight at seed.
            if let Some(minted) = lp_shares_minted(amount, total, w) {
                // Shares minted are floored: minted * w <= amount * total.
                prop_assert!((minted as u128) * (w as u128) <= (amount as u128) * (total as u128));
            }
            for &r in &[ry, rn] {
                let keep = lp_add_keep(amount, r, w).unwrap();
                let sendback = lp_add_sendback(amount, r, w).unwrap();
                // Accounting closes and send-back is non-negative (r <= w).
                prop_assert_eq!(keep + sendback, amount);
                // Pool keeps AT LEAST the exact fair share (ceil): keep*w >= amount*r.
                prop_assert!((keep as u128) * (w as u128) >= (amount as u128) * (r as u128));
            }
        }

        // No value extraction: add `amount`, then immediately remove ALL minted
        // shares. The LP gets back `sendback` outcome tokens (kept at add time)
        // plus the pro-rata slice pulled at remove time. Their TOTAL mergeable
        // value (min of the two sides they can pair into collateral) plus the
        // leftover unmatched single-side tokens can never let them reconstruct
        // more than the `amount` collateral they deposited — concretely, the
        // collateral they can mint by merging full YES+NO sets is <= amount.
        #[test]
        fn prop_lp_add_then_remove_no_profit(
            ry in 1_000u64..RMAX,
            rn in 1_000u64..RMAX,
            amount in 1u64..1_000_000_000u64,
        ) {
            let w = pool_weight(ry, rn);
            prop_assume!(w > 0);
            let total = w;
            let minted = match lp_shares_minted(amount, total, w) {
                Some(m) if m > 0 => m,
                _ => return Ok(()),
            };
            // Tokens kept at add time (the send-back of each side).
            let sb_yes = lp_add_sendback(amount, ry, w).unwrap();
            let sb_no = lp_add_sendback(amount, rn, w).unwrap();
            // Reserves AFTER the add: r + amount - sendback == r + keep.
            let new_ry = ry + amount - sb_yes;
            let new_rn = rn + amount - sb_no;
            let new_total = total + minted;
            // Tokens pulled at remove time (pro-rata slice of the new reserves).
            let pull_yes = lp_slice(new_ry, minted, new_total).unwrap();
            let pull_no = lp_slice(new_rn, minted, new_total).unwrap();
            // The LP now holds these YES and NO tokens; merging full sets yields
            // `min(total_yes, total_no)` collateral. That must not exceed `amount`.
            let total_yes = sb_yes as u128 + pull_yes as u128;
            let total_no = sb_no as u128 + pull_no as u128;
            let mergeable = total_yes.min(total_no);
            prop_assert!(mergeable <= amount as u128,
                "round-trip profit: merged {} > deposited {}", mergeable, amount);
        }

        // Sum of all LPs' pro-rata slices never exceeds the reserve (flooring
        // means leftover dust stays in the pool): for a two-LP split of the share
        // pool, slice(a) + slice(b) <= reserve.
        #[test]
        fn prop_lp_slices_never_over_pool(
            reserve in 0u64..RMAX,
            total in 1u64..RMAX,
            shares_a in 0u64..RMAX,
        ) {
            let a = shares_a.min(total);
            let b = total - a;
            let sa = lp_slice(reserve, a, total).unwrap();
            let sb = lp_slice(reserve, b, total).unwrap();
            prop_assert!(sa as u128 + sb as u128 <= reserve as u128);
        }
    }
}
