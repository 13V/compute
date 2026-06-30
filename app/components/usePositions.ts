// Portfolio data hook. Scans every market for the connected wallet's outcome-
// token balances + LP position, then marks each holding to market and works out
// what (if anything) is claimable. Optional cost basis is read from a local
// `compute:fills` ledger so we can show unrealized P&L when it exists.
import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";

import { useReadClient } from "./useComputeClient";
import type { MarketAccount, MarketEntry } from "./types";
import { isScalar } from "./market";
import { marketProbs } from "./preview";
import { scalarPayout } from "../lib/amm";
import {
  OUTCOME_YES,
  OUTCOME_NO,
  STATE_OPEN,
  STATE_RESOLVING,
  STATE_RESOLVED,
  STATE_VOID,
  DECIMALS,
  marketPda,
} from "../lib/pdas";

const ZERO = new BN(0);
/** Base units per whole token / dollar (1e6). */
const ONE = new BN(10).pow(new BN(DECIMALS));
/** Half a dollar in base units (void refund per token). */
const HALF = ONE.divn(2);

export const FILLS_KEY = "compute:fills";

/** A single recorded fill in the local cost-basis ledger. */
export interface Fill {
  /** Market PDA (base58). */
  market: string;
  side: typeof OUTCOME_YES | typeof OUTCOME_NO;
  /** Collateral paid, base units (string). */
  cost: string;
  /** Outcome tokens received, base units (string). */
  tokens: string;
  ts: number;
}

export interface Holding {
  entry: MarketEntry;
  /** YES (LONG) outcome tokens held, base units. */
  yesTokens: BN;
  /** NO (SHORT) outcome tokens held, base units. */
  noTokens: BN;
  /** LP shares held in this market, base units. */
  lpShares: BN;
  /** Mark-to-market value of the outcome tokens, USDC base units. */
  value: BN;
  /** True if any outcome tokens OR LP shares can be claimed right now. */
  claimable: boolean;
  /** Outcome tokens that are claimable (winning / settled / void), base units. */
  claimableTokens: BN;
  /** True once LP shares can be claimed (RESOLVED or VOID). */
  lpClaimable: boolean;
  /** Cost basis from the local ledger, or null if none recorded. */
  basis: BN | null;
  /** value − basis, or null when basis is unknown. */
  unrealizedPnl: BN | null;
}

export interface PortfolioSummary {
  /** Sum of every holding's mark-to-market value, base units. */
  totalValue: BN;
  /** Holdings in OPEN or RESOLVING markets (still live). */
  openCount: number;
  /** Holdings with something to claim right now. */
  claimableCount: number;
}

export interface UsePositionsResult {
  holdings: Holding[];
  summary: PortfolioSummary;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  connected: boolean;
}

/** Re-derive the market PDA from a decoded account (needed for LP lookup). */
function marketAddr(m: MarketAccount): PublicKey {
  return marketPda(m.marketId)[0];
}

/** Multiply token base units by a 0..1 probability, flooring (never overstate). */
function valueAtPrice(tokens: BN, price: number): BN {
  if (tokens.lten(0) || !Number.isFinite(price) || price <= 0) return ZERO;
  // price is a 0..1 float; scale to micro-units to stay in integer math.
  const micro = Math.max(0, Math.min(1_000_000, Math.round(price * 1_000_000)));
  return tokens.muln(micro).divn(1_000_000);
}

/** Load + parse the local cost-basis ledger; tolerant of malformed data. */
function loadFills(): Fill[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(FILLS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f) =>
        f &&
        typeof f.market === "string" &&
        (f.side === OUTCOME_YES || f.side === OUTCOME_NO) &&
        typeof f.cost === "string"
    ) as Fill[];
  } catch {
    return [];
  }
}

/** Sum the recorded cost (base units) for one market's fills, or null if none. */
function basisFor(fills: Fill[], marketKey: string): BN | null {
  let total = ZERO;
  let found = false;
  for (const f of fills) {
    if (f.market !== marketKey) continue;
    let c: BN;
    try {
      c = new BN(f.cost);
    } catch {
      continue;
    }
    if (c.isNeg()) continue;
    total = total.add(c);
    found = true;
  }
  return found ? total : null;
}

/**
 * Compute a holding's mark-to-market value + claimable amounts from the market
 * state and the held YES/NO balances. Pure; safe against zero balances.
 */
function deriveHolding(
  m: MarketAccount,
  yesTokens: BN,
  noTokens: BN
): { value: BN; claimableTokens: BN } {
  const state = m.state;
  const scalar = isScalar(m);

  if (state === STATE_OPEN || state === STATE_RESOLVING) {
    const probs = marketProbs(m);
    const value = valueAtPrice(yesTokens, probs.yes).add(
      valueAtPrice(noTokens, probs.no)
    );
    return { value, claimableTokens: ZERO };
  }

  if (state === STATE_VOID) {
    // Both sides refund 50% of collateral per token.
    const value = yesTokens.add(noTokens).mul(HALF).div(ONE);
    return { value, claimableTokens: yesTokens.add(noTokens) };
  }

  if (state === STATE_RESOLVED) {
    if (scalar) {
      // LONG (YES) pays fraction·$1, SHORT (NO) pays (1−fraction)·$1.
      const fracMicro = new BN(m.settlementFraction || 0);
      const longVal = scalarPayout(yesTokens, fracMicro, true);
      const shortVal = scalarPayout(noTokens, fracMicro, false);
      // Both sides hold residual value at settlement, so both are redeemable.
      return {
        value: longVal.add(shortVal),
        claimableTokens: yesTokens.add(noTokens),
      };
    }
    // Binary: winning side worth $1/token, losing side $0.
    const winning = m.outcome === OUTCOME_YES ? OUTCOME_YES : OUTCOME_NO;
    const winTokens = winning === OUTCOME_YES ? yesTokens : noTokens;
    return { value: winTokens.mul(ONE).div(ONE), claimableTokens: winTokens };
  }

  return { value: ZERO, claimableTokens: ZERO };
}

export function usePositions(): UsePositionsResult {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const readClient = useReadClient();

  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const owner = publicKey ?? null;

  const refresh = useCallback(async () => {
    if (!owner) {
      setHoldings([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const markets = (await readClient.listMarkets()) as unknown as MarketEntry[];
      const fills = loadFills();

      // Read a token-account balance as a BN; missing account => 0.
      const readBalance = async (mint: PublicKey): Promise<BN> => {
        try {
          const ata = getAssociatedTokenAddressSync(mint, owner);
          const res = await connection.getTokenAccountBalance(ata);
          return new BN(res.value.amount);
        } catch {
          return ZERO;
        }
      };

      const built = await Promise.all(
        markets.map(async (entry): Promise<Holding | null> => {
          const m = entry.account;
          const [yesTokens, noTokens, lpPos] = await Promise.all([
            readBalance(m.yesMint),
            readBalance(m.noMint),
            readClient.fetchLiquidityPosition(marketAddr(m), owner),
          ]);
          const lpShares: BN = lpPos?.shares ?? ZERO;

          // Skip markets the user has no exposure to at all.
          if (yesTokens.lten(0) && noTokens.lten(0) && lpShares.lten(0)) {
            return null;
          }

          const { value, claimableTokens } = deriveHolding(m, yesTokens, noTokens);
          const settled = m.state === STATE_RESOLVED || m.state === STATE_VOID;
          const lpClaimable = settled && lpShares.gtn(0);
          const claimable = claimableTokens.gtn(0) || lpClaimable;

          const marketKey = entry.publicKey.toBase58();
          const basis = basisFor(fills, marketKey);
          const unrealizedPnl = basis !== null ? value.sub(basis) : null;

          return {
            entry,
            yesTokens,
            noTokens,
            lpShares,
            value,
            claimable,
            claimableTokens,
            lpClaimable,
            basis,
            unrealizedPnl,
          };
        })
      );

      const filtered = built.filter((h): h is Holding => h !== null);
      // Most valuable first; ties broken by newest market id.
      filtered.sort((a, b) => {
        const cmp = b.value.cmp(a.value);
        if (cmp !== 0) return cmp;
        return b.entry.account.marketId.cmp(a.entry.account.marketId);
      });
      setHoldings(filtered);
    } catch (e: any) {
      setError(readClient.parseError(e));
      setHoldings([]);
    } finally {
      setLoading(false);
    }
  }, [owner, connection, readClient]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const summary: PortfolioSummary = holdings.reduce(
    (acc, h) => {
      acc.totalValue = acc.totalValue.add(h.value);
      const st = h.entry.account.state;
      if (st === STATE_OPEN || st === STATE_RESOLVING) acc.openCount += 1;
      if (h.claimable) acc.claimableCount += 1;
      return acc;
    },
    { totalValue: new BN(0), openCount: 0, claimableCount: 0 } as PortfolioSummary
  );

  return {
    holdings,
    summary,
    loading,
    error,
    refresh,
    connected: owner !== null,
  };
}
