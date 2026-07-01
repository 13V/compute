// Production transaction reliability: prepend a compute-unit LIMIT (sized by
// simulation) and a compute-unit PRICE (a priority fee estimated from recent
// network conditions) to every transaction. Without these, transactions are sent
// at base priority with a default 200k CU cap and are dropped under congestion.
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

// Absolute CU ceiling the runtime allows per transaction.
const MAX_CU = 1_400_000;
// Fallback CU limit if simulation is unavailable.
const FALLBACK_CU = 400_000;
// Priority-fee bounds (micro-lamports per CU).
const MIN_FEE = Number(process.env.NEXT_PUBLIC_MIN_PRIORITY_FEE ?? "10000");
const MAX_FEE = Number(process.env.NEXT_PUBLIC_MAX_PRIORITY_FEE ?? "1000000");
const DEFAULT_FEE = Number(process.env.NEXT_PUBLIC_PRIORITY_FEE ?? "50000");

/**
 * Estimate a priority fee (micro-lamports per CU) from recent prioritization
 * fees on the accounts this tx will write, taking the ~75th percentile of
 * non-zero samples and clamping to [MIN_FEE, MAX_FEE]. Falls back to a default.
 */
export async function estimatePriorityFee(
  connection: Connection,
  writableKeys: PublicKey[]
): Promise<number> {
  try {
    const fees = await connection.getRecentPrioritizationFees({
      // The RPC caps this list; the most-contended writable accounts matter most.
      lockedWritableAccounts: writableKeys.slice(0, 128),
    });
    const nonzero = fees
      .map((f) => f.prioritizationFee)
      .filter((x) => x > 0)
      .sort((a, b) => a - b);
    if (nonzero.length === 0) return clampFee(DEFAULT_FEE);
    const p75 = nonzero[Math.min(nonzero.length - 1, Math.floor(nonzero.length * 0.75))];
    return clampFee(p75);
  } catch {
    return clampFee(DEFAULT_FEE);
  }
}

function clampFee(f: number): number {
  if (!Number.isFinite(f) || f <= 0) return DEFAULT_FEE;
  return Math.min(MAX_FEE, Math.max(MIN_FEE, Math.floor(f)));
}

/**
 * Build the two ComputeBudget instructions to prepend to `ixs`:
 *   1. setComputeUnitLimit — sized from a simulation (unitsConsumed + 20%),
 *      falling back to FALLBACK_CU.
 *   2. setComputeUnitPrice — the estimated priority fee.
 * Both estimation paths are best-effort and never throw.
 */
export async function computeBudgetIxs(
  connection: Connection,
  payer: PublicKey,
  ixs: TransactionInstruction[]
): Promise<TransactionInstruction[]> {
  const writableKeys = ixs.flatMap((ix) =>
    ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey)
  );

  // Estimate the fee and the CU usage concurrently.
  const [micro, units] = await Promise.all([
    estimatePriorityFee(connection, writableKeys),
    simulateUnits(connection, payer, ixs),
  ]);

  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }),
  ];
}

/** Simulate to size the CU limit; returns FALLBACK_CU on any failure. */
async function simulateUnits(
  connection: Connection,
  payer: PublicKey,
  ixs: TransactionInstruction[]
): Promise<number> {
  try {
    const sim = new Transaction().add(
      // A high limit during simulation so we measure true consumption.
      ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }),
      ...ixs
    );
    sim.feePayer = payer;
    sim.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    const res = await connection.simulateTransaction(sim);
    const used = res.value.unitsConsumed;
    if (res.value.err || !used) return FALLBACK_CU;
    return Math.min(MAX_CU, Math.ceil(used * 1.2));
  } catch {
    return FALLBACK_CU;
  }
}
