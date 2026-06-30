// Reconstruct a market's price history from on-chain TradeExecuted events.
// The event carries (is_buy, outcome, collateral, tokens) per trade, so the
// average execution price = collateral/tokens maps to a YES-probability point.
// Works on any RPC (no archival node needed) by reading recent signatures.
import { EventParser } from "@coral-xyz/anchor";
import type { Program } from "@coral-xyz/anchor";
import { PublicKey, Connection } from "@solana/web3.js";
import { OUTCOME_YES } from "../lib/pdas";

export interface PricePoint {
  /** Unix seconds. */
  time: number;
  /** YES probability in (0, 1). */
  price: number;
}

const clamp01 = (x: number) => Math.min(0.999, Math.max(0.001, x));

/**
 * Fetch up to `limit` recent transactions touching `market`, parse their
 * TradeExecuted events, and return YES-price points sorted oldest→newest.
 */
export async function fetchPriceHistory(
  program: Program<any>,
  market: PublicKey,
  limit = 200
): Promise<PricePoint[]> {
  const connection: Connection = program.provider.connection;
  const sigs = await connection.getSignaturesForAddress(market, { limit });
  if (sigs.length === 0) return [];

  // Oldest first so the series reads left→right in time.
  const ordered = [...sigs].reverse();
  const parser = new EventParser(program.programId, program.coder);
  const marketStr = market.toBase58();
  const points: PricePoint[] = [];

  // Fetch transactions in modest batches to keep RPC happy.
  const BATCH = 25;
  for (let i = 0; i < ordered.length; i += BATCH) {
    const slice = ordered.slice(i, i + BATCH);
    const txs = await Promise.all(
      slice.map((s) =>
        connection
          .getTransaction(s.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          })
          .catch(() => null)
      )
    );
    txs.forEach((tx, j) => {
      const logs = tx?.meta?.logMessages;
      const blockTime = tx?.blockTime ?? slice[j].blockTime ?? null;
      if (!logs || blockTime == null) return;
      let parsed;
      try {
        parsed = parser.parseLogs(logs);
      } catch {
        return;
      }
      for (const ev of parsed) {
        if (ev.name !== "TradeExecuted" && ev.name !== "tradeExecuted") continue;
        const d: any = ev.data;
        if (d.market?.toBase58?.() !== marketStr) continue;
        const collateral = Number(d.collateral?.toString?.() ?? d.collateral);
        const tokens = Number(d.tokens?.toString?.() ?? d.tokens);
        if (!tokens) continue;
        const sidePrice = collateral / tokens; // collateral per outcome token
        const isYes = Number(d.outcome) === OUTCOME_YES;
        const yesPrice = clamp01(isYes ? sidePrice : 1 - sidePrice);
        points.push({ time: blockTime, price: yesPrice });
      }
    });
  }

  // Stable sort by time; de-dup identical timestamps keeping the last.
  points.sort((a, b) => a.time - b.time);
  return points;
}
