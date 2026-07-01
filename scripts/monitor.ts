/**
 * Production invariant monitor. Continuously (or once) verifies the on-chain
 * solvency invariant for every market:
 *
 *     vault_balance == market.collateral + market.fee_accrued
 *
 * plus, for optimistic markets, that the bond vault covers the recorded bond
 * escrow. This is the runtime analogue of the conservation property the program
 * enforces and the unit/integration tests assert. Any drift is a red alert —
 * it means value has leaked or the books disagree with the vault, and the market
 * should be paused (`set_paused`) and investigated immediately.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   npx ts-node scripts/monitor.ts            # single pass, exit non-zero on drift
 *   WATCH=1 INTERVAL=30 npx ts-node scripts/monitor.ts   # loop every 30s
 *
 * Exit code is non-zero when any invariant is violated, so it slots into cron /
 * a healthcheck / an alerting wrapper.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { ComputeClient, STATE_RESOLVING } from "../sdk/client";
import { vaultPda, bondVaultPda } from "../sdk/pdas";

const RPC = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const WATCH = process.env.WATCH === "1";
const INTERVAL = Math.max(5, Number(process.env.INTERVAL || "30")) * 1000;

// A read-only wallet is enough for account fetches.
function readOnlyClient(connection: Connection): ComputeClient {
  const dummy = Keypair.generate();
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(dummy),
    { commitment: "confirmed" }
  );
  return new ComputeClient(provider);
}

async function tokenBalance(connection: Connection, ata: PublicKey): Promise<bigint> {
  try {
    const acct = await getAccount(connection, ata, "confirmed");
    return acct.amount;
  } catch {
    // Missing account reads as zero balance.
    return 0n;
  }
}

interface Violation {
  market: string;
  id: string;
  kind: string;
  detail: string;
}

async function runPass(
  connection: Connection,
  client: ComputeClient
): Promise<{ violations: Violation[]; count: number }> {
  const markets = (await client.listMarkets()) as any[];
  const violations: Violation[] = [];
  const programId = client.programId;

  for (const m of markets) {
    const a = m.account;
    const marketPk: PublicKey = m.publicKey;
    const id = a.marketId.toString();

    // ---- main solvency invariant: vault == collateral + fee_accrued ----
    const [vault] = vaultPda(marketPk, programId);
    const vaultBal = await tokenBalance(connection, vault);
    const expected = BigInt(a.collateral.toString()) + BigInt(a.feeAccrued.toString());
    if (vaultBal !== expected) {
      violations.push({
        market: marketPk.toBase58(),
        id,
        kind: "SOLVENCY",
        detail: `vault ${vaultBal} != collateral ${a.collateral} + fee ${a.feeAccrued} (= ${expected}); drift ${vaultBal - expected}`,
      });
    }

    // ---- optimistic bond escrow: bond vault must cover the recorded bond ----
    // While RESOLVING with a live assertion, the bond vault holds bond (undisputed)
    // or 2*bond (disputed). It must never hold LESS than the recorded escrow.
    const bond = BigInt(a.bond.toString());
    if (bond > 0n && a.state === STATE_RESOLVING) {
      const [bondVault] = bondVaultPda(marketPk, programId);
      const bondBal = await tokenBalance(connection, bondVault);
      const minExpected = a.disputed ? bond * 2n : bond;
      if (bondBal < minExpected) {
        violations.push({
          market: marketPk.toBase58(),
          id,
          kind: "BOND",
          detail: `bond vault ${bondBal} < expected ${minExpected} (bond ${bond}, disputed ${a.disputed})`,
        });
      }
    }
  }

  return { violations, count: markets.length };
}

async function once(connection: Connection, client: ComputeClient): Promise<number> {
  const started = new Date().toISOString();
  const { violations, count } = await runPass(connection, client);
  if (violations.length === 0) {
    console.log(`[${started}] OK — ${count} markets, all invariants hold.`);
    return 0;
  }
  console.error(`[${started}] ALERT — ${violations.length} violation(s) across ${count} markets:`);
  for (const v of violations) {
    console.error(`  #${v.id} ${v.kind}  ${v.market}\n     ${v.detail}`);
  }
  return 1;
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const client = readOnlyClient(connection);
  console.log(`monitor  rpc=${RPC}  program=${client.programId.toBase58()}  watch=${WATCH}`);

  if (!WATCH) {
    process.exit(await once(connection, client));
  }
  // Watch mode: loop forever; track worst status but keep running.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await once(connection, client);
    } catch (e: any) {
      console.error(`[${new Date().toISOString()}] monitor error: ${e?.message ?? e}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
