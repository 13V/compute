// Copied from /sdk — regenerate with anchor build and re-copy if the program changes.
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

/**
 * The on-chain program id. Keep in sync with `declare_id!` in the program and
 * with Anchor.toml.
 */
export const PROGRAM_ID = new PublicKey(
  "8xv1L7757szxo2XPrQL5AERPGZrJaYRKgqB9RgFkQCU2"
);

export const OUTCOME_YES = 0;
export const OUTCOME_NO = 1;

export const STATE_OPEN = 0;
export const STATE_RESOLVING = 1;
export const STATE_RESOLVED = 2;
export const STATE_VOID = 3;

/** Resolver kinds. */
export const RESOLVER_TRUSTED_KEY = 0;
export const RESOLVER_ORACLE_FEED = 1;

/** Market kinds: binary YES/NO vs scalar/range (YES=LONG, NO=SHORT). */
export const MARKET_BINARY = 0;
export const MARKET_SCALAR = 1;

/** Fixed-point scale for scalar settlement fractions (1e6 => 1.0). */
export const PRICE_SCALE = 1_000_000;

/** Oracle comparison codes: YES iff value >= strike (GTE) / value <= strike (LTE). */
export const CMP_GTE = 0;
export const CMP_LTE = 1;

export const VOID_REASON_DISPUTE = 0;
export const VOID_REASON_STALE = 1;

/** USDC and outcome tokens both use 6 decimals. */
export const DECIMALS = 6;

const enc = (s: string) => Buffer.from(s, "utf8");

function le8(n: BN | number | bigint): Buffer {
  return new BN(n.toString()).toArrayLike(Buffer, "le", 8);
}

export function configPda(programId: PublicKey = PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc("config")], programId);
}

export function marketPda(
  marketId: BN | number,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [enc("market"), le8(marketId)],
    programId
  );
}

export function yesMintPda(market: PublicKey, programId: PublicKey = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([enc("yes"), market.toBuffer()], programId);
}

export function noMintPda(market: PublicKey, programId: PublicKey = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([enc("no"), market.toBuffer()], programId);
}

export function vaultPda(market: PublicKey, programId: PublicKey = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([enc("vault"), market.toBuffer()], programId);
}

export function poolYesPda(market: PublicKey, programId: PublicKey = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([enc("pool_yes"), market.toBuffer()], programId);
}

export function poolNoPda(market: PublicKey, programId: PublicKey = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([enc("pool_no"), market.toBuffer()], programId);
}

/** Bundle of every PDA tied to a market id. */
export function deriveMarketAccounts(
  marketId: BN | number,
  programId: PublicKey = PROGRAM_ID
) {
  const [market] = marketPda(marketId, programId);
  const [yesMint] = yesMintPda(market, programId);
  const [noMint] = noMintPda(market, programId);
  const [vault] = vaultPda(market, programId);
  const [poolYes] = poolYesPda(market, programId);
  const [poolNo] = poolNoPda(market, programId);
  return { market, yesMint, noMint, vault, poolYes, poolNo };
}
