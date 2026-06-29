import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Connection,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

import { ComputeMarkets } from "./idl/compute_markets";
import idl from "./idl/compute_markets.json";
import {
  configPda,
  deriveMarketAccounts,
  marketPda,
  OUTCOME_YES,
  OUTCOME_NO,
} from "./pdas";

export * from "./pdas";
export * from "./amm";
export type { ComputeMarkets };

/**
 * High-level client for the Compute Markets program. Wraps the Anchor `Program`
 * and hides PDA/ATA plumbing so the frontend and tests can call a clean API.
 */
export class ComputeClient {
  readonly program: Program<ComputeMarkets>;

  constructor(provider: anchor.Provider) {
    this.program = new Program(idl as ComputeMarkets, provider);
  }

  get programId(): PublicKey {
    return this.program.programId;
  }

  get connection(): Connection {
    return this.program.provider.connection;
  }

  // ----- account fetchers -----

  async fetchConfig() {
    const [config] = configPda(this.programId);
    return this.program.account.config.fetch(config);
  }

  async fetchMarketById(marketId: number | BN) {
    const [market] = marketPda(marketId, this.programId);
    return this.program.account.market.fetch(market);
  }

  async fetchMarket(market: PublicKey) {
    return this.program.account.market.fetch(market);
  }

  async listMarkets() {
    return this.program.account.market.all();
  }

  // ----- instruction builders -----

  async initializeIx(admin: PublicKey, collateralMint: PublicKey, feeBps: number) {
    const [config] = configPda(this.programId);
    return this.program.methods
      .initialize(feeBps)
      .accountsPartial({ config, collateralMint, admin, systemProgram: SystemProgram.programId })
      .instruction();
  }

  async createMarketIx(
    creator: PublicKey,
    marketId: number | BN,
    question: string,
    resolutionSource: string,
    resolutionTime: BN,
    resolver: PublicKey,
    collateralMint: PublicKey
  ) {
    const [config] = configPda(this.programId);
    const a = deriveMarketAccounts(marketId, this.programId);
    return this.program.methods
      .createMarket(question, resolutionSource, resolutionTime, resolver)
      .accountsPartial({
        config,
        market: a.market,
        yesMint: a.yesMint,
        noMint: a.noMint,
        vault: a.vault,
        collateralMint,
        creator,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
  }

  async seedLiquidityIx(lp: PublicKey, marketId: number | BN, amount: BN, collateralMint: PublicKey) {
    const a = deriveMarketAccounts(marketId, this.programId);
    const lpCollateral = getAssociatedTokenAddressSync(collateralMint, lp);
    return this.program.methods
      .seedLiquidity(amount)
      .accountsPartial({
        market: a.market,
        yesMint: a.yesMint,
        noMint: a.noMint,
        vault: a.vault,
        poolYes: a.poolYes,
        poolNo: a.poolNo,
        lpCollateral,
        lp,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
  }

  /** Returns [createAtaIx (idempotent), tradeIx] so the outcome ATA always exists. */
  async buyIxs(
    user: PublicKey,
    marketId: number | BN,
    outcome: number,
    collateralIn: BN,
    minTokensOut: BN,
    collateralMint: PublicKey
  ): Promise<TransactionInstruction[]> {
    const a = deriveMarketAccounts(marketId, this.programId);
    const outMint = outcome === OUTCOME_YES ? a.yesMint : a.noMint;
    const userOutcome = getAssociatedTokenAddressSync(outMint, user);
    const userCollateral = getAssociatedTokenAddressSync(collateralMint, user);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(user, userOutcome, user, outMint);
    const tradeIx = await this.program.methods
      .buy(outcome, collateralIn, minTokensOut)
      .accountsPartial({
        config: configPda(this.programId)[0],
        market: a.market,
        yesMint: a.yesMint,
        noMint: a.noMint,
        poolYes: a.poolYes,
        poolNo: a.poolNo,
        vault: a.vault,
        userOutcome,
        userCollateral,
        user,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    return [ataIx, tradeIx];
  }

  async sellIx(
    user: PublicKey,
    marketId: number | BN,
    outcome: number,
    collateralOut: BN,
    maxTokensIn: BN,
    collateralMint: PublicKey
  ) {
    const a = deriveMarketAccounts(marketId, this.programId);
    const outMint = outcome === OUTCOME_YES ? a.yesMint : a.noMint;
    const userOutcome = getAssociatedTokenAddressSync(outMint, user);
    const userCollateral = getAssociatedTokenAddressSync(collateralMint, user);
    return this.program.methods
      .sell(outcome, collateralOut, maxTokensIn)
      .accountsPartial({
        config: configPda(this.programId)[0],
        market: a.market,
        yesMint: a.yesMint,
        noMint: a.noMint,
        poolYes: a.poolYes,
        poolNo: a.poolNo,
        vault: a.vault,
        userOutcome,
        userCollateral,
        user,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  async resolveIx(resolver: PublicKey, marketId: number | BN, outcome: number) {
    const a = deriveMarketAccounts(marketId, this.programId);
    return this.program.methods
      .resolve(outcome)
      .accountsPartial({ market: a.market, resolver })
      .instruction();
  }

  async redeemIx(
    user: PublicKey,
    marketId: number | BN,
    winningOutcome: number,
    amount: BN,
    collateralMint: PublicKey
  ) {
    const a = deriveMarketAccounts(marketId, this.programId);
    const winningMint = winningOutcome === OUTCOME_YES ? a.yesMint : a.noMint;
    const userOutcome = getAssociatedTokenAddressSync(winningMint, user);
    const userCollateral = getAssociatedTokenAddressSync(collateralMint, user);
    return this.program.methods
      .redeem(amount)
      .accountsPartial({
        market: a.market,
        winningMint,
        vault: a.vault,
        userOutcome,
        userCollateral,
        user,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  async claimPoolIx(lp: PublicKey, marketId: number | BN, winningOutcome: number, collateralMint: PublicKey) {
    const a = deriveMarketAccounts(marketId, this.programId);
    const winningMint = winningOutcome === OUTCOME_YES ? a.yesMint : a.noMint;
    const lpCollateral = getAssociatedTokenAddressSync(collateralMint, lp);
    return this.program.methods
      .claimPool()
      .accountsPartial({
        market: a.market,
        winningMint,
        poolYes: a.poolYes,
        poolNo: a.poolNo,
        vault: a.vault,
        lpCollateral,
        lp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }

  async collectFeesIx(admin: PublicKey, marketId: number | BN, collateralMint: PublicKey) {
    const [config] = configPda(this.programId);
    const a = deriveMarketAccounts(marketId, this.programId);
    const adminCollateral = getAssociatedTokenAddressSync(collateralMint, admin);
    return this.program.methods
      .collectFees()
      .accountsPartial({
        config,
        market: a.market,
        vault: a.vault,
        adminCollateral,
        admin,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
  }
}

export { OUTCOME_YES, OUTCOME_NO };
