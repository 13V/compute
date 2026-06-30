// Pure trade-preview math (no React). Mirrors the on-chain FPMM so the trade
// panel can show shares out, average price, price impact, fees, the resulting
// probability, and a plain-English payoff before the user signs.
import BN from "bn.js";
import {
  quoteBuy,
  quoteSell,
  feeAmount,
  marginalPrice,
} from "../lib/amm";
import { OUTCOME_YES } from "../lib/pdas";
import type { MarketAccount } from "./types";
import type { Side } from "./market";
import { isScalar } from "./market";

const toNum = (b: BN, dec = 6) => b.toNumber() / 10 ** dec;

export interface BuyPreview {
  ok: boolean;
  reason?: string;
  /** Outcome tokens received. */
  tokensOut: BN;
  /** Average price paid per token (collateral incl. fee / tokens), 0..~1. */
  avgPrice: number;
  /** Taker fee paid (collateral base units). */
  fee: BN;
  /** This side's marginal probability before and after the trade. */
  probBefore: number;
  probAfter: number;
  /** Absolute move in this side's probability (0..1). */
  priceImpact: number;
  /** Max payout if this side wins (binary: tokens·$1; scalar: tokens·$1 at the bound). */
  maxPayout: BN;
  /** Profit at max payout (maxPayout − amountIn). */
  maxProfit: BN;
  /** Return multiple at max payout (e.g. 1.85 = +85%). */
  maxReturn: number;
}

/**
 * Preview a BUY of `side` for `amountIn` gross collateral (base units) at the
 * given taker fee. `amountIn` is what leaves the user's wallet.
 */
export function previewBuy(
  m: MarketAccount,
  side: Side,
  amountIn: BN,
  feeBps: number
): BuyPreview {
  const yes = side === OUTCOME_YES;
  const [rb, ro] = yes ? [m.reserveYes, m.reserveNo] : [m.reserveNo, m.reserveYes];
  const probBefore = marginalPrice(rb, ro);
  const empty: BuyPreview = {
    ok: false,
    tokensOut: new BN(0),
    avgPrice: 0,
    fee: new BN(0),
    probBefore,
    probAfter: probBefore,
    priceImpact: 0,
    maxPayout: new BN(0),
    maxProfit: new BN(0),
    maxReturn: 0,
  };
  if (amountIn.lten(0)) return empty;

  const fee = feeAmount(amountIn, feeBps);
  const net = amountIn.sub(fee);
  if (net.lten(0)) return { ...empty, reason: "amount below fee" };

  const q = quoteBuy(rb, ro, net);
  if (q.tokensOut.lten(0)) return { ...empty, fee, reason: "amount too small" };

  // After the buy, this side's reserve = newReserveBought, other = newReserveOther.
  const probAfter = marginalPrice(q.newReserveBought, q.newReserveOther);
  const avgPrice = toNum(amountIn) / toNum(q.tokensOut);
  // Binary: each winning token redeems $1. Scalar: a LONG/SHORT token pays at
  // most $1 (at the favorable bound), so tokensOut is the max payout either way.
  const maxPayout = q.tokensOut;
  const maxProfit = maxPayout.sub(amountIn);
  const maxReturn = toNum(amountIn) > 0 ? toNum(maxPayout) / toNum(amountIn) : 0;

  return {
    ok: true,
    tokensOut: q.tokensOut,
    avgPrice,
    fee,
    probBefore,
    probAfter,
    priceImpact: Math.abs(probAfter - probBefore),
    maxPayout,
    maxProfit,
    maxReturn,
  };
}

export interface SellPreview {
  ok: boolean;
  reason?: string;
  /** Outcome tokens the user must give up to withdraw `amountOut` gross. */
  tokensIn: BN;
  /** Collateral the user receives net of fee. */
  netOut: BN;
  fee: BN;
  avgPrice: number;
  probBefore: number;
  probAfter: number;
  priceImpact: number;
}

/**
 * Preview a SELL of `side` to withdraw `amountOut` gross collateral (base units).
 * The taker fee is deducted from the withdrawal.
 */
export function previewSell(
  m: MarketAccount,
  side: Side,
  amountOut: BN,
  feeBps: number
): SellPreview {
  const yes = side === OUTCOME_YES;
  const [rs, ro] = yes ? [m.reserveYes, m.reserveNo] : [m.reserveNo, m.reserveYes];
  const probBefore = marginalPrice(rs, ro);
  const empty: SellPreview = {
    ok: false,
    tokensIn: new BN(0),
    netOut: new BN(0),
    fee: new BN(0),
    avgPrice: 0,
    probBefore,
    probAfter: probBefore,
    priceImpact: 0,
  };
  if (amountOut.lten(0)) return empty;

  const q = quoteSell(rs, ro, amountOut);
  if (!q) return { ...empty, reason: "amount exceeds pool depth" };
  if (q.tokensIn.lten(0)) return { ...empty, reason: "amount too small" };

  const fee = feeAmount(amountOut, feeBps);
  const netOut = amountOut.sub(fee);
  const probAfter = marginalPrice(q.newReserveSold, q.newReserveOther);
  const avgPrice = toNum(q.tokensIn) > 0 ? toNum(amountOut) / toNum(q.tokensIn) : 0;

  return {
    ok: true,
    tokensIn: q.tokensIn,
    netOut,
    fee,
    avgPrice,
    probBefore,
    probAfter,
    priceImpact: Math.abs(probAfter - probBefore),
  };
}

/** Convenience: both sides' current marginal probabilities. */
export function marketProbs(m: MarketAccount): { yes: number; no: number } {
  return {
    yes: marginalPrice(m.reserveYes, m.reserveNo),
    no: marginalPrice(m.reserveNo, m.reserveYes),
  };
}

export { isScalar };
