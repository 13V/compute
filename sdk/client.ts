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
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

import { ComputeMarkets } from "./idl/compute_markets";
import idl from "./idl/compute_markets.json";
import { configPda, deriveMarketAccounts, marketPda, OUTCOME_YES } from "./pdas";

export * from "./pdas";
export * from "./amm";
export type { ComputeMarkets };

/** Parameters for creating a market. */
export interface CreateMarketParams {
  question: string;
  resolutionSource: string;
  /** Unix seconds: trading halts at this time. Must be <= resolutionTime. */
  closeTime: BN;
  /** Unix seconds: the outcome may be proposed at/after this time. */
  resolutionTime: BN;
  resolver: PublicKey;
  /** Resolver kind; only RESOLVER_TRUSTED_KEY (0) is supported today. */
  resolverKind?: number;
}

/**
 * High-level client for the Compute Markets program. Wraps the Anchor `Program`
 * and hides PDA/ATA plumbing so the frontend and tests can call a clean API.
 *
 * Market ids are assigned sequentially by the program from `config.market_count`;
 * `createMarketIx` derives the next id internally so callers never guess it.
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

  /** The id the next `create_market` will assign. */
  async nextMarketId(): Promise<number> {
    const cfg = await this.fetchConfig();
    return cfg.marketCount.toNumber();
  }

  // ----- setup -----

  async initializeIx(admin: PublicKey, collateralMint: PublicKey, feeBps: number, disputePeriod: BN, guardian: PublicKey) {
    const [config] = configPda(this.programId);
    return this.program.methods
      .initialize(feeBps, disputePeriod, guardian)
      .accountsPartial({ config, collateralMint, admin, systemProgram: SystemProgram.programId })
      .instruction();
  }

  /**
   * Build a `create_market` instruction. Returns the instruction plus the
   * `marketId` it will create (derived from the live `config.market_count`).
   */
  async createMarketIx(
    creator: PublicKey,
    params: CreateMarketParams,
    collateralMint: PublicKey
  ): Promise<{ ix: TransactionInstruction; marketId: number }> {
    const [config] = configPda(this.programId);
    const marketId = await this.nextMarketId();
    const a = deriveMarketAccounts(marketId, this.programId);
    const ix = await this.program.methods
      .createMarket(
        params.question,
        params.resolutionSource,
        params.closeTime,
        params.resolutionTime,
        params.resolver,
        params.resolverKind ?? 0
      )
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
    return { ix, marketId };
  }

  async seedLiquidityIx(lp: PublicKey, marketId: number | BN, amount: BN, collateralMint: PublicKey) {
    const [config] = configPda(this.programId);
    const a = deriveMarketAccounts(marketId, this.programId);
    const lpCollateral = getAssociatedTokenAddressSync(collateralMint, lp);
    return this.program.methods
      .seedLiquidity(amount)
      .accountsPartial({
        config,
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

  // ----- trading -----

  private tradeAccounts(user: PublicKey, marketId: number | BN, outMint: PublicKey, collateralMint: PublicKey) {
    const a = deriveMarketAccounts(marketId, this.programId);
    return {
      config: configPda(this.programId)[0],
      market: a.market,
      yesMint: a.yesMint,
      noMint: a.noMint,
      poolYes: a.poolYes,
      poolNo: a.poolNo,
      vault: a.vault,
      userOutcome: getAssociatedTokenAddressSync(outMint, user),
      userCollateral: getAssociatedTokenAddressSync(collateralMint, user),
      user,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }

  /** Returns [createAtaIx (idempotent), buyIx] so the outcome ATA always exists. */
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
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      user,
      getAssociatedTokenAddressSync(outMint, user),
      user,
      outMint
    );
    const tradeIx = await this.program.methods
      .buy(outcome, collateralIn, minTokensOut)
      .accountsPartial(this.tradeAccounts(user, marketId, outMint, collateralMint))
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
    return this.program.methods
      .sell(outcome, collateralOut, maxTokensIn)
      .accountsPartial(this.tradeAccounts(user, marketId, outMint, collateralMint))
      .instruction();
  }

  // ----- resolution -----

  async proposeOutcomeIx(resolver: PublicKey, marketId: number | BN, outcome: number) {
    const a = deriveMarketAccounts(marketId, this.programId);
    return this.program.methods
      .proposeOutcome(outcome)
      .accountsPartial({ market: a.market, resolver })
      .instruction();
  }

  async finalizeOutcomeIx(cranker: PublicKey, marketId: number | BN) {
    const a = deriveMarketAccounts(marketId, this.programId);
    return this.program.methods
      .finalizeOutcome()
      .accountsPartial({ config: configPda(this.programId)[0], market: a.market, cranker })
      .instruction();
  }

  async disputeVoidIx(guardian: PublicKey, marketId: number | BN) {
    const a = deriveMarketAccounts(marketId, this.programId);
    return this.program.methods
      .disputeVoid()
      .accountsPartial({ config: configPda(this.programId)[0], market: a.market, guardian })
      .instruction();
  }

  async voidStaleIx(cranker: PublicKey, marketId: number | BN) {
    const a = deriveMarketAccounts(marketId, this.programId);
    return this.program.methods
      .voidStale()
      .accountsPartial({ market: a.market, cranker })
      .instruction();
  }

  // ----- redemption -----

  private redeemAccounts(user: PublicKey, marketId: number | BN, mint: PublicKey, collateralMint: PublicKey) {
    const a = deriveMarketAccounts(marketId, this.programId);
    return {
      market: a.market,
      winningMint: mint,
      vault: a.vault,
      userOutcome: getAssociatedTokenAddressSync(mint, user),
      userCollateral: getAssociatedTokenAddressSync(collateralMint, user),
      user,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }

  async redeemIx(user: PublicKey, marketId: number | BN, winningOutcome: number, amount: BN, collateralMint: PublicKey) {
    const a = deriveMarketAccounts(marketId, this.programId);
    const mint = winningOutcome === OUTCOME_YES ? a.yesMint : a.noMint;
    return this.program.methods
      .redeem(amount)
      .accountsPartial(this.redeemAccounts(user, marketId, mint, collateralMint))
      .instruction();
  }

  /** Redeem either side of a voided market for half collateral per token. */
  async redeemVoidIx(user: PublicKey, marketId: number | BN, side: number, amount: BN, collateralMint: PublicKey) {
    const a = deriveMarketAccounts(marketId, this.programId);
    const mint = side === OUTCOME_YES ? a.yesMint : a.noMint;
    return this.program.methods
      .redeemVoid(amount)
      .accountsPartial(this.redeemAccounts(user, marketId, mint, collateralMint))
      .instruction();
  }

  async claimPoolIx(lp: PublicKey, marketId: number | BN, collateralMint: PublicKey) {
    const a = deriveMarketAccounts(marketId, this.programId);
    const lpCollateral = getAssociatedTokenAddressSync(collateralMint, lp);
    return this.program.methods
      .claimPool()
      .accountsPartial({
        market: a.market,
        yesMint: a.yesMint,
        noMint: a.noMint,
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
      .accountsPartial({ config, market: a.market, vault: a.vault, adminCollateral, admin, tokenProgram: TOKEN_PROGRAM_ID })
      .instruction();
  }

  // ----- admin / guardian -----

  async setPausedIx(authority: PublicKey, paused: boolean) {
    return this.program.methods
      .setPaused(paused)
      .accountsPartial({ config: configPda(this.programId)[0], authority })
      .instruction();
  }

  async setFeeBpsIx(admin: PublicKey, feeBps: number) {
    return this.program.methods
      .setFeeBps(feeBps)
      .accountsPartial({ config: configPda(this.programId)[0], admin })
      .instruction();
  }

  async setGuardianIx(admin: PublicKey, guardian: PublicKey) {
    return this.program.methods
      .setGuardian(guardian)
      .accountsPartial({ config: configPda(this.programId)[0], admin })
      .instruction();
  }

  async setAdminIx(admin: PublicKey, newAdmin: PublicKey) {
    return this.program.methods
      .setAdmin(newAdmin)
      .accountsPartial({ config: configPda(this.programId)[0], admin })
      .instruction();
  }

  async acceptAdminIx(pendingAdmin: PublicKey) {
    return this.program.methods
      .acceptAdmin()
      .accountsPartial({ config: configPda(this.programId)[0], pendingAdmin })
      .instruction();
  }

  /** Decode an Anchor program error into a readable message, if possible. */
  parseError(err: unknown): string {
    const anchorErr = anchor.AnchorError.parse((err as any)?.logs ?? []);
    if (anchorErr) return `${anchorErr.error.errorCode.code}: ${anchorErr.error.errorMessage}`;
    return (err as any)?.message ?? String(err);
  }
}
