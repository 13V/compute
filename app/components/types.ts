import type { PublicKey } from "@solana/web3.js";
import type BN from "bn.js";

/**
 * The decoded `Market` account (camelCase via Anchor). Mirrors the on-chain
 * struct documented in the task. We type it locally to keep page code clean.
 */
export interface MarketAccount {
  marketId: BN;
  creator: PublicKey;
  resolver: PublicKey;
  collateralMint: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  poolYes: PublicKey;
  poolNo: PublicKey;
  reserveYes: BN;
  reserveNo: BN;
  lp: PublicKey;
  lpShares: BN;
  collateral: BN;
  feeAccrued: BN;
  state: number;
  outcome: number;
  resolutionTime: BN;
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
  collateralMint: PublicKey;
  feeBps: number;
  marketCount: BN;
  bump: number;
}
