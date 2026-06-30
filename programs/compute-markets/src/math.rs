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
    }
}
