/**
 * End-to-end integration tests for the Compute Markets program, run against a
 * local `solana-test-validator` (started by `anchor test` / the test script).
 * Exercises the full lifecycle:
 *
 *   initialize -> create_market -> seed_liquidity -> buy -> sell
 *               -> resolve -> redeem -> claim_pool -> collect_fees
 *
 * and asserts the core conservation invariant after every state change:
 *   vault balance == market.collateral + market.fee_accrued
 *   yes_supply == no_supply == market.collateral
 *
 * plus negative cases (slippage, auth, timing, trading-after-resolution).
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  Transaction,
  Connection,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint as splCreateMint,
  getOrCreateAssociatedTokenAccount,
  mintTo as splMintTo,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";

import {
  ComputeClient,
  OUTCOME_YES,
  OUTCOME_NO,
  quoteBuy,
  quoteSell,
  feeAmount,
  marginalPrice,
  deriveMarketAccounts,
} from "../sdk/client";

const USDC = (n: number) => new BN(Math.round(n * 1_000_000));
const FEE_BPS = 100; // 1%
const nowSec = () => Math.floor(Date.now() / 1000);

let connection: Connection;
let provider: anchor.AnchorProvider;
let client: ComputeClient;

let admin: Keypair; // config admin, market creator, LP, resolver
let user1: Keypair;
let user2: Keypair;
let usdcMint: PublicKey;
const marketId = 0;

// ---------- helpers (live validator) ----------

async function send(ixs: TransactionInstruction[], payer: Keypair, extraSigners: Keypair[] = []) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(connection, tx, [payer, ...extraSigners], {
    commitment: "confirmed",
  });
}

/** Send expecting failure; returns the error+logs string, or throws if it unexpectedly succeeded. */
async function sendExpectFail(
  ixs: TransactionInstruction[],
  payer: Keypair,
  extraSigners: Keypair[] = []
): Promise<string> {
  try {
    await send(ixs, payer, extraSigners);
  } catch (e: any) {
    const logs = (e.logs || []).join("\n");
    return `${e.message}\n${logs}`;
  }
  throw new Error("expected transaction to fail but it succeeded");
}

async function fund(kp: Keypair) {
  const sig = await connection.requestAirdrop(kp.publicKey, 100 * anchor.web3.LAMPORTS_PER_SOL);
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}

async function tokenBalance(ata: PublicKey): Promise<BN> {
  try {
    const bal = await connection.getTokenAccountBalance(ata, "confirmed");
    return new BN(bal.value.amount);
  } catch {
    return new BN(0);
  }
}

async function mintSupply(mint: PublicKey): Promise<BN> {
  const s = await connection.getTokenSupply(mint, "confirmed");
  return new BN(s.value.amount);
}

async function assertConservation(label: string) {
  const m = await client.fetchMarketById(marketId);
  const a = deriveMarketAccounts(marketId);

  // Invariant 1 (always holds): the vault fully backs outstanding collateral plus fees.
  const vault = await tokenBalance(a.vault);
  const expected = m.collateral.add(m.feeAccrued);
  assert.strictEqual(
    vault.toString(),
    expected.toString(),
    `[${label}] vault(${vault}) != collateral(${m.collateral}) + fee(${m.feeAccrued})`
  );

  // Invariant 2: outcome-token supply backing.
  const yes = await mintSupply(a.yesMint);
  const no = await mintSupply(a.noMint);
  if (m.state === 0) {
    // Open: every YES is matched by a NO, both fully collateral-backed (full sets).
    assert.strictEqual(yes.toString(), m.collateral.toString(), `[${label}] yes supply != collateral`);
    assert.strictEqual(no.toString(), m.collateral.toString(), `[${label}] no supply != collateral`);
  } else {
    // Resolved: only the winning side is redeemable and must equal backing exactly.
    // The losing side is intentionally left outstanding (worthless) and is not burned.
    const winning = m.outcome === OUTCOME_YES ? yes : no;
    assert.strictEqual(
      winning.toString(),
      m.collateral.toString(),
      `[${label}] winning supply != collateral`
    );
  }
}

// ---------- suite ----------

describe("compute-markets end-to-end", () => {
  before(async () => {
    admin = Keypair.generate();
    user1 = Keypair.generate();
    user2 = Keypair.generate();

    connection = new Connection(
      process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899",
      "confirmed"
    );
    provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
      commitment: "confirmed",
    });
    client = new ComputeClient(provider);

    for (const kp of [admin, user1, user2]) {
      await fund(kp);
    }

    usdcMint = await splCreateMint(connection, admin, admin.publicKey, null, 6);
    for (const kp of [admin, user1, user2]) {
      const ata = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, kp.publicKey);
      await splMintTo(connection, admin, usdcMint, ata.address, admin, BigInt(USDC(10_000).toString()));
    }
  });

  it("initializes global config", async () => {
    const ix = await client.initializeIx(admin.publicKey, usdcMint, FEE_BPS);
    await send([ix], admin);
    const cfg = await client.fetchConfig();
    assert.strictEqual(cfg.admin.toBase58(), admin.publicKey.toBase58());
    assert.strictEqual(cfg.feeBps, FEE_BPS);
    assert.strictEqual(cfg.collateralMint.toBase58(), usdcMint.toBase58());
    assert.strictEqual(cfg.marketCount.toString(), "0");
  });

  it("creates a market", async () => {
    const ix = await client.createMarketIx(
      admin.publicKey,
      marketId,
      "Will H100 neocloud rental settle ABOVE $2.20/hr for this month?",
      "Silicon Data SDH100RT",
      new BN(nowSec() - 60), // resolvable immediately for the happy path
      admin.publicKey, // resolver
      usdcMint
    );
    await send([ix], admin);
    const m = await client.fetchMarketById(marketId);
    assert.strictEqual(m.state, 0); // open
    assert.strictEqual(m.reserveYes.toString(), "0");
    assert.strictEqual(m.creator.toBase58(), admin.publicKey.toBase58());
    const cfg = await client.fetchConfig();
    assert.strictEqual(cfg.marketCount.toString(), "1");
  });

  it("seeds liquidity at 50/50", async () => {
    const seed = USDC(1000);
    const ix = await client.seedLiquidityIx(admin.publicKey, marketId, seed, usdcMint);
    await send([ix], admin);
    const m = await client.fetchMarketById(marketId);
    assert.strictEqual(m.reserveYes.toString(), seed.toString());
    assert.strictEqual(m.reserveNo.toString(), seed.toString());
    assert.strictEqual(m.collateral.toString(), seed.toString());
    assert.strictEqual(marginalPrice(m.reserveYes, m.reserveNo), 0.5);
    await assertConservation("after seed");
  });

  it("rejects a buy whose min-out is unsatisfiable (slippage)", async () => {
    const m = await client.fetchMarketById(marketId);
    const collateralIn = USDC(100);
    const a = collateralIn.sub(feeAmount(collateralIn, FEE_BPS));
    const q = quoteBuy(m.reserveYes, m.reserveNo, a);
    const ixs = await client.buyIxs(
      user1.publicKey,
      marketId,
      OUTCOME_YES,
      collateralIn,
      q.tokensOut.addn(1_000_000), // demand more than possible
      usdcMint
    );
    const logs = await sendExpectFail(ixs, user1);
    assert.match(logs, /SlippageExceeded|0x177c|custom program error/i, "expected slippage failure");
  });

  it("user1 buys YES and receives exactly the quoted amount", async () => {
    const before = await client.fetchMarketById(marketId);
    const collateralIn = USDC(100);
    const fee = feeAmount(collateralIn, FEE_BPS);
    const a = collateralIn.sub(fee);
    const q = quoteBuy(before.reserveYes, before.reserveNo, a);

    const yesAta = getAssociatedTokenAddressSync(deriveMarketAccounts(marketId).yesMint, user1.publicKey);
    const ixs = await client.buyIxs(user1.publicKey, marketId, OUTCOME_YES, collateralIn, q.tokensOut, usdcMint);
    await send(ixs, user1);

    assert.strictEqual((await tokenBalance(yesAta)).toString(), q.tokensOut.toString(), "user1 YES balance");
    const m = await client.fetchMarketById(marketId);
    assert.strictEqual(m.reserveYes.toString(), q.newReserveBought.toString());
    assert.strictEqual(m.reserveNo.toString(), q.newReserveOther.toString());
    assert.strictEqual(m.collateral.toString(), before.collateral.add(a).toString());
    assert.strictEqual(m.feeAccrued.toString(), before.feeAccrued.add(fee).toString());
    assert.isAbove(marginalPrice(m.reserveYes, m.reserveNo), 0.5);
    await assertConservation("after user1 buy YES");
  });

  it("user2 buys NO", async () => {
    const before = await client.fetchMarketById(marketId);
    const collateralIn = USDC(60);
    const fee = feeAmount(collateralIn, FEE_BPS);
    const a = collateralIn.sub(fee);
    const q = quoteBuy(before.reserveNo, before.reserveYes, a); // bought = NO

    const noAta = getAssociatedTokenAddressSync(deriveMarketAccounts(marketId).noMint, user2.publicKey);
    const ixs = await client.buyIxs(user2.publicKey, marketId, OUTCOME_NO, collateralIn, q.tokensOut, usdcMint);
    await send(ixs, user2);

    assert.strictEqual((await tokenBalance(noAta)).toString(), q.tokensOut.toString(), "user2 NO balance");
    const m = await client.fetchMarketById(marketId);
    assert.strictEqual(m.reserveNo.toString(), q.newReserveBought.toString());
    assert.strictEqual(m.reserveYes.toString(), q.newReserveOther.toString());
    await assertConservation("after user2 buy NO");
  });

  it("user1 sells some YES back", async () => {
    const before = await client.fetchMarketById(marketId);
    const yesAta = getAssociatedTokenAddressSync(deriveMarketAccounts(marketId).yesMint, user1.publicKey);
    const usdcAta = getAssociatedTokenAddressSync(usdcMint, user1.publicKey);
    const yesBefore = await tokenBalance(yesAta);
    const usdcBefore = await tokenBalance(usdcAta);

    const collateralOut = USDC(20);
    const q = quoteSell(before.reserveYes, before.reserveNo, collateralOut)!;
    const fee = feeAmount(collateralOut, FEE_BPS);

    const ix = await client.sellIx(user1.publicKey, marketId, OUTCOME_YES, collateralOut, q.tokensIn, usdcMint);
    await send([ix], user1);

    assert.strictEqual((await tokenBalance(yesAta)).toString(), yesBefore.sub(q.tokensIn).toString(), "YES spent");
    assert.strictEqual(
      (await tokenBalance(usdcAta)).toString(),
      usdcBefore.add(collateralOut).sub(fee).toString(),
      "USDC received net of fee"
    );
    const m = await client.fetchMarketById(marketId);
    assert.strictEqual(m.reserveYes.toString(), q.newReserveSold.toString());
    assert.strictEqual(m.reserveNo.toString(), q.newReserveOther.toString());
    assert.strictEqual(m.collateral.toString(), before.collateral.sub(collateralOut).toString());
    await assertConservation("after user1 sell YES");
  });

  it("rejects resolve from a non-resolver", async () => {
    const ix = await client.resolveIx(user2.publicKey, marketId, OUTCOME_YES);
    const logs = await sendExpectFail([ix], user2);
    assert.match(logs, /Unauthorized|custom program error/i);
  });

  it("rejects resolve before resolution_time", async () => {
    const futureId = 1;
    const createIx = await client.createMarketIx(
      admin.publicKey,
      futureId,
      "Future market",
      "src",
      new BN(nowSec() + 1_000_000),
      admin.publicKey,
      usdcMint
    );
    await send([createIx], admin);
    const ix = await client.resolveIx(admin.publicKey, futureId, OUTCOME_YES);
    const logs = await sendExpectFail([ix], admin);
    assert.match(logs, /TooEarlyToResolve|custom program error/i);
  });

  it("resolves the market to YES", async () => {
    const ix = await client.resolveIx(admin.publicKey, marketId, OUTCOME_YES);
    await send([ix], admin);
    const m = await client.fetchMarketById(marketId);
    assert.strictEqual(m.state, 1); // resolved
    assert.strictEqual(m.outcome, OUTCOME_YES);
  });

  it("rejects trading after resolution", async () => {
    const ixs = await client.buyIxs(user1.publicKey, marketId, OUTCOME_YES, USDC(10), new BN(0), usdcMint);
    const logs = await sendExpectFail(ixs, user1);
    assert.match(logs, /MarketNotOpen|custom program error/i);
  });

  it("user1 redeems winning YES 1:1", async () => {
    const yesAta = getAssociatedTokenAddressSync(deriveMarketAccounts(marketId).yesMint, user1.publicKey);
    const usdcAta = getAssociatedTokenAddressSync(usdcMint, user1.publicKey);
    const yesBal = await tokenBalance(yesAta);
    const usdcBefore = await tokenBalance(usdcAta);
    assert.isTrue(yesBal.gtn(0), "user1 should hold YES");

    const ix = await client.redeemIx(user1.publicKey, marketId, OUTCOME_YES, yesBal, usdcMint);
    await send([ix], user1);

    assert.strictEqual((await tokenBalance(yesAta)).toString(), "0", "YES burned");
    assert.strictEqual((await tokenBalance(usdcAta)).toString(), usdcBefore.add(yesBal).toString(), "USDC 1:1");
    await assertConservation("after user1 redeem");
  });

  it("LP claims the winning-side pool reserve", async () => {
    const before = await client.fetchMarketById(marketId);
    const lpUsdc = getAssociatedTokenAddressSync(usdcMint, admin.publicKey);
    const lpBefore = await tokenBalance(lpUsdc);
    const winningReserve = before.reserveYes; // outcome YES

    const ix = await client.claimPoolIx(admin.publicKey, marketId, OUTCOME_YES, usdcMint);
    await send([ix], admin);

    assert.strictEqual(
      (await tokenBalance(lpUsdc)).toString(),
      lpBefore.add(winningReserve).toString(),
      "LP receives winning pool reserve"
    );
    const m = await client.fetchMarketById(marketId);
    assert.strictEqual(m.reserveYes.toString(), "0");
    await assertConservation("after LP claim");
  });

  it("drains to zero backing and admin collects fees", async () => {
    let m = await client.fetchMarketById(marketId);
    assert.strictEqual(m.collateral.toString(), "0", "all backing redeemed");

    const adminUsdc = getAssociatedTokenAddressSync(usdcMint, admin.publicKey);
    const adminBefore = await tokenBalance(adminUsdc);
    const fees = m.feeAccrued;
    assert.isTrue(fees.gtn(0), "fees should have accrued");

    const ix = await client.collectFeesIx(admin.publicKey, marketId, usdcMint);
    await send([ix], admin);

    assert.strictEqual((await tokenBalance(adminUsdc)).toString(), adminBefore.add(fees).toString(), "fees withdrawn");
    m = await client.fetchMarketById(marketId);
    assert.strictEqual(m.feeAccrued.toString(), "0");
    assert.strictEqual((await tokenBalance(deriveMarketAccounts(marketId).vault)).toString(), "0", "vault empty");
  });
});
