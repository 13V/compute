/**
 * Seed a Compute deployment with demo data — one market of every kind, seeded
 * with liquidity, plus a published oracle feed and a sample trade. Works against
 * any cluster (local validator or devnet) via ANCHOR_PROVIDER_URL.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
 *   ADMIN_KEYPAIR=~/.config/solana/id.json \
 *   npx ts-node scripts/seed-demo.ts
 *
 * Optional env:
 *   DEMO_WALLETS=pubkey1,pubkey2   # mint demo USDC to these wallets so they can trade
 *   USDC_MINT=<existing mint>      # reuse an existing collateral mint instead of creating one
 *
 * Requires the program already deployed at its declare_id and the admin keypair
 * funded on the target cluster.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as os from "os";
import {
  Keypair,
  PublicKey,
  Connection,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

import {
  ComputeClient,
  OUTCOME_YES,
  OUTCOME_NO,
  MARKET_BINARY,
  MARKET_SCALAR,
  RESOLVER_TRUSTED_KEY,
  RESOLVER_ORACLE_FEED,
  RESOLVER_OPTIMISTIC,
  CMP_GTE,
} from "../sdk/client";

const RPC = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const USDC = (n: number) => new BN(Math.round(n * 1_000_000));
const nowSec = () => Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

function loadAdmin(): Keypair {
  const path = (process.env.ADMIN_KEYPAIR || "~/.config/solana/id.json").replace("~", os.homedir());
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const admin = loadAdmin();
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
  const client = new ComputeClient(provider);

  const bal = await connection.getBalance(admin.publicKey);
  console.log(`RPC               ${RPC}`);
  console.log(`Program           ${client.programId.toBase58()}`);
  console.log(`Admin / payer     ${admin.publicKey.toBase58()}  (${(bal / 1e9).toFixed(3)} SOL)`);
  if (bal < 0.2e9) throw new Error("admin keypair is underfunded on this cluster");

  const send = (ixs: TransactionInstruction[], signers: Keypair[] = []) =>
    sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [admin, ...signers], { commitment: "confirmed" });

  // ----- collateral mint (demo USDC) -----
  let usdcMint: PublicKey;
  if (process.env.USDC_MINT) {
    usdcMint = new PublicKey(process.env.USDC_MINT);
    console.log(`Collateral mint   ${usdcMint.toBase58()}  (reused)`);
  } else {
    usdcMint = await createMint(connection, admin, admin.publicKey, null, 6);
    console.log(`Collateral mint   ${usdcMint.toBase58()}  (created, 6 decimals)`);
  }
  const adminUsdc = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, admin.publicKey);
  await mintTo(connection, admin, usdcMint, adminUsdc.address, admin, BigInt(USDC(1_000_000).toString()));

  // Optionally fund demo wallets so they can trade.
  for (const w of (process.env.DEMO_WALLETS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const ata = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, new PublicKey(w));
    await mintTo(connection, admin, usdcMint, ata.address, admin, BigInt(USDC(50_000).toString()));
    console.log(`Funded wallet     ${w}  (+50,000 demo USDC)`);
  }

  // ----- initialize global config (idempotent: skip if already done) -----
  try {
    await client.fetchConfig();
    console.log(`Config            already initialized`);
  } catch {
    await send([
      await client.initializeIx(
        admin.publicKey,
        usdcMint,
        100, // fee_bps = 1%
        new BN(30), // dispute_period = 30s (demo)
        admin.publicKey, // guardian = admin for the demo
        2500 // lp_fee_bps = 25% of the fee to LPs
      ),
    ]);
    // bond for the optimistic market
    await send([await client.setBondAmountIx(admin.publicKey, USDC(10))]);
    console.log(`Config            initialized (fee 1%, lpFee 25%, dispute 30s, bond 10 USDC, guardian=admin)`);
  }

  const created: { id: number; label: string }[] = [];
  async function makeMarket(label: string, params: any, seed = USDC(2000)) {
    const { ix, marketId } = await client.createMarketIx(admin.publicKey, params, usdcMint);
    await send([ix]);
    await send([await client.seedLiquidityIx(admin.publicKey, marketId, seed, usdcMint)]);
    created.push({ id: marketId, label });
    console.log(`Market #${marketId}        ${label}`);
    return marketId;
  }

  const t = nowSec();
  const farClose = new BN(t + 7 * DAY);

  // A price-moving buy: admin trades against a freshly-seeded pool so the demo
  // markets show realistic, varied odds instead of a flat 50/50.
  const { quoteBuy } = await import("../sdk/amm");
  async function move(marketId: number, outcome: number, amount: BN) {
    const m = await client.fetchMarketById(marketId);
    const net = amount.sub(amount.muln(100).divn(10000)); // net of the 1% taker fee
    const [rb, ro] = outcome === OUTCOME_YES ? [m.reserveYes, m.reserveNo] : [m.reserveNo, m.reserveYes];
    const q = quoteBuy(rb, ro, net);
    await send(await client.buyIxs(admin.publicKey, marketId, outcome, amount, q.tokensOut, usdcMint));
  }

  // 1) Binary, trusted-key resolver.
  const m0 = await makeMarket("Binary · trusted · 'H100 neocloud < $2.00/hr by month end?'", {
    question: "Will the H100 neocloud rate settle below $2.00/hr at month end?",
    resolutionSource: "Silicon Data SDH100RT",
    closeTime: farClose,
    resolutionTime: farClose,
    resolver: admin.publicKey,
    resolverKind: RESOLVER_TRUSTED_KEY,
    marketKind: MARKET_BINARY,
  }, USDC(6000));

  // 2) Scalar / range, trusted-key resolver. Range $1.50–$3.50 (stored *100).
  const m1 = await makeMarket("Scalar · trusted · 'H100 neocloud $/hr, range $1.50–$3.50'", {
    question: "H100 neocloud $/hr monthly settlement (scalar)",
    resolutionSource: "Silicon Data SDH100RT",
    closeTime: farClose,
    resolutionTime: farClose,
    resolver: admin.publicKey,
    resolverKind: RESOLVER_TRUSTED_KEY,
    marketKind: MARKET_SCALAR,
    lowerBound: new BN(150),
    upperBound: new BN(350),
  }, USDC(9000));

  // 3) Binary, oracle-feed resolver, with a published PriceFeed.
  const feed = Keypair.generate();
  await send([await client.initPriceFeedIx(admin.publicKey, feed.publicKey, "OCPI ORNNH100", 2)], [feed]);
  await send([await client.publishPriceIx(admin.publicKey, feed.publicKey, new BN(243))]); // $2.43
  console.log(`Price feed        ${feed.publicKey.toBase58()}  (OCPI ORNNH100 = $2.43, decimals 2)`);
  const m2 = await makeMarket("Binary · oracle-feed · 'H100 >= $2.20/hr?' (feed=$2.43)", {
    question: "Will the H100 OCPI index settle at or above $2.20/hr?",
    resolutionSource: "OCPI ORNNH100",
    closeTime: farClose,
    resolutionTime: farClose,
    resolver: admin.publicKey,
    resolverKind: RESOLVER_ORACLE_FEED,
    oracleFeed: feed.publicKey,
    oracleStrike: new BN(220),
    oracleComparison: CMP_GTE,
    oracleMaxStaleness: new BN(7 * DAY),
  }, USDC(14000));

  // 4) Binary, optimistic resolver.
  const m3 = await makeMarket("Binary · optimistic · 'New frontier model ships this quarter?'", {
    question: "Will a new frontier model (>= GPT-5 class) ship this quarter?",
    resolutionSource: "Public announcements / LMArena",
    closeTime: farClose,
    resolutionTime: farClose,
    resolver: admin.publicKey, // unused for optimistic
    resolverKind: RESOLVER_OPTIMISTIC,
    marketKind: MARKET_BINARY,
  }, USDC(4000));

  // ----- realistic order flow so prices aren't a flat 50/50 -----
  console.log("Placing demo trades ...");
  // #0: most don't expect H100 to fall below $2.00 -> leans NO.
  await move(m0, OUTCOME_NO, USDC(2600));
  await move(m0, OUTCOME_YES, USDC(700));
  // #1 scalar: net LONG demand pushes the implied $/hr up.
  await move(m1, OUTCOME_YES, USDC(3200));
  await move(m1, OUTCOME_NO, USDC(900));
  // #2 oracle: the feed ($2.43) already clears the $2.20 strike -> strong YES.
  await move(m2, OUTCOME_YES, USDC(7000));
  await move(m2, OUTCOME_NO, USDC(800));
  // #3 optimistic: a mild YES lean.
  await move(m3, OUTCOME_YES, USDC(1500));
  await move(m3, OUTCOME_NO, USDC(450));
  console.log("Demo trades placed.");

  console.log("\n=== demo ready ===");
  console.log(`collateral mint : ${usdcMint.toBase58()}`);
  console.log(`markets         : ${created.map((c) => "#" + c.id).join(", ")}`);
  console.log(`frontend        : NEXT_PUBLIC_RPC_URL=${RPC} (and point it at this program id)`);
  console.log(`to let a wallet trade: re-run with DEMO_WALLETS=<their pubkey>`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
