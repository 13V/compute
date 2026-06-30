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
  disputePeriod: BN;
  marketCount: BN;
  paused: boolean;
  bump: number;
}
