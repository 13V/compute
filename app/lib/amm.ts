// Copied from /sdk — regenerate with anchor build and re-copy if the program changes.
import BN from "bn.js";

/**
 * Client-side mirror of the on-chain FPMM math (`programs/.../math.rs`). Used to
 * preview trades and compute slippage bounds. Rounding matches the program:
 * the pool's retained reserve is rounded UP so the trader never receives more
 * than the chain will grant.
 *
 * All amounts are base units (BN). Outcome tokens and collateral use 6 decimals.
 */

function ceilDiv(a: BN, b: BN): BN {
  return a.add(b).subn(1).div(b);
}

export interface BuyQuote {
  tokensOut: BN;
  newReserveBought: BN;
  newReserveOther: BN;
}

export interface SellQuote {
  tokensIn: BN;
  newReserveSold: BN;
  newReserveOther: BN;
}

/** Quote buying the `bought` side by investing `a` collateral (net of fee). */
export function quoteBuy(reserveBought: BN, reserveOther: BN, a: BN): BuyQuote {
  if (a.isZero()) {
    return { tokensOut: new BN(0), newReserveBought: reserveBought, newReserveOther: reserveOther };
  }
  const k = reserveBought.mul(reserveOther);
  const denom = reserveOther.add(a);
  const keep = ceilDiv(k, denom);
  const newBought = keep;
  const newOther = reserveOther.add(a);
  const tokensOut = reserveBought.add(a).sub(keep);
  return { tokensOut, newReserveBought: newBought, newReserveOther: newOther };
}

/** Quote selling the `sold` side to withdraw `a` collateral (gross of fee). */
export function quoteSell(reserveSold: BN, reserveOther: BN, a: BN): SellQuote | null {
  if (a.isZero()) {
    return { tokensIn: new BN(0), newReserveSold: reserveSold, newReserveOther: reserveOther };
  }
  if (a.gte(reserveOther)) return null;
  const k = reserveSold.mul(reserveOther);
  const denom = reserveOther.sub(a);
  const need = ceilDiv(k, denom);
  const newOther = reserveOther.sub(a);
  const tokensIn = need.add(a).sub(reserveSold);
  return { tokensIn, newReserveSold: need, newReserveOther: newOther };
}

/** Fee for `amount` at `feeBps`, rounded down. */
export function feeAmount(amount: BN, feeBps: number): BN {
  return amount.muln(feeBps).divn(10_000);
}

/**
 * Marginal price (probability, 0..1) of the outcome whose reserve is
 * `reserveSelf`: price = reserveOther / (reserveSelf + reserveOther).
 */
export function marginalPrice(reserveSelf: BN, reserveOther: BN): number {
  const total = reserveSelf.add(reserveOther);
  if (total.isZero()) return 0;
  return reserveOther.muln(1_000_000).div(total).toNumber() / 1_000_000;
}

/** Apply a slippage tolerance (e.g. 0.01 = 1%) to a min-out amount. */
export function minOutWithSlippage(tokensOut: BN, slippage: number): BN {
  const bps = Math.max(0, Math.floor((1 - slippage) * 10_000));
  return tokensOut.muln(bps).divn(10_000);
}

/** Apply a slippage tolerance to a max-in amount. */
export function maxInWithSlippage(tokensIn: BN, slippage: number): BN {
  const bps = Math.floor((1 + slippage) * 10_000);
  return tokensIn.muln(bps).divn(10_000);
}
