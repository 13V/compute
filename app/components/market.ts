// Display helpers for market kinds, resolver kinds, and scalar math.
// Not part of the copied SDK.
import BN from "bn.js";
import {
  MARKET_BINARY,
  MARKET_SCALAR,
  RESOLVER_TRUSTED_KEY,
  RESOLVER_ORACLE_FEED,
  RESOLVER_OPTIMISTIC,
  CMP_GTE,
  CMP_LTE,
  PRICE_SCALE,
  OUTCOME_YES,
  OUTCOME_NO,
} from "../lib/pdas";
import { scalarFraction } from "../lib/amm";
import type { MarketAccount } from "./types";

export type Side = typeof OUTCOME_YES | typeof OUTCOME_NO;

export function isScalar(m: { marketKind: number }): boolean {
  return m.marketKind === MARKET_SCALAR;
}

/** Human label for a market kind. */
export function marketKindLabel(kind: number): string {
  switch (kind) {
    case MARKET_BINARY:
      return "Binary";
    case MARKET_SCALAR:
      return "Scalar";
    default:
      return "Unknown";
  }
}

/** Human label for a resolver kind. */
export function resolverKindLabel(kind: number): string {
  switch (kind) {
    case RESOLVER_TRUSTED_KEY:
      return "Trusted";
    case RESOLVER_ORACLE_FEED:
      return "Oracle feed";
    case RESOLVER_OPTIMISTIC:
      return "Optimistic";
    default:
      return "Unknown";
  }
}

/** A short CSS-friendly class suffix for a resolver-kind badge. */
export function resolverKindClass(kind: number): string {
  switch (kind) {
    case RESOLVER_TRUSTED_KEY:
      return "trusted";
    case RESOLVER_ORACLE_FEED:
      return "oracle";
    case RESOLVER_OPTIMISTIC:
      return "optimistic";
    default:
      return "";
  }
}

/** YES→LONG / NO→SHORT for scalar markets; YES/NO for binary. */
export function outcomeLabel(side: Side, scalar: boolean): string {
  if (scalar) return side === OUTCOME_YES ? "LONG" : "SHORT";
  return side === OUTCOME_YES ? "YES" : "NO";
}

export function comparisonLabel(cmp: number): string {
  if (cmp === CMP_GTE) return "≥ (GTE)";
  if (cmp === CMP_LTE) return "≤ (LTE)";
  return "?";
}

/**
 * The implied settled value for a scalar market given the YES (LONG) marginal
 * price: value = lower + price·(upper − lower). Returns a float in [lower, upper].
 */
export function impliedScalarValue(
  longPrice: number,
  lowerBound: BN,
  upperBound: BN
): number {
  const lo = lowerBound.toNumber();
  const hi = upperBound.toNumber();
  return lo + longPrice * (hi - lo);
}

/**
 * The settled LONG fraction (0..1) once a scalar market is resolved, derived
 * from the on-chain `settlementFraction` (u32 micro-units), or null if not set.
 */
export function settledLongFraction(m: MarketAccount): number | null {
  if (!isScalar(m)) return null;
  return m.settlementFraction / PRICE_SCALE;
}

/** The settled scalar value (lower + fraction·range) for a resolved scalar market. */
export function settledScalarValue(m: MarketAccount): number | null {
  const frac = settledLongFraction(m);
  if (frac == null) return null;
  return m.lowerBound.toNumber() + frac * (m.upperBound.toNumber() - m.lowerBound.toNumber());
}

/**
 * The LONG fraction implied by a candidate scalar settlement value, as a 0..1
 * float, or null if the range is invalid. Mirrors `scalarFraction`.
 */
export function fractionForValue(value: BN, lower: BN, upper: BN): number | null {
  const f = scalarFraction(value, lower, upper);
  if (f == null) return null;
  return f.toNumber() / PRICE_SCALE;
}
