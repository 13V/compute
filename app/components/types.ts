import type { PublicKey } from "@solana/web3.js";
import type BN from "bn.js";

/**
 * The decoded `Market` account (camelCase via Anchor). Mirrors the on-chain
 * struct. We type it locally to keep page code clean.
 */
export interface MarketAccount {
  marketId: BN;
  creator: PublicKey;
  resolver: PublicKey;
  resolverKind: number;
  /** MARKET_BINARY (0) or MARKET_SCALAR (1). */
  marketKind: number;
  /** Scalar range bounds (i64). Meaningful only when marketKind === MARKET_SCALAR. */
  lowerBound: BN;
  upperBound: BN;
  /** The trusted-proposed scalar settlement value (i64), pending finalize. */
  proposedValue: BN;
  /** Settled fraction in [0, PRICE_SCALE] (u32) once a scalar market resolves. */
  settlementFraction: number;
  /** Oracle config (resolverKind === RESOLVER_ORACLE_FEED). */
  oracleFeed: PublicKey;
  oracleStrike: BN;
  oracleComparison: number;
  oracleMaxStaleness: BN;
  collateralMint: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  poolYes: PublicKey;
  poolNo: PublicKey;
  reserveYes: BN;
  reserveNo: BN;
  lp: PublicKey;
  totalShares: BN;
  collateral: BN;
  feeAccrued: BN;
  state: number;
  outcome: number;
  proposedOutcome: number;
  /** Optimistic resolver: who posted the assertion + their bond. */
  asserter: PublicKey;
  disputer: PublicKey;
  bond: BN;
  disputed: boolean;
  closeTime: BN;
  resolutionTime: BN;
  resolvedAt: BN;
  question: string;
  resolutionSource: string;
  bump: number;
}

export interface MarketEntry {
  publicKey: PublicKey;
  account: MarketAccount;
}

export interface ConfigAccount {
  admin: PublicKey;
  pendingAdmin: PublicKey;
  guardian: PublicKey;
  collateralMint: PublicKey;
  feeBps: number;
  lpFeeBps: number;
  disputePeriod: BN;
  marketCount: BN;
  paused: boolean;
  bondAmount: BN;
  bump: number;
}

/** A per-provider liquidity position (seeds `["lp", market, owner]`). */
export interface LiquidityPositionAccount {
  market: PublicKey;
  owner: PublicKey;
  shares: BN;
  bump: number;
}

/** A simple oracle price feed account. */
export interface PriceFeedAccount {
  authority: PublicKey;
  value: BN;
  decimals: number;
  publishedAt: BN;
  description: string;
}
