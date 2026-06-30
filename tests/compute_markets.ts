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
  MARKET_SCALAR,
  PRICE_SCALE,
  CMP_GTE,
  quoteBuy,
  quoteSell,
  feeAmount,
  marginalPrice,
  scalarPayout,
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

  describe("scalar / range markets", () => {
    // Create + seed a SCALAR market over [lower, upper]. YES=LONG, NO=SHORT.
    async function createScalarMarket(opts: {
      lower: number;
      upper: number;
      seed?: BN;
      resolutionOffset?: number;
      resolver?: PublicKey;
      resolverKind?: number;
      oracleFeed?: PublicKey;
      oracleMaxStaleness?: number;
    }): Promise<number> {
      const off = opts.resolutionOffset ?? 6;
      const seed = opts.seed ?? USDC(1000);
      const now = nowSec();
      const { ix, marketId } = await client.createMarketIx(
        admin.publicKey,
        {
          question: `Scalar #${Math.random()} [${opts.lower},${opts.upper}]`,
          resolutionSource: "Silicon Data SDH100RT",
          closeTime: new BN(now + off),
          resolutionTime: new BN(now + off),
          resolver: opts.resolver ?? admin.publicKey,
          resolverKind: opts.resolverKind,
          oracleFeed: opts.oracleFeed,
          oracleComparison: CMP_GTE,
          oracleMaxStaleness: opts.oracleMaxStaleness !== undefined ? new BN(opts.oracleMaxStaleness) : undefined,
          marketKind: MARKET_SCALAR,
          lowerBound: new BN(opts.lower),
          upperBound: new BN(opts.upper),
        },
        usdcMint
      );
      await send([ix], admin);
      await send([await client.seedLiquidityIx(admin.publicKey, marketId, seed, usdcMint)], admin);
      return marketId;
    }

    it("create rejects an inverted scalar range", async () => {
      const now = nowSec();
      const bad = await client.createMarketIx(
        admin.publicKey,
        {
          question: "bad range",
          resolutionSource: "s",
          closeTime: new BN(now + 30),
          resolutionTime: new BN(now + 30),
          resolver: admin.publicKey,
          marketKind: MARKET_SCALAR,
          lowerBound: new BN(300),
          upperBound: new BN(200),
        },
        usdcMint
      );
      assert.match(await sendExpectFail([bad.ix], admin), /InvalidScalarRange/);
    });

    it("trusted midpoint settlement (250 in [200,300]) pays LONG and SHORT 0.5 each", async () => {
      const marketId = await createScalarMarket({ lower: 200, upper: 300 });
      const m0 = await client.fetchMarketById(marketId);
      assert.strictEqual(m0.marketKind, MARKET_SCALAR);
      assert.strictEqual(m0.lowerBound.toString(), "200");
      assert.strictEqual(m0.upperBound.toString(), "300");

      // user1 buys LONG (YES), user2 buys SHORT (NO).
      const longTokens = await buy(user1, marketId, OUTCOME_YES, USDC(200));
      const shortTokens = await buy(user2, marketId, OUTCOME_NO, USDC(200));
      await assertConservation(marketId, "scalar-seed-buy");

      // propose_outcome (binary) must be rejected on a scalar market.
      await waitChainTime(m0.resolutionTime.toNumber() + 1);
      assert.match(
        await sendExpectFail([await client.proposeOutcomeIx(admin.publicKey, marketId, OUTCOME_YES)], admin),
        /WrongMarketKind/
      );

      // Propose the midpoint and finalize after the dispute window.
      await send([await client.proposeScalarIx(admin.publicKey, marketId, new BN(250))], admin);
      const proposing = await client.fetchMarketById(marketId);
      assert.strictEqual(proposing.state, STATE_RESOLVING);
      assert.strictEqual(proposing.proposedValue.toString(), "250");

      await waitChainTime(proposing.resolvedAt.toNumber() + DISPUTE_PERIOD + 1);
      await send([await client.finalizeOutcomeIx(user2.publicKey, marketId)], user2);
      const fin = await client.fetchMarketById(marketId);
      assert.strictEqual(fin.state, STATE_RESOLVED);
      assert.strictEqual(fin.settlementFraction, 500000, "midpoint => f=0.5");

      // binary redeem must be rejected on a scalar market.
      assert.match(
        await sendExpectFail([await client.redeemIx(user1.publicKey, marketId, OUTCOME_YES, new BN(1), usdcMint)], user1),
        /WrongMarketKind/
      );

      // LONG holder redeems for amount*0.5; SHORT holder for amount*0.5.
      const u1usdc = getAssociatedTokenAddressSync(usdcMint, user1.publicKey);
      const u2usdc = getAssociatedTokenAddressSync(usdcMint, user2.publicKey);
      const u1Before = await tokenBalance(u1usdc);
      const u2Before = await tokenBalance(u2usdc);

      await send([await client.redeemScalarIx(user1.publicKey, marketId, OUTCOME_YES, longTokens, usdcMint)], user1);
      await send([await client.redeemScalarIx(user2.publicKey, marketId, OUTCOME_NO, shortTokens, usdcMint)], user2);

      const expLong = scalarPayout(longTokens, new BN(500000), true);
      const expShort = scalarPayout(shortTokens, new BN(500000), false);
      assert.strictEqual((await tokenBalance(u1usdc)).toString(), u1Before.add(expLong).toString(), "LONG payout");
      assert.strictEqual((await tokenBalance(u2usdc)).toString(), u2Before.add(expShort).toString(), "SHORT payout");
      await assertConservation(marketId, "scalar-redeem");

      // LP claims the pooled reserves at the settled fraction; vault conserves.
      await send([await client.claimPoolIx(admin.publicKey, marketId, usdcMint)], admin);
      await assertConservation(marketId, "scalar-claim");
      const after = await client.fetchMarketById(marketId);
      assert.isTrue(after.collateral.lten(4), `residual dust too large: ${after.collateral}`);
    });

    it("asymmetric settlement near the upper bound (290 => f=0.9)", async () => {
      const marketId = await createScalarMarket({ lower: 200, upper: 300 });
      const longTokens = await buy(user1, marketId, OUTCOME_YES, USDC(150));
      const shortTokens = await buy(user2, marketId, OUTCOME_NO, USDC(150));

      const m0 = await client.fetchMarketById(marketId);
      await waitChainTime(m0.resolutionTime.toNumber() + 1);
      await send([await client.proposeScalarIx(admin.publicKey, marketId, new BN(290))], admin);
      const proposing = await client.fetchMarketById(marketId);
      await waitChainTime(proposing.resolvedAt.toNumber() + DISPUTE_PERIOD + 1);
      await send([await client.finalizeOutcomeIx(user1.publicKey, marketId)], user1);
      const fin = await client.fetchMarketById(marketId);
      assert.strictEqual(fin.settlementFraction, 900000, "290 in [200,300] => f=0.9");

      const u1usdc = getAssociatedTokenAddressSync(usdcMint, user1.publicKey);
      const u2usdc = getAssociatedTokenAddressSync(usdcMint, user2.publicKey);
      const u1Before = await tokenBalance(u1usdc);
      const u2Before = await tokenBalance(u2usdc);
      await send([await client.redeemScalarIx(user1.publicKey, marketId, OUTCOME_YES, longTokens, usdcMint)], user1);
      await send([await client.redeemScalarIx(user2.publicKey, marketId, OUTCOME_NO, shortTokens, usdcMint)], user2);

      const expLong = scalarPayout(longTokens, new BN(900000), true); // 0.9 * tokens
      const expShort = scalarPayout(shortTokens, new BN(900000), false); // 0.1 * tokens
      assert.strictEqual((await tokenBalance(u1usdc)).toString(), u1Before.add(expLong).toString(), "LONG gets ~0.9");
      assert.strictEqual((await tokenBalance(u2usdc)).toString(), u2Before.add(expShort).toString(), "SHORT gets ~0.1");
      assert.isTrue(expLong.gt(expShort), "LONG payout exceeds SHORT near upper bound");
      await assertConservation(marketId, "scalar-asym-redeem");
    });

    it("clamps a settlement above the upper bound to f=PRICE_SCALE", async () => {
      const marketId = await createScalarMarket({ lower: 200, upper: 300 });
      const m0 = await client.fetchMarketById(marketId);
      await waitChainTime(m0.resolutionTime.toNumber() + 1);
      await send([await client.proposeScalarIx(admin.publicKey, marketId, new BN(500))], admin); // above upper
      const proposing = await client.fetchMarketById(marketId);
      await waitChainTime(proposing.resolvedAt.toNumber() + DISPUTE_PERIOD + 1);
      await send([await client.finalizeOutcomeIx(user1.publicKey, marketId)], user1);
      const fin = await client.fetchMarketById(marketId);
      assert.strictEqual(fin.settlementFraction, PRICE_SCALE, "value above upper clamps to PRICE_SCALE");
    });

    it("oracle-resolved scalar market maps the feed value through the bounds", async () => {
      // Publish a feed value of 270; range [200,300] => f = 0.7.
      const feed = Keypair.generate();
      await send([await client.initPriceFeedIx(admin.publicKey, feed.publicKey, "Silicon Data SDH100RT", 2)], admin, [feed]);
      await send([await client.publishPriceIx(admin.publicKey, feed.publicKey, new BN(270))], admin);

      const marketId = await createScalarMarket({
        lower: 200,
        upper: 300,
        resolverKind: RESOLVER_ORACLE_FEED,
        oracleFeed: feed.publicKey,
        oracleMaxStaleness: 3600,
      });
      const longTokens = await buy(user1, marketId, OUTCOME_YES, USDC(100));

      const m0 = await client.fetchMarketById(marketId);
      await waitChainTime(m0.resolutionTime.toNumber() + 1);
      await send([await client.proposeFromOracleIx(user2.publicKey, marketId, feed.publicKey)], user2);
      const proposing = await client.fetchMarketById(marketId);
      assert.strictEqual(proposing.state, STATE_RESOLVING);
      assert.strictEqual(proposing.proposedValue.toString(), "270", "scalar oracle stores raw feed value");

      await waitChainTime(proposing.resolvedAt.toNumber() + DISPUTE_PERIOD + 1);
      await send([await client.finalizeOutcomeIx(user2.publicKey, marketId)], user2);
      const fin = await client.fetchMarketById(marketId);
      assert.strictEqual(fin.state, STATE_RESOLVED);
      assert.strictEqual(fin.settlementFraction, 700000, "270 in [200,300] => f=0.7");

      const u1usdc = getAssociatedTokenAddressSync(usdcMint, user1.publicKey);
      const u1Before = await tokenBalance(u1usdc);
      await send([await client.redeemScalarIx(user1.publicKey, marketId, OUTCOME_YES, longTokens, usdcMint)], user1);
      const expLong = scalarPayout(longTokens, new BN(700000), true);
      assert.strictEqual((await tokenBalance(u1usdc)).toString(), u1Before.add(expLong).toString(), "LONG gets 0.7");
      await assertConservation(marketId, "scalar-oracle-redeem");
    });
  });

  describe("multi-LP liquidity", () => {
    async function fetchShares(marketId: number, owner: PublicKey): Promise<BN> {
      const m = deriveMarketAccounts(marketId).market;
      const pos = await client.fetchLiquidityPosition(m, owner);
      return pos ? pos.shares : new BN(0);
    }

    it("creator seed sets total_shares == amount and a 100% position", async () => {
      const seed = USDC(1000);
      const marketId = await createSeededMarket({ seed, resolutionOffset: 60, closeOffset: 60 });
      const m = await client.fetchMarketById(marketId);
      assert.strictEqual(m.totalShares.toString(), seed.toString(), "total_shares == seed");
      assert.strictEqual((await fetchShares(marketId, admin.publicKey)).toString(), seed.toString());
      await assertConservation(marketId, "seed");
    });

    it("second provider add_liquidity: ratio preserved, shares grow, sendback paid, conserves", async () => {
      // Seed 1000, then skew the pool with a YES buy so reserves are uneven.
      const marketId = await createSeededMarket({ seed: USDC(1000), resolutionOffset: 60, closeOffset: 60 });
      await buy(user1, marketId, OUTCOME_YES, USDC(400));

      const before = await client.fetchMarketById(marketId);
      const priceBefore = marginalPrice(before.reserveYes, before.reserveNo);
      const totalBefore = before.totalShares;

      // user2 adds liquidity.
      const addAmount = USDC(500);
      const a2 = deriveMarketAccounts(marketId);
      const u2Yes = getAssociatedTokenAddressSync(a2.yesMint, user2.publicKey);
      const u2No = getAssociatedTokenAddressSync(a2.noMint, user2.publicKey);
      const u2YesBefore = await tokenBalance(u2Yes);
      const u2NoBefore = await tokenBalance(u2No);

      await send(await client.addLiquidityIxs(user2.publicKey, marketId, addAmount, usdcMint), user2);
      await assertConservation(marketId, "add-liquidity");

      const after = await client.fetchMarketById(marketId);
      const priceAfter = marginalPrice(after.reserveYes, after.reserveNo);
      // Price ratio preserved within a tiny rounding tolerance.
      assert.isBelow(Math.abs(priceAfter - priceBefore), 1e-4, `price drift ${priceBefore}->${priceAfter}`);
      // total_shares grew.
      assert.isTrue(after.totalShares.gt(totalBefore), "total_shares grew");
      // user2 has a non-zero position.
      const u2Shares = await fetchShares(marketId, user2.publicKey);
      assert.isTrue(u2Shares.gtn(0), "user2 got shares");
      // user2 received sendback outcome tokens on the cheaper side(s) (at least one
      // side > 0 for a skewed pool).
      const u2YesGot = (await tokenBalance(u2Yes)).sub(u2YesBefore);
      const u2NoGot = (await tokenBalance(u2No)).sub(u2NoBefore);
      assert.isTrue(u2YesGot.add(u2NoGot).gtn(0), "user2 got sendback tokens");
      // Collateral grew by exactly the deposit.
      assert.strictEqual(after.collateral.sub(before.collateral).toString(), addAmount.toString());
    });

    it("two LPs claim pro-rata after resolution; pool drains; vault ends at fees", async () => {
      const marketId = await createSeededMarket({ seed: USDC(1000), resolutionOffset: 8, closeOffset: 8 });
      // user2 adds, then trades happen.
      await send(await client.addLiquidityIxs(user2.publicKey, marketId, USDC(1000), usdcMint), user2);
      await buy(user1, marketId, OUTCOME_YES, USDC(300));
      await buy(user1, marketId, OUTCOME_NO, USDC(150));

      const before = await client.fetchMarketById(marketId);
      const adminShares = await fetchShares(marketId, admin.publicKey);
      const u2Shares = await fetchShares(marketId, user2.publicKey);
      assert.strictEqual(
        adminShares.add(u2Shares).toString(),
        before.totalShares.toString(),
        "all shares accounted for"
      );

      // Resolve YES.
      await waitChainTime(before.resolutionTime.toNumber() + 1);
      await send([await client.proposeOutcomeIx(admin.publicKey, marketId, OUTCOME_YES)], admin);
      const proposed = await client.fetchMarketById(marketId);
      await waitChainTime(proposed.resolvedAt.toNumber() + DISPUTE_PERIOD + 1);
      await send([await client.finalizeOutcomeIx(user1.publicKey, marketId)], user1);

      // Both providers claim. Each LP's slice is computed by the program against
      // the LIVE reserve/total at claim time, so the first claimer shrinks both
      // for the second. Capture the winning reserve before any claim for the
      // aggregate-conservation check.
      const adminUsdc = getAssociatedTokenAddressSync(usdcMint, admin.publicKey);
      const u2Usdc = getAssociatedTokenAddressSync(usdcMint, user2.publicKey);
      const adminUsdcBefore = await tokenBalance(adminUsdc);
      const u2UsdcBefore = await tokenBalance(u2Usdc);
      const resolved = await client.fetchMarketById(marketId);
      const winReserveBefore = resolved.reserveYes; // YES won

      // Admin claims first against the full pool.
      const mAdmin = await client.fetchMarketById(marketId);
      const adminExpected = mAdmin.reserveYes.mul(adminShares).div(mAdmin.totalShares);
      await send([await client.claimPoolIx(admin.publicKey, marketId, usdcMint)], admin);
      await assertConservation(marketId, "claim-admin");

      // user2 claims against the reduced pool (admin's slice already removed).
      const mU2 = await client.fetchMarketById(marketId);
      const u2Expected = mU2.reserveYes.mul(u2Shares).div(mU2.totalShares);
      await send([await client.claimPoolIx(user2.publicKey, marketId, usdcMint)], user2);
      await assertConservation(marketId, "claim-user2");

      const adminGot = (await tokenBalance(adminUsdc)).sub(adminUsdcBefore);
      const u2Got = (await tokenBalance(u2Usdc)).sub(u2UsdcBefore);
      assert.strictEqual(adminGot.toString(), adminExpected.toString(), "admin pro-rata claim");
      assert.strictEqual(u2Got.toString(), u2Expected.toString(), "user2 pro-rata claim");
      // Sum of claims never exceeds the original winning reserve (floor dust may remain).
      assert.isTrue(adminGot.add(u2Got).lte(winReserveBefore), "claims <= backed collateral");

      // Positions zeroed, total_shares drained.
      assert.strictEqual((await fetchShares(marketId, admin.publicKey)).toString(), "0");
      assert.strictEqual((await fetchShares(marketId, user2.publicKey)).toString(), "0");
      const drained = await client.fetchMarketById(marketId);
      assert.strictEqual(drained.totalShares.toString(), "0", "all shares burned");

      // Let any remaining winning-token holder redeem, collect fees, vault -> 0..fee.
      await send([await client.collectFeesIx(admin.publicKey, marketId, usdcMint)], admin);
      const end = await client.fetchMarketById(marketId);
      assert.strictEqual(end.feeAccrued.toString(), "0", "fees collected");
    });

    it("remove_liquidity returns proportional YES+NO and decrements shares", async () => {
      const marketId = await createSeededMarket({ seed: USDC(1000), resolutionOffset: 60, closeOffset: 60 });
      await send(await client.addLiquidityIxs(user2.publicKey, marketId, USDC(1000), usdcMint), user2);
      await buy(user1, marketId, OUTCOME_YES, USDC(200)); // skew it

      const m = await client.fetchMarketById(marketId);
      const u2Shares = await fetchShares(marketId, user2.publicKey);
      const half = u2Shares.divn(2);
      const expYes = m.reserveYes.mul(half).div(m.totalShares);
      const expNo = m.reserveNo.mul(half).div(m.totalShares);

      const a2 = deriveMarketAccounts(marketId);
      const u2Yes = getAssociatedTokenAddressSync(a2.yesMint, user2.publicKey);
      const u2No = getAssociatedTokenAddressSync(a2.noMint, user2.publicKey);
      const u2YesBefore = await tokenBalance(u2Yes);
      const u2NoBefore = await tokenBalance(u2No);

      await send(await client.removeLiquidityIxs(user2.publicKey, marketId, half), user2);
      await assertConservation(marketId, "remove-liquidity"); // collateral unchanged

      assert.strictEqual((await tokenBalance(u2Yes)).sub(u2YesBefore).toString(), expYes.toString(), "YES out");
      assert.strictEqual((await tokenBalance(u2No)).sub(u2NoBefore).toString(), expNo.toString(), "NO out");
      assert.strictEqual(
        (await fetchShares(marketId, user2.publicKey)).toString(),
        u2Shares.sub(half).toString(),
        "shares decremented"
      );
    });

    it("no value extraction: add then immediately remove returns <= deposited value", async () => {
      const marketId = await createSeededMarket({ seed: USDC(1000), resolutionOffset: 60, closeOffset: 60 });
      await buy(user1, marketId, OUTCOME_YES, USDC(350)); // skew before user2 enters

      const a2 = deriveMarketAccounts(marketId);
      const u2Yes = getAssociatedTokenAddressSync(a2.yesMint, user2.publicKey);
      const u2No = getAssociatedTokenAddressSync(a2.noMint, user2.publicKey);
      const yes0 = await tokenBalance(u2Yes);
      const no0 = await tokenBalance(u2No);

      const addAmount = USDC(500);
      await send(await client.addLiquidityIxs(user2.publicKey, marketId, addAmount, usdcMint), user2);
      const minted = await fetchShares(marketId, user2.publicKey);
      // Immediately remove ALL minted shares.
      await send(await client.removeLiquidityIxs(user2.publicKey, marketId, minted), user2);
      await assertConservation(marketId, "extract-roundtrip");

      // user2 now holds (sendback + slice) of each side. The collateral they can
      // reconstruct by merging full YES+NO sets is min(totalYes,totalNo); it must
      // not exceed the addAmount they deposited.
      const yesHeld = (await tokenBalance(u2Yes)).sub(yes0);
      const noHeld = (await tokenBalance(u2No)).sub(no0);
      const mergeable = BN.min(yesHeld, noHeld);
      assert.isTrue(
        mergeable.lte(addAmount),
        `extracted value ${mergeable} > deposited ${addAmount}`
      );
      // Position fully drained.
      assert.strictEqual((await fetchShares(marketId, user2.publicKey)).toString(), "0");
    });

    it("rejects add to an unseeded market (NoLiquidity)", async () => {
      const now = nowSec();
      const { ix, marketId } = await client.createMarketIx(
        admin.publicKey,
        {
          question: `Unseeded #${Math.random()}`,
          resolutionSource: "Silicon Data SDH100RT",
          closeTime: new BN(now + 60),
          resolutionTime: new BN(now + 60),
          resolver: admin.publicKey,
        },
        usdcMint
      );
      await send([ix], admin);
      // No seed -> pools don't exist; the address constraint on pool_yes fails
      // (market.pool_yes is default) OR NoLiquidity. Either way it must revert.
      const msg = await sendExpectFail(
        await client.addLiquidityIxs(user2.publicKey, marketId, USDC(100), usdcMint),
        user2
      );
      assert.match(msg, /NoLiquidity|AccountNotInitialized|ConstraintAddress|Error/);
    });

    it("rejects remove of more shares than owned (InsufficientShares)", async () => {
      const marketId = await createSeededMarket({ seed: USDC(1000), resolutionOffset: 60, closeOffset: 60 });
      await send(await client.addLiquidityIxs(user2.publicKey, marketId, USDC(500), usdcMint), user2);
      const u2Shares = await fetchShares(marketId, user2.publicKey);
      const tooMany = u2Shares.addn(1);
      const msg = await sendExpectFail(
        await client.removeLiquidityIxs(user2.publicKey, marketId, tooMany),
        user2
      );
      assert.match(msg, /InsufficientShares/);
    });

    it("rejects a dust add that would mint 0 shares (ZeroAmount)", async () => {
      // Inflate the pool weight so a 1-unit add floors to 0 shares minted.
      const marketId = await createSeededMarket({ seed: USDC(1000), resolutionOffset: 60, closeOffset: 60 });
      // weight ~1e9; adding 1 base unit => shares = floor(1 * 1e9 / 1e9) = 1, not 0.
      // To force 0, grow the weight above total_shares via a large add then a tiny add.
      // Simpler: a 1-unit add when weight > total_shares yields 0. Skew so reserve max
      // exceeds total_shares: buy pushes one reserve far up.
      await buy(user1, marketId, OUTCOME_NO, USDC(800));
      const m = await client.fetchMarketById(marketId);
      // weight = max(reserveYes,reserveNo) > total_shares now; a 1-unit add floors to 0.
      assert.isTrue(
        Math.max(m.reserveYes.toNumber(), m.reserveNo.toNumber()) > m.totalShares.toNumber(),
        "weight should exceed total_shares"
      );
      const msg = await sendExpectFail(
        await client.addLiquidityIxs(user2.publicKey, marketId, new BN(1), usdcMint),
        user2
      );
      assert.match(msg, /ZeroAmount/);
    });
  });

  describe("fee-to-LP routing", () => {
    const LP_FEE_BPS = 5000; // 50% of each taker fee reinvested into the pool

    /** TS mirror of `lp_fee_cut`: floor(fee * lpFeeBps / 10000). */
    const lpFeeCut = (fee: BN, lpFeeBps: number) => fee.muln(lpFeeBps).divn(10_000);

    before(async () => {
      // `initialize` ran once globally with lp_fee_bps = 0; drive it for this
      // suite. Restored to 0 in `after` so the other suites are unaffected.
      await send([await client.setLpFeeBpsIx(admin.publicKey, LP_FEE_BPS)], admin);
      assert.strictEqual((await client.fetchConfig()).lpFeeBps, LP_FEE_BPS);
    });

    after(async () => {
      await send([await client.setLpFeeBpsIx(admin.publicKey, 0)], admin);
      assert.strictEqual((await client.fetchConfig()).lpFeeBps, 0);
    });

    it("buy: protocol gets its cut, both reserves grow by lp_cut, conserves", async () => {
      const marketId = await createSeededMarket({ seed: USDC(1000), resolutionOffset: 60, closeOffset: 60 });
      const before = await client.fetchMarketById(marketId);

      const collateralIn = USDC(100);
      const fee = feeAmount(collateralIn, FEE_BPS);
      const lpCut = lpFeeCut(fee, LP_FEE_BPS);
      const protocolCut = fee.sub(lpCut);
      const a = collateralIn.sub(fee);
      // The trade quotes on `a`; the lp_cut full set is minted AFTER the swap, so
      // the new reserves = post-swap reserves + lp_cut on each side.
      const q = quoteBuy(before.reserveYes, before.reserveNo, a);

      await send(
        await client.buyIxs(user1.publicKey, marketId, OUTCOME_YES, collateralIn, q.tokensOut, usdcMint),
        user1
      );

      const after = await client.fetchMarketById(marketId);
      assert.strictEqual(
        after.feeAccrued.sub(before.feeAccrued).toString(),
        protocolCut.toString(),
        "fee_accrued increased by the protocol cut only"
      );
      assert.strictEqual(
        after.reserveYes.sub(q.newReserveBought).toString(),
        lpCut.toString(),
        "YES reserve grew by lp_cut beyond the swap result"
      );
      assert.strictEqual(
        after.reserveNo.sub(q.newReserveOther).toString(),
        lpCut.toString(),
        "NO reserve grew by lp_cut beyond the swap result"
      );
      assert.isTrue(lpCut.gtn(0), "sanity: lp_cut is non-zero for this trade");
      await assertConservation(marketId, "buy-lp-fee");
    });

    it("sell: both reserves grow by lp_cut and conserves", async () => {
      const marketId = await createSeededMarket({ seed: USDC(1000), resolutionOffset: 60, closeOffset: 60 });
      // Give user1 a YES position to sell back.
      await buy(user1, marketId, OUTCOME_YES, USDC(300));

      const before = await client.fetchMarketById(marketId);
      const out = USDC(50);
      const fee = feeAmount(out, FEE_BPS);
      const lpCut = lpFeeCut(fee, LP_FEE_BPS);
      const q = quoteSell(before.reserveYes, before.reserveNo, out)!;

      await send([await client.sellIx(user1.publicKey, marketId, OUTCOME_YES, out, q.tokensIn, usdcMint)], user1);

      const after = await client.fetchMarketById(marketId);
      // Post-swap reserves are (newReserveSold, newReserveOther); the lp_cut full
      // set is then minted into BOTH, so each grows by exactly lp_cut.
      assert.strictEqual(
        after.reserveYes.sub(q.newReserveSold).toString(),
        lpCut.toString(),
        "YES (sold) reserve grew by lp_cut beyond the swap result"
      );
      assert.strictEqual(
        after.reserveNo.sub(q.newReserveOther).toString(),
        lpCut.toString(),
        "NO (other) reserve grew by lp_cut beyond the swap result"
      );
      assert.isTrue(lpCut.gtn(0), "sanity: lp_cut is non-zero for this trade");
      await assertConservation(marketId, "sell-lp-fee");
    });

    it("LPs actually earn: the sole LP claims back MORE than they seeded", async () => {
      // The creator (admin) is the sole LP. After a batch of taker trades at
      // lp_fee_bps > 0, their pro-rata claim must exceed the seed principal.
      const seed = USDC(1000);
      // Short window: the churn below finishes well within `closeOffset`, and the
      // resolution wait then lands inside `waitChainTime`'s poll budget.
      const marketId = await createSeededMarket({ seed, resolutionOffset: 25, closeOffset: 25 });

      // Churn several buys/sells by other users so fees (and the LP cut) accrue.
      for (let i = 0; i < 3; i++) {
        await buy(user1, marketId, OUTCOME_YES, USDC(120));
        await buy(user2, marketId, OUTCOME_NO, USDC(120));
        // Sell a little back from each (they hold the side they bought).
        const my = await client.fetchMarketById(marketId);
        const sYes = quoteSell(my.reserveYes, my.reserveNo, USDC(30));
        if (sYes) await send([await client.sellIx(user1.publicKey, marketId, OUTCOME_YES, USDC(30), sYes.tokensIn, usdcMint)], user1);
        const mn = await client.fetchMarketById(marketId);
        const sNo = quoteSell(mn.reserveNo, mn.reserveYes, USDC(30));
        if (sNo) await send([await client.sellIx(user2.publicKey, marketId, OUTCOME_NO, USDC(30), sNo.tokensIn, usdcMint)], user2);
        await assertConservation(marketId, `churn-${i}`);
      }

      // Resolve so the LP can claim their reserves as collateral. Use a void so
      // BOTH sides of the slice pay out (half each) — this realizes the fee
      // reinvestment regardless of which side won.
      const m = await client.fetchMarketById(marketId);
      await waitChainTime(m.resolutionTime.toNumber() + 1);
      await send([await client.proposeOutcomeIx(admin.publicKey, marketId, OUTCOME_YES)], admin);
      await send([await client.disputeVoidIx(guardian.publicKey, marketId)], guardian);
      assert.strictEqual((await client.fetchMarketById(marketId)).state, STATE_VOID);

      const adminUsdc = getAssociatedTokenAddressSync(usdcMint, admin.publicKey);
      const usdcBefore = await tokenBalance(adminUsdc);
      await send([await client.claimPoolIx(admin.publicKey, marketId, usdcMint)], admin);
      const payout = (await tokenBalance(adminUsdc)).sub(usdcBefore);

      assert.isTrue(
        payout.gt(seed),
        `LP payout ${payout} should exceed seed principal ${seed} (earned the reinvested fee cuts)`
      );
      await assertConservation(marketId, "lp-earns-claim");
    });

    it("rejects setLpFeeBps > 10000 and a non-admin caller", async () => {
      assert.match(
        await sendExpectFail([await client.setLpFeeBpsIx(admin.publicKey, 10_001)], admin),
        /InvalidParameter/
      );
      assert.match(
        await sendExpectFail([await client.setLpFeeBpsIx(user1.publicKey, 100)], user1),
        /Unauthorized/
      );
      // The valid value set in `before` is unchanged after the failed calls.
      assert.strictEqual((await client.fetchConfig()).lpFeeBps, LP_FEE_BPS);
    });
  });
});
