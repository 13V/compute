/**
 * Seed a Compute deployment with a curated demo catalog (~14 markets) spanning
 * GPU rental rates, AI capability milestones, hardware supply & power, and cloud
 * spot / inference cost — each seeded with liquidity, with published oracle feeds
 * and realistic two-sided order flow so prices aren't a flat 50/50. Exercises
 * every market kind (binary/scalar) and resolver kind (trusted/oracle/optimistic).
 * Works against any cluster (local validator or devnet) via ANCHOR_PROVIDER_URL.
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
  CMP_LTE,
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
  const D = (days: number) => new BN(t + days * DAY);

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

  // A published oracle price feed (decimals + integer value) referenced by the
  // oracle-resolved markets below.
  async function feed(label: string, decimals: number, value: number): Promise<PublicKey> {
    const kp = Keypair.generate();
    await send([await client.initPriceFeedIx(admin.publicKey, kp.publicKey, label, decimals)], [kp]);
    await send([await client.publishPriceIx(admin.publicKey, kp.publicKey, new BN(value))]);
    console.log(`Price feed        ${kp.publicKey.toBase58()}  (${label} = ${value} @ 1e-${decimals})`);
    return kp.publicKey;
  }
  const fH100 = await feed("OCPI ORNNH100", 2, 243); // $2.43/hr
  const fB200 = await feed("OCPI ORNNB200", 2, 620); // $6.20/hr
  const fElo = await feed("LMArena top Elo", 0, 1483);
  const fP5 = await feed("AWS p5 spot $/hr", 2, 2850); // $28.50/hr (8xH100)

  const trusted = admin.publicKey;
  const staleness = new BN(30 * DAY);
  const mk = (label: string, params: any, seedUsdc: number) =>
    makeMarket(label, params, USDC(seedUsdc));

  // ===================== GPU rental rates =====================
  const gH100s = await mk("GPU rental · scalar · H100 80GB $/hr [1.50–3.50]", {
    question: "H100 80GB neocloud $/hr — monthly settlement (scalar)",
    resolutionSource: "Silicon Data SDH100RT",
    closeTime: D(30), resolutionTime: D(30),
    resolver: trusted, resolverKind: RESOLVER_TRUSTED_KEY,
    marketKind: MARKET_SCALAR, lowerBound: new BN(150), upperBound: new BN(350),
  }, 14000);

  const gH100b = await mk("GPU rental · oracle · H100 OCPI ≥ $2.20/hr? (feed $2.43)", {
    question: "Will the H100 OCPI index settle at or above $2.20/hr?",
    resolutionSource: "OCPI ORNNH100",
    closeTime: D(14), resolutionTime: D(14),
    resolver: trusted, resolverKind: RESOLVER_ORACLE_FEED, marketKind: MARKET_BINARY,
    oracleFeed: fH100, oracleStrike: new BN(220), oracleComparison: CMP_GTE, oracleMaxStaleness: staleness,
  }, 21000);

  const gH200 = await mk("GPU rental · scalar · H200 141GB $/hr [2.50–5.50]", {
    question: "H200 141GB neocloud $/hr — monthly settlement (scalar)",
    resolutionSource: "Silicon Data SDH200RT",
    closeTime: D(30), resolutionTime: D(30),
    resolver: trusted, resolverKind: RESOLVER_TRUSTED_KEY,
    marketKind: MARKET_SCALAR, lowerBound: new BN(250), upperBound: new BN(550),
  }, 12000);

  const gB200 = await mk("GPU rental · oracle · B200 cluster ≥ $5.50/hr? (feed $6.20)", {
    question: "Will the B200 cluster rate settle at or above $5.50/hr?",
    resolutionSource: "OCPI ORNNB200",
    closeTime: D(21), resolutionTime: D(21),
    resolver: trusted, resolverKind: RESOLVER_ORACLE_FEED, marketKind: MARKET_BINARY,
    oracleFeed: fB200, oracleStrike: new BN(550), oracleComparison: CMP_GTE, oracleMaxStaleness: staleness,
  }, 9000);

  const gA100 = await mk("GPU rental · trusted · A100 80GB < $1.00/hr by quarter end?", {
    question: "Will the A100 80GB rate fall below $1.00/hr by quarter end?",
    resolutionSource: "Silicon Data SDA100RT",
    closeTime: D(90), resolutionTime: D(90),
    resolver: trusted, resolverKind: RESOLVER_TRUSTED_KEY, marketKind: MARKET_BINARY,
  }, 6000);

  // ===================== AI capability milestones =====================
  const aFrontier = await mk("AI milestone · optimistic · Frontier model (≥ GPT-5) ships this quarter?", {
    question: "Will a new frontier model (>= GPT-5 class) ship this quarter?",
    resolutionSource: "Public announcements / LMArena",
    closeTime: D(60), resolutionTime: D(60),
    resolver: trusted, resolverKind: RESOLVER_OPTIMISTIC, marketKind: MARKET_BINARY,
  }, 7000);

  const aOpen = await mk("AI milestone · optimistic · Open-weights model in LMArena top-5 by year end?", {
    question: "Will an open-weights model rank in the LMArena top 5 by year end?",
    resolutionSource: "LMArena leaderboard",
    closeTime: D(180), resolutionTime: D(180),
    resolver: trusted, resolverKind: RESOLVER_OPTIMISTIC, marketKind: MARKET_BINARY,
  }, 5000);

  const aSwe = await mk("AI milestone · optimistic · A model > 80% on SWE-bench Verified by year end?", {
    question: "Will any model exceed 80% on SWE-bench Verified by year end?",
    resolutionSource: "SWE-bench Verified leaderboard",
    closeTime: D(180), resolutionTime: D(180),
    resolver: trusted, resolverKind: RESOLVER_OPTIMISTIC, marketKind: MARKET_BINARY,
  }, 6000);

  const aElo = await mk("AI milestone · oracle · Top LMArena Elo ≥ 1500 by month end? (feed 1483)", {
    question: "Will the top LMArena Elo reach 1500 by month end?",
    resolutionSource: "LMArena top Elo",
    closeTime: D(30), resolutionTime: D(30),
    resolver: trusted, resolverKind: RESOLVER_ORACLE_FEED, marketKind: MARKET_BINARY,
    oracleFeed: fElo, oracleStrike: new BN(1500), oracleComparison: CMP_GTE, oracleMaxStaleness: staleness,
  }, 8000);

  // ===================== Hardware supply & power =====================
  const hRubin = await mk("Hardware · optimistic · NVIDIA announces post-Blackwell GPU by year end?", {
    question: "Will NVIDIA announce a post-Blackwell (Rubin-class) GPU by year end?",
    resolutionSource: "NVIDIA announcements / GTC",
    closeTime: D(180), resolutionTime: D(180),
    resolver: trusted, resolverKind: RESOLVER_OPTIMISTIC, marketKind: MARKET_BINARY,
  }, 5000);

  const hCowos = await mk("Hardware · trusted · TSMC CoWoS ≥ 70k wafers/mo by year end?", {
    question: "Will TSMC CoWoS capacity reach 70k wafers/month by year end?",
    resolutionSource: "TrendForce / TSMC guidance",
    closeTime: D(180), resolutionTime: D(180),
    resolver: trusted, resolverKind: RESOLVER_TRUSTED_KEY, marketKind: MARKET_BINARY,
  }, 4000);

  const hPower = await mk("Power · scalar · US datacenter power demand end-2026, GW [30–60]", {
    question: "US datacenter power demand at end of 2026 (GW, scalar)",
    resolutionSource: "EIA / grid operators",
    closeTime: D(150), resolutionTime: D(150),
    resolver: trusted, resolverKind: RESOLVER_TRUSTED_KEY,
    marketKind: MARKET_SCALAR, lowerBound: new BN(30), upperBound: new BN(60),
  }, 7000);

  // ===================== Cloud spot & inference cost =====================
  const cP5 = await mk("Cloud spot · oracle · AWS p5 (8×H100) spot ≤ $30/hr this month? (feed $28.50)", {
    question: "Will the AWS p5 (8xH100) spot rate stay at or below $30/hr this month?",
    resolutionSource: "AWS p5 spot $/hr",
    closeTime: D(14), resolutionTime: D(14),
    resolver: trusted, resolverKind: RESOLVER_ORACLE_FEED, marketKind: MARKET_BINARY,
    oracleFeed: fP5, oracleStrike: new BN(3000), oracleComparison: CMP_LTE, oracleMaxStaleness: staleness,
  }, 9000);

  const cInf = await mk("Inference cost · scalar · GPT-4-class $/M output tokens [1–15]", {
    question: "GPT-4-class inference price, $/M output tokens (scalar)",
    resolutionSource: "Artificial Analysis",
    closeTime: D(45), resolutionTime: D(45),
    resolver: trusted, resolverKind: RESOLVER_TRUSTED_KEY,
    marketKind: MARKET_SCALAR, lowerBound: new BN(1), upperBound: new BN(15),
  }, 8000);

  // ----- realistic two-sided order flow so prices aren't a flat 50/50 -----
  console.log("Placing demo order flow ...");
  // GPU rental rates
  await move(gH100s, OUTCOME_YES, USDC(5200)); await move(gH100s, OUTCOME_NO, USDC(1400)); // implied ~$2.6
  await move(gH100b, OUTCOME_YES, USDC(7000)); await move(gH100b, OUTCOME_NO, USDC(800));  // feed clears strike -> YES
  await move(gH200, OUTCOME_YES, USDC(4200)); await move(gH200, OUTCOME_NO, USDC(1200));   // LONG lean
  await move(gB200, OUTCOME_YES, USDC(3600)); await move(gB200, OUTCOME_NO, USDC(700));    // YES lean
  await move(gA100, OUTCOME_YES, USDC(2200)); await move(gA100, OUTCOME_NO, USDC(700));    // expects the price to keep falling
  // AI capability milestones
  await move(aFrontier, OUTCOME_YES, USDC(2600)); await move(aFrontier, OUTCOME_NO, USDC(800));
  await move(aOpen, OUTCOME_YES, USDC(2800)); await move(aOpen, OUTCOME_NO, USDC(500));    // strong YES
  await move(aSwe, OUTCOME_YES, USDC(2600)); await move(aSwe, OUTCOME_NO, USDC(700));
  await move(aElo, OUTCOME_NO, USDC(2200)); await move(aElo, OUTCOME_YES, USDC(1500));     // 1483 < 1500 -> slight NO
  // Hardware supply & power
  await move(hRubin, OUTCOME_YES, USDC(2200)); await move(hRubin, OUTCOME_NO, USDC(600));
  await move(hCowos, OUTCOME_YES, USDC(1500)); await move(hCowos, OUTCOME_NO, USDC(600));
  await move(hPower, OUTCOME_NO, USDC(2000)); await move(hPower, OUTCOME_YES, USDC(1200)); // implied ~42 GW
  // Cloud spot & inference cost
  await move(cP5, OUTCOME_YES, USDC(3400)); await move(cP5, OUTCOME_NO, USDC(800));        // spot under strike -> YES
  await move(cInf, OUTCOME_NO, USDC(2900)); await move(cInf, OUTCOME_YES, USDC(1200));     // implied ~$5
  console.log("Demo order flow placed.");

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
