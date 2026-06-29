/**
 * End-to-end integration tests for the Compute Markets program, run against a
 * local `solana-test-validator`. Covers the full hardened lifecycle:
 *
 *   initialize -> create_market -> seed_liquidity -> buy/sell (until close_time)
 *     -> propose_outcome -> [dispute window] -> finalize_outcome
 *     -> redeem / claim_pool / collect_fees
 *
 * plus the settlement-defense paths (guardian void + 50/50 refund, trading halt,
 * pause switch, two-step admin) and a broad set of negative/auth cases.
 *
 * Conservation invariant asserted after every state change:
 *   vault == market.collateral + market.fee_accrued.
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
  STATE_RESOLVED,
  STATE_VOID,
  STATE_RESOLVING,
  RESOLVER_ORACLE_FEED,
  CMP_GTE,
  quoteBuy,
  quoteSell,
  feeAmount,
  marginalPrice,
  deriveMarketAccounts,
} from "../sdk/client";

const USDC = (n: number) => new BN(Math.round(n * 1_000_000));
const FEE_BPS = 100; // 1%
const DISPUTE_PERIOD = 3; // seconds
const nowSec = () => Math.floor(Date.now() / 1000);
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

let connection: Connection;
let provider: anchor.AnchorProvider;
let client: ComputeClient;

let admin: Keypair; // config admin, market creator, LP, resolver (per market as noted)
let guardian: Keypair;
let user1: Keypair;
let user2: Keypair;
let usdcMint: PublicKey;

// ---------- helpers ----------

async function send(ixs: TransactionInstruction[], payer: Keypair, extraSigners: Keypair[] = []) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(connection, tx, [payer, ...extraSigners], { commitment: "confirmed" });
}

async function sendExpectFail(ixs: TransactionInstruction[], payer: Keypair, extraSigners: Keypair[] = []): Promise<string> {
  try {
    await send(ixs, payer, extraSigners);
  } catch (e: any) {
    return `${e.message}\n${(e.logs || []).join("\n")}`;
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
  return new BN((await connection.getTokenSupply(mint, "confirmed")).value.amount);
}

/** Wait until the chain clock reaches `targetUnix` (+ small margin). */
async function waitChainTime(targetUnix: number) {
  for (let i = 0; i < 120; i++) {
    const slot = await connection.getSlot("confirmed");
    const t = await connection.getBlockTime(slot);
    if (t !== null && t >= targetUnix) return;
    await sleepMs(400);
  }
  throw new Error(`chain time never reached ${targetUnix}`);
}

async function vaultBalance(marketId: number): Promise<BN> {
  return tokenBalance(deriveMarketAccounts(marketId).vault);
}

async function assertConservation(marketId: number, label: string) {
  const m = await client.fetchMarketById(marketId);
  const vault = await vaultBalance(marketId);
  assert.strictEqual(
    vault.toString(),
    m.collateral.add(m.feeAccrued).toString(),
    `[${label}] vault(${vault}) != collateral(${m.collateral}) + fee(${m.feeAccrued})`
  );
}

/** Create a market and seed it with `seed` USDC. Returns its market id. */
async function createSeededMarket(opts: {
  resolver?: PublicKey;
  closeOffset?: number;
  resolutionOffset?: number;
  seed?: BN;
}): Promise<number> {
  const closeOffset = opts.closeOffset ?? 30;
  const resolutionOffset = opts.resolutionOffset ?? 30;
  const seed = opts.seed ?? USDC(1000);
  const now = nowSec();
  const { ix, marketId } = await client.createMarketIx(
    admin.publicKey,
    {
      question: `Compute market #${Math.random()}`,
      resolutionSource: "Silicon Data SDH100RT",
      closeTime: new BN(now + closeOffset),
      resolutionTime: new BN(now + resolutionOffset),
      resolver: opts.resolver ?? admin.publicKey,
    },
    usdcMint
  );
  await send([ix], admin);
  await send([await client.seedLiquidityIx(admin.publicKey, marketId, seed, usdcMint)], admin);
  return marketId;
}

async function buy(user: Keypair, marketId: number, outcome: number, collateralIn: BN) {
  const m = await client.fetchMarketById(marketId);
  const a = collateralIn.sub(feeAmount(collateralIn, FEE_BPS));
  const [rb, ro] = outcome === OUTCOME_YES ? [m.reserveYes, m.reserveNo] : [m.reserveNo, m.reserveYes];
  const q = quoteBuy(rb, ro, a);
  const ixs = await client.buyIxs(user.publicKey, marketId, outcome, collateralIn, q.tokensOut, usdcMint);
  await send(ixs, user);
  return q.tokensOut;
}

// ---------- suite ----------

describe("compute-markets", () => {
  before(async () => {
    admin = Keypair.generate();
    guardian = Keypair.generate();
    user1 = Keypair.generate();
    user2 = Keypair.generate();

    connection = new Connection(process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899", "confirmed");
    provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
    client = new ComputeClient(provider);

    for (const kp of [admin, guardian, user1, user2]) await fund(kp);

    usdcMint = await splCreateMint(connection, admin, admin.publicKey, null, 6);
    for (const kp of [admin, user1, user2]) {
      const ata = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, kp.publicKey);
      await splMintTo(connection, admin, usdcMint, ata.address, admin, BigInt(USDC(100_000).toString()));
    }

    await send(
      [await client.initializeIx(admin.publicKey, usdcMint, FEE_BPS, new BN(DISPUTE_PERIOD), guardian.publicKey)],
      admin
    );
    const cfg = await client.fetchConfig();
    assert.strictEqual(cfg.feeBps, FEE_BPS);
    assert.strictEqual(cfg.guardian.toBase58(), guardian.publicKey.toBase58());
    assert.strictEqual(cfg.disputePeriod.toString(), String(DISPUTE_PERIOD));
  });

  describe("trading & FPMM", () => {
    let marketId: number;

    it("seeds liquidity at 50/50 and tracks conservation", async () => {
      marketId = await createSeededMarket({});
      const m = await client.fetchMarketById(marketId);
      assert.strictEqual(m.reserveYes.toString(), USDC(1000).toString());
      assert.strictEqual(marginalPrice(m.reserveYes, m.reserveNo), 0.5);
      await assertConservation(marketId, "seed");
    });

    it("rejects a buy whose min-out is unsatisfiable (slippage)", async () => {
      const m = await client.fetchMarketById(marketId);
      const a = USDC(100).sub(feeAmount(USDC(100), FEE_BPS));
      const q = quoteBuy(m.reserveYes, m.reserveNo, a);
      const ixs = await client.buyIxs(user1.publicKey, marketId, OUTCOME_YES, USDC(100), q.tokensOut.addn(1_000_000), usdcMint);
      assert.match(await sendExpectFail(ixs, user1), /SlippageExceeded/);
    });

    it("user1 buys YES for exactly the quoted amount; price rises", async () => {
      const before = await client.fetchMarketById(marketId);
      const a = USDC(100).sub(feeAmount(USDC(100), FEE_BPS));
      const q = quoteBuy(before.reserveYes, before.reserveNo, a);
      const yesAta = getAssociatedTokenAddressSync(deriveMarketAccounts(marketId).yesMint, user1.publicKey);
      await send(await client.buyIxs(user1.publicKey, marketId, OUTCOME_YES, USDC(100), q.tokensOut, usdcMint), user1);

      assert.strictEqual((await tokenBalance(yesAta)).toString(), q.tokensOut.toString());
      const m = await client.fetchMarketById(marketId);
      assert.strictEqual(m.reserveYes.toString(), q.newReserveBought.toString());
      assert.isAbove(marginalPrice(m.reserveYes, m.reserveNo), 0.5);
      await assertConservation(marketId, "buy");
    });

    it("user1 sells some YES back, net of fee", async () => {
      const before = await client.fetchMarketById(marketId);
      const usdcAta = getAssociatedTokenAddressSync(usdcMint, user1.publicKey);
      const usdcBefore = await tokenBalance(usdcAta);
      const out = USDC(20);
      const q = quoteSell(before.reserveYes, before.reserveNo, out)!;
      const fee = feeAmount(out, FEE_BPS);
      await send([await client.sellIx(user1.publicKey, marketId, OUTCOME_YES, out, q.tokensIn, usdcMint)], user1);
      assert.strictEqual((await tokenBalance(usdcAta)).toString(), usdcBefore.add(out).sub(fee).toString());
      await assertConservation(marketId, "sell");
    });
  });

  describe("resolution: propose -> dispute window -> finalize -> redeem", () => {
    let marketId: number;

    before(async () => {
      marketId = await createSeededMarket({ resolutionOffset: 6, closeOffset: 6 });
      await buy(user1, marketId, OUTCOME_YES, USDC(200));
      await buy(user2, marketId, OUTCOME_NO, USDC(50));
    });

    it("rejects propose before resolution_time", async () => {
      const ix = await client.proposeOutcomeIx(admin.publicKey, marketId, OUTCOME_YES);
      assert.match(await sendExpectFail([ix], admin), /TooEarlyToResolve/);
    });

    it("rejects propose from a non-resolver", async () => {
      const m = await client.fetchMarketById(marketId);
      await waitChainTime(m.resolutionTime.toNumber() + 1);
      const ix = await client.proposeOutcomeIx(user2.publicKey, marketId, OUTCOME_YES);
      assert.match(await sendExpectFail([ix], user2), /Unauthorized/);
    });

    it("resolver proposes YES (enters dispute window)", async () => {
      await send([await client.proposeOutcomeIx(admin.publicKey, marketId, OUTCOME_YES)], admin);
      const m = await client.fetchMarketById(marketId);
      assert.strictEqual(m.state, 1); // RESOLVING
      assert.strictEqual(m.proposedOutcome, OUTCOME_YES);
    });

    it("rejects finalize during the dispute window", async () => {
      const ix = await client.finalizeOutcomeIx(admin.publicKey, marketId);
      assert.match(await sendExpectFail([ix], admin), /DisputeWindowOpen/);
    });

    it("rejects redeem before finalization", async () => {
      const ix = await client.redeemIx(user1.publicKey, marketId, OUTCOME_YES, new BN(1), usdcMint);
      assert.match(await sendExpectFail([ix], user1), /NotResolved/);
    });

    it("finalizes after the dispute window (permissionless crank)", async () => {
      const m = await client.fetchMarketById(marketId);
      await waitChainTime(m.resolvedAt.toNumber() + DISPUTE_PERIOD + 1);
      // user2 (not the resolver) can crank it — finalize is permissionless.
      await send([await client.finalizeOutcomeIx(user2.publicKey, marketId)], user2);
      const fin = await client.fetchMarketById(marketId);
      assert.strictEqual(fin.state, STATE_RESOLVED);
      assert.strictEqual(fin.outcome, OUTCOME_YES);
    });

    it("winner redeems 1:1, LP claims pool, admin collects fees, vault drains", async () => {
      const yesAta = getAssociatedTokenAddressSync(deriveMarketAccounts(marketId).yesMint, user1.publicKey);
      const yesBal = await tokenBalance(yesAta);
      await send([await client.redeemIx(user1.publicKey, marketId, OUTCOME_YES, yesBal, usdcMint)], user1);
      assert.strictEqual((await tokenBalance(yesAta)).toString(), "0");
      await assertConservation(marketId, "redeem");

      await send([await client.claimPoolIx(admin.publicKey, marketId, usdcMint)], admin);
      const afterClaim = await client.fetchMarketById(marketId);
      assert.strictEqual(afterClaim.collateral.toString(), "0", "all backing redeemed");

      await send([await client.collectFeesIx(admin.publicKey, marketId, usdcMint)], admin);
      assert.strictEqual((await vaultBalance(marketId)).toString(), "0", "vault fully drained");
    });
  });

  describe("guardian void -> 50/50 refund", () => {
    let marketId: number;

    it("guardian vetoes a proposal; both sides refund at 0.5; vault conserves", async () => {
      marketId = await createSeededMarket({ resolutionOffset: 5, closeOffset: 5 });
      const y = await buy(user1, marketId, OUTCOME_YES, USDC(300)); // user1 holds YES
      const n = await buy(user2, marketId, OUTCOME_NO, USDC(300)); // user2 holds NO

      const m0 = await client.fetchMarketById(marketId);
      await waitChainTime(m0.resolutionTime.toNumber() + 1);
      await send([await client.proposeOutcomeIx(admin.publicKey, marketId, OUTCOME_YES)], admin);

      // Non-guardian cannot void.
      assert.match(await sendExpectFail([await client.disputeVoidIx(user1.publicKey, marketId)], user1), /Unauthorized/);

      // Guardian voids within the window.
      await send([await client.disputeVoidIx(guardian.publicKey, marketId)], guardian);
      assert.strictEqual((await client.fetchMarketById(marketId)).state, STATE_VOID);

      // Each holder redeems their side for half collateral per token.
      const u1usdc = getAssociatedTokenAddressSync(usdcMint, user1.publicKey);
      const u2usdc = getAssociatedTokenAddressSync(usdcMint, user2.publicKey);
      const u1Before = await tokenBalance(u1usdc);
      const u2Before = await tokenBalance(u2usdc);
      await send([await client.redeemVoidIx(user1.publicKey, marketId, OUTCOME_YES, y, usdcMint)], user1);
      await send([await client.redeemVoidIx(user2.publicKey, marketId, OUTCOME_NO, n, usdcMint)], user2);
      assert.strictEqual((await tokenBalance(u1usdc)).toString(), u1Before.add(y.divn(2)).toString(), "user1 gets y/2");
      assert.strictEqual((await tokenBalance(u2usdc)).toString(), u2Before.add(n.divn(2)).toString(), "user2 gets n/2");
      await assertConservation(marketId, "void-redeem");

      // LP claims pooled reserves at 0.5 each.
      await send([await client.claimPoolIx(admin.publicKey, marketId, usdcMint)], admin);
      const m = await client.fetchMarketById(marketId);
      await assertConservation(marketId, "void-claim");
      // Only floor dust may remain.
      assert.isTrue(m.collateral.lten(4), `residual collateral dust too large: ${m.collateral}`);
    });
  });

  describe("operational safety", () => {
    it("halts trading at close_time", async () => {
      const marketId = await createSeededMarket({ closeOffset: 3, resolutionOffset: 30 });
      await buy(user1, marketId, OUTCOME_YES, USDC(10)); // before close: ok
      const m = await client.fetchMarketById(marketId);
      await waitChainTime(m.closeTime.toNumber() + 1);
      const ixs = await client.buyIxs(user1.publicKey, marketId, OUTCOME_YES, USDC(10), new BN(0), usdcMint);
      assert.match(await sendExpectFail(ixs, user1), /MarketClosed/);
    });

    it("pause blocks trading; only admin/guardian toggle it", async () => {
      const marketId = await createSeededMarket({});
      // Random user cannot pause.
      assert.match(await sendExpectFail([await client.setPausedIx(user1.publicKey, true)], user1), /Unauthorized/);
      // Guardian pauses.
      await send([await client.setPausedIx(guardian.publicKey, true)], guardian);
      const ixs = await client.buyIxs(user1.publicKey, marketId, OUTCOME_YES, USDC(10), new BN(0), usdcMint);
      assert.match(await sendExpectFail(ixs, user1), /Paused/);
      // Admin unpauses; trading resumes.
      await send([await client.setPausedIx(admin.publicKey, false)], admin);
      await buy(user1, marketId, OUTCOME_YES, USDC(10));
    });

    it("two-step admin transfer", async () => {
      const newAdmin = Keypair.generate();
      await fund(newAdmin);
      await send([await client.setAdminIx(admin.publicKey, newAdmin.publicKey)], admin);
      // Wrong account cannot accept.
      assert.match(await sendExpectFail([await client.acceptAdminIx(user1.publicKey)], user1), /Unauthorized/);
      await send([await client.acceptAdminIx(newAdmin.publicKey)], newAdmin);
      assert.strictEqual((await client.fetchConfig()).admin.toBase58(), newAdmin.publicKey.toBase58());
      // Hand control back so later tests keep working.
      await send([await client.setAdminIx(newAdmin.publicKey, admin.publicKey)], newAdmin);
      await send([await client.acceptAdminIx(admin.publicKey)], admin);
      assert.strictEqual((await client.fetchConfig()).admin.toBase58(), admin.publicKey.toBase58());
    });

    it("rejects voiding a fresh market too early", async () => {
      const marketId = await createSeededMarket({ resolutionOffset: 5, closeOffset: 5 });
      assert.match(await sendExpectFail([await client.voidStaleIx(user1.publicKey, marketId)], user1), /TooEarlyToVoid/);
    });

    it("create_market validates the time window", async () => {
      const now = nowSec();
      const bad = await client.createMarketIx(
        admin.publicKey,
        { question: "q", resolutionSource: "s", closeTime: new BN(now + 100), resolutionTime: new BN(now + 50), resolver: admin.publicKey },
        usdcMint
      );
      assert.match(await sendExpectFail([bad.ix], admin), /InvalidTimeWindow/);
    });
  });

  describe("oracle-feed resolution (Switchboard bridge)", () => {
    // Create + seed an oracle-resolved market bound to `feed`, strike, comparison.
    async function createOracleMarket(opts: {
      feed: PublicKey;
      strike: number;
      comparison: number;
      maxStaleness: number;
      resolutionOffset?: number;
    }): Promise<number> {
      const off = opts.resolutionOffset ?? 6;
      const now = nowSec();
      const { ix, marketId } = await client.createMarketIx(
        admin.publicKey,
        {
          question: `H100 neocloud >= $${opts.strike / 100}/hr?`,
          resolutionSource: "OCPI ORNNH100",
          closeTime: new BN(now + off),
          resolutionTime: new BN(now + off),
          resolver: admin.publicKey,
          resolverKind: RESOLVER_ORACLE_FEED,
          oracleFeed: opts.feed,
          oracleStrike: new BN(opts.strike),
          oracleComparison: opts.comparison,
          oracleMaxStaleness: new BN(opts.maxStaleness),
        },
        usdcMint
      );
      await send([ix], admin);
      await send([await client.seedLiquidityIx(admin.publicKey, marketId, USDC(1000), usdcMint)], admin);
      return marketId;
    }

    // Init a fresh feed (signed by the feed keypair) and publish an initial value.
    async function makeFeed(value: number): Promise<Keypair> {
      const feed = Keypair.generate();
      await send([await client.initPriceFeedIx(admin.publicKey, feed.publicKey, "OCPI ORNNH100", 2)], admin, [feed]);
      await send([await client.publishPriceIx(admin.publicKey, feed.publicKey, new BN(value))], admin);
      return feed;
    }

    it("resolves YES from the feed when value >= strike; finalizes after dispute", async () => {
      const feed = await makeFeed(252); // $2.52
      const marketId = await createOracleMarket({ feed: feed.publicKey, strike: 220, comparison: CMP_GTE, maxStaleness: 3600 });
      await buy(user1, marketId, OUTCOME_YES, USDC(100));

      // Trusted-key proposal must be rejected on an oracle market.
      assert.match(
        await sendExpectFail([await client.proposeOutcomeIx(admin.publicKey, marketId, OUTCOME_YES)], admin),
        /WrongResolverKind/
      );

      const m0 = await client.fetchMarketById(marketId);
      await waitChainTime(m0.resolutionTime.toNumber() + 1);

      // Anyone can crank oracle resolution.
      await send([await client.proposeFromOracleIx(user2.publicKey, marketId, feed.publicKey)], user2);
      const proposing = await client.fetchMarketById(marketId);
      assert.strictEqual(proposing.state, STATE_RESOLVING);
      assert.strictEqual(proposing.proposedOutcome, OUTCOME_YES, "252 >= 220 => YES");

      // Guardian could still veto here (defense in depth) — we let it finalize.
      await waitChainTime(proposing.resolvedAt.toNumber() + DISPUTE_PERIOD + 1);
      await send([await client.finalizeOutcomeIx(user2.publicKey, marketId)], user2);
      const fin = await client.fetchMarketById(marketId);
      assert.strictEqual(fin.state, STATE_RESOLVED);
      assert.strictEqual(fin.outcome, OUTCOME_YES);

      // Winner redeems.
      const yesAta = getAssociatedTokenAddressSync(deriveMarketAccounts(marketId).yesMint, user1.publicKey);
      const bal = await tokenBalance(yesAta);
      await send([await client.redeemIx(user1.publicKey, marketId, OUTCOME_YES, bal, usdcMint)], user1);
      await assertConservation(marketId, "oracle-redeem");
    });

    it("resolves NO when value < strike", async () => {
      const feed = await makeFeed(180); // $1.80 < $2.20
      const marketId = await createOracleMarket({ feed: feed.publicKey, strike: 220, comparison: CMP_GTE, maxStaleness: 3600 });
      const m0 = await client.fetchMarketById(marketId);
      await waitChainTime(m0.resolutionTime.toNumber() + 1);
      await send([await client.proposeFromOracleIx(user1.publicKey, marketId, feed.publicKey)], user1);
      assert.strictEqual((await client.fetchMarketById(marketId)).proposedOutcome, OUTCOME_NO, "180 < 220 => NO");
    });

    it("rejects oracle resolution on a stale feed", async () => {
      const feed = await makeFeed(252);
      // maxStaleness = 2s, but resolution_time is ~6s out, so the value is stale by then.
      const marketId = await createOracleMarket({ feed: feed.publicKey, strike: 220, comparison: CMP_GTE, maxStaleness: 2 });
      const m0 = await client.fetchMarketById(marketId);
      await waitChainTime(m0.resolutionTime.toNumber() + 1);
      assert.match(
        await sendExpectFail([await client.proposeFromOracleIx(user1.publicKey, marketId, feed.publicKey)], user1),
        /StaleFeed/
      );
      // Re-publishing a fresh value lets it resolve.
      await send([await client.publishPriceIx(admin.publicKey, feed.publicKey, new BN(252))], admin);
      await send([await client.proposeFromOracleIx(user1.publicKey, marketId, feed.publicKey)], user1);
      assert.strictEqual((await client.fetchMarketById(marketId)).state, STATE_RESOLVING);
    });

    it("rejects publishing from a non-authority", async () => {
      const feed = await makeFeed(100);
      assert.match(
        await sendExpectFail([await client.publishPriceIx(user1.publicKey, feed.publicKey, new BN(1))], user1),
        /Unauthorized/
      );
    });
  });
});
