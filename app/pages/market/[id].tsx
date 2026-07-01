import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getAccount,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";

import TopBar from "../../components/TopBar";
import { ProbBar } from "../index";
import { RPC_URL } from "../../components/WalletProviders";
import { useComputeClient, useReadClient } from "../../components/useComputeClient";
import { useNow, marketStateLabel, StateBadge, CopyKey } from "../../components/ui";
import { useToasts } from "../../components/tx";
import PriceChart from "../../components/PriceChart";
import { fetchPriceHistory, type PricePoint } from "../../components/history";
import type {
  MarketAccount,
  ConfigAccount,
  LiquidityPositionAccount,
  PriceFeedAccount,
} from "../../components/types";
import {
  type Side,
  isScalar,
  marketKindLabel,
  resolverKindLabel,
  resolverKindClass,
  outcomeLabel,
  comparisonLabel,
  impliedScalarValue,
  settledScalarValue,
  settledLongFraction,
  fractionForValue,
} from "../../components/market";
import {
  formatUnits,
  parseUnits,
  formatPct,
  formatAbsTime,
  formatRelTime,
  formatCountdown,
  clusterFromRpc,
  explorerTxUrl,
} from "../../lib/format";
import {
  marginalPrice,
  quoteBuy,
  quoteSell,
  feeAmount,
  minOutWithSlippage,
  maxInWithSlippage,
  scalarPayout,
} from "../../lib/amm";
import {
  OUTCOME_YES,
  OUTCOME_NO,
  STATE_OPEN,
  STATE_RESOLVING,
  STATE_RESOLVED,
  STATE_VOID,
  RESOLVER_TRUSTED_KEY,
  RESOLVER_ORACLE_FEED,
  RESOLVER_OPTIMISTIC,
  marketPda,
} from "../../lib/pdas";

interface Balances {
  usdc: BN;
  yes: BN;
  no: BN;
}

const ZERO = new BN(0);
const MAX_SLIPPAGE = 0.5; // 50%
const HIGH_SLIPPAGE = 0.05; // warn above ~5%

function fmtNum(n: number): string {
  return Number.isFinite(n) ? parseFloat(n.toFixed(2)).toString() : "—";
}

/**
 * num/den as a JS float, safe for large BN inputs. Scales to 1e6 fixed-point via
 * BN division FIRST (result is bounded), so `.toNumber()` never exceeds 2^53 even
 * when num/den are huge (avoids the bn.js 53-bit assert crash on big inputs).
 */
function safeRatio(num: BN, den: BN): number {
  if (den.isZero()) return 0;
  return num.mul(new BN(1_000_000)).div(den).toNumber() / 1_000_000;
}

/**
 * Record a buy fill to the local cost-basis ledger so the portfolio can show
 * P&L on positions opened through this UI. Best-effort (localStorage may be
 * unavailable); bounded to the most recent 500 fills.
 */
function recordFill(marketPk: string, side: number, cost: BN, tokens: BN) {
  try {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("compute:fills");
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return;
    arr.push({
      market: marketPk,
      side,
      cost: cost.toString(),
      tokens: tokens.toString(),
      ts: Math.floor(Date.now() / 1000),
    });
    window.localStorage.setItem(
      "compute:fills",
      JSON.stringify(arr.slice(-500))
    );
  } catch {
    /* ignore */
  }
}

/** Parse a signed integer string (scalar bounds/values are i64, no decimals). */
function parseIntBN(input: string): BN | null {
  const s = input.trim();
  if (s === "" || !/^-?\d+$/.test(s)) return null;
  try {
    return new BN(s);
  } catch {
    return null;
  }
}

export default function MarketPage() {
  const router = useRouter();
  const { id } = router.query;
  const rawId = typeof id === "string" ? id : undefined;
  // Validate the route param BEFORE constructing a BN.
  const idValid = rawId !== undefined && /^\d+$/.test(rawId);

  const { connection } = useConnection();
  const wallet = useWallet();
  const readClient = useReadClient();
  const client = useComputeClient(); // null until connected
  const now = useNow();

  const [market, setMarket] = useState<MarketAccount | null>(null);
  const [config, setConfig] = useState<ConfigAccount | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [lpPosition, setLpPosition] = useState<LiquidityPositionAccount | null>(null);
  const [feed, setFeed] = useState<PriceFeedAccount | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // tx feedback shared across panels
  const [busy, setBusy] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadMarket = useCallback(async () => {
    if (rawId === undefined) return;
    if (!idValid) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    setNotFound(false);
    try {
      const idBn = new BN(rawId);
      const [m, cfg] = await Promise.all([
        readClient.fetchMarketById(idBn) as unknown as Promise<MarketAccount>,
        readClient.fetchConfig() as unknown as Promise<ConfigAccount>,
      ]);
      setMarket(m);
      setConfig(cfg);
      // Oracle markets: fetch the configured feed's current value.
      if (m.resolverKind === RESOLVER_ORACLE_FEED && !m.oracleFeed.equals(PublicKey.default)) {
        try {
          const f = (await readClient.fetchPriceFeed(m.oracleFeed)) as unknown as PriceFeedAccount;
          setFeed(f);
          setFeedError(null);
        } catch (e: any) {
          setFeed(null);
          setFeedError(readClient.parseError(e));
        }
      } else {
        setFeed(null);
        setFeedError(null);
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      // Anchor throws "Account does not exist" when the PDA is uninitialized.
      if (/does not exist|Account does not exist|could not find/i.test(msg)) {
        setNotFound(true);
      } else {
        setLoadError(readClient.parseError(e));
      }
      setMarket(null);
    } finally {
      setLoading(false);
    }
  }, [rawId, idValid, readClient]);

  const loadBalances = useCallback(async () => {
    if (!market || !wallet.publicKey) {
      setBalances(null);
      setLpPosition(null);
      return;
    }
    const owner = wallet.publicKey;
    const read = async (mint: PublicKey): Promise<BN> => {
      try {
        const ata = getAssociatedTokenAddressSync(mint, owner);
        const acc = await getAccount(connection, ata);
        return new BN(acc.amount.toString());
      } catch (e) {
        if (e instanceof TokenAccountNotFoundError) return ZERO;
        return ZERO;
      }
    };
    const [usdc, yes, no, pos] = await Promise.all([
      read(market.collateralMint),
      read(market.yesMint),
      read(market.noMint),
      readClient.fetchLiquidityPosition(
        marketAddr(market),
        owner
      ) as unknown as Promise<LiquidityPositionAccount | null>,
    ]);
    setBalances({ usdc, yes, no });
    setLpPosition(pos);
  }, [market, wallet.publicKey, connection, readClient]);

  useEffect(() => {
    loadMarket();
  }, [loadMarket]);

  useEffect(() => {
    loadBalances();
  }, [loadBalances]);

  // The market PDA (for live subscription + history).
  const marketPubkey = useMemo(
    () => (idValid && rawId !== undefined ? marketPda(new BN(rawId))[0] : null),
    [idValid, rawId]
  );

  // Price history (from TradeExecuted events) for the chart.
  const [history, setHistory] = useState<PricePoint[]>([]);
  const loadHistory = useCallback(async () => {
    if (!marketPubkey) return;
    try {
      const pts = await fetchPriceHistory(readClient.program, marketPubkey);
      setHistory(pts);
    } catch {
      /* history is best-effort */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketPubkey?.toBase58(), readClient]);
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const refreshAll = useCallback(async () => {
    await loadMarket();
    await loadBalances();
    await loadHistory();
  }, [loadMarket, loadBalances, loadHistory]);

  // Real-time: keep the market ticking and grow the chart as trades land.
  useEffect(() => {
    if (!marketPubkey) return;
    const sub = connection.onAccountChange(
      marketPubkey,
      async () => {
        try {
          const m = (await readClient.program.account.market.fetch(
            marketPubkey
          )) as unknown as MarketAccount;
          setMarket(m);
          const yesPrice = marginalPrice(m.reserveYes, m.reserveNo);
          setHistory((h) => {
            const next = [
              ...h,
              { time: Math.floor(Date.now() / 1000), price: Math.min(0.999, Math.max(0.001, yesPrice)) },
            ];
            // Cap the series so a long-open page doesn't grow unbounded.
            return next.length > 500 ? next.slice(-500) : next;
          });
        } catch {
          /* ignore transient decode errors */
        }
      },
      { commitment: "confirmed" }
    );
    return () => {
      connection.removeAccountChangeListener(sub);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketPubkey?.toBase58(), connection, readClient]);

  // Send a transaction built from instructions, then refresh.
  const sendIxs = useCallback(
    async (ixs: TransactionInstruction[]) => {
      if (!wallet.publicKey || !wallet.sendTransaction) {
        throw new Error("Wallet not connected");
      }
      const tx = new Transaction().add(...ixs);
      tx.feePayer = wallet.publicKey;
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      const sig = await wallet.sendTransaction(tx, connection);
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      return sig;
    },
    [wallet, connection]
  );

  const { push, update } = useToasts();
  const runAction = useCallback(
    async (
      build: () => Promise<TransactionInstruction[]>,
      label = "Transaction"
    ) => {
      setBusy(true);
      setTxError(null);
      setTxSig(null);
      const id = push({ label, status: "building" });
      try {
        const ixs = await build();
        update(id, { status: "signing" });
        const sig = await sendIxs(ixs);
        update(id, { status: "success", sig });
        setTxSig(sig);
        // Celebrate a successful claim/redeem.
        if (/claim|redeem/i.test(label)) {
          import("canvas-confetti")
            .then((m) =>
              m.default({ particleCount: 90, spread: 70, origin: { y: 0.7 } })
            )
            .catch(() => {});
        }
        await refreshAll();
        return sig;
      } catch (e: any) {
        const msg = client ? client.parseError(e) : readClient.parseError(e);
        update(id, { status: "error", message: msg });
        setTxError(msg);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [sendIxs, refreshAll, client, readClient, push, update]
  );

  const copySig = useCallback(async () => {
    if (!txSig) return;
    try {
      await navigator.clipboard.writeText(txSig);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  }, [txSig]);

  // ---- invalid id (vs not found) ----
  if (rawId !== undefined && !idValid) {
    return (
      <div className="container">
        <TopBar />
        <p>
          <Link href="/">← Back to markets</Link>
        </p>
        <div className="notice err">Invalid market id: “{rawId}”.</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="container">
        <TopBar />
        <div className="skel-card" aria-hidden="true">
          <div className="skel line" style={{ width: "60%", height: 18 }} />
          <div className="skel line" style={{ width: "35%" }} />
          <div className="skel bar" />
          <div className="skel line" style={{ width: "50%" }} />
          <div className="skel line" style={{ width: "45%" }} />
          <div className="skel line" style={{ width: "55%", marginBottom: 0 }} />
        </div>
        <div className="small muted" style={{ marginTop: 12 }}>
          Loading market…
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="container">
        <TopBar />
        <p>
          <Link href="/">← Back to markets</Link>
        </p>
        <div className="notice info">Market #{rawId} not found on this cluster.</div>
      </div>
    );
  }

  if (loadError || !market) {
    return (
      <div className="container">
        <TopBar />
        <p>
          <Link href="/">← Back to markets</Link>
        </p>
        <div className="notice err">
          Could not load market {rawId}: {loadError ?? "not found"}
        </div>
      </div>
    );
  }

  const scalar = isScalar(market);
  const closeTime = market.closeTime.toNumber();
  const resolutionTime = market.resolutionTime.toNumber();
  const resolvedAt = market.resolvedAt.toNumber();
  const disputePeriod = config?.disputePeriod.toNumber() ?? 0;
  const disputeEnd = resolvedAt + disputePeriod;

  const state = market.state;
  const isOpen = state === STATE_OPEN;
  const isResolving = state === STATE_RESOLVING;
  const isResolved = state === STATE_RESOLVED;
  const isVoid = state === STATE_VOID;

  const tradingClosed = isOpen && now >= closeTime;
  const tradingEnabled = isOpen && now < closeTime;

  const label = marketStateLabel(state, closeTime, now);
  // YES=LONG, NO=SHORT for scalar markets.
  const longPrice = marginalPrice(market.reserveYes, market.reserveNo);
  const shortPrice = marginalPrice(market.reserveNo, market.reserveYes);
  const feeBps = config?.feeBps ?? 0;
  const impliedVal = scalar
    ? impliedScalarValue(longPrice, market.lowerBound, market.upperBound)
    : 0;
  const settledVal = isResolved ? settledScalarValue(market) : null;

  const me = wallet.publicKey;
  const isResolver = me != null && market.resolver.equals(me);
  const isGuardian = me != null && config != null && config.guardian.equals(me);
  const isLp = me != null && market.lp.equals(me);
  const pastResolution = now >= resolutionTime;
  const disputeWindowOpen = isResolving && now < disputeEnd;
  const canFinalize = isResolving && now >= disputeEnd;

  const txExplorer = txSig ? explorerTxUrl(txSig, RPC_URL) : null;

  return (
    <div className="container">
      <TopBar />
      <p style={{ marginTop: -8 }}>
        <Link href="/">← Back to markets</Link>
      </p>

      <div className="card">
        <div className="flex-between">
          <h2 style={{ margin: 0 }}>{market.question}</h2>
          <StateBadge label={label} />
        </div>
        <div className="kindrow" style={{ marginTop: 8 }}>
          <span className={`badge kind ${scalar ? "scalar" : "binary"}`}>
            {marketKindLabel(market.marketKind)}
            {scalar && (
              <>
                {" "}
                [{fmtNum(market.lowerBound.toNumber())},{" "}
                {fmtNum(market.upperBound.toNumber())}]
              </>
            )}
          </span>
          <span className={`badge resolver ${resolverKindClass(market.resolverKind)}`}>
            {resolverKindLabel(market.resolverKind)}
          </span>
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          Resolution source: {market.resolutionSource || "—"}
        </div>
        <div className="small muted" style={{ marginTop: 2 }}>
          Market #{market.marketId.toString()} · fee {(feeBps / 100).toFixed(2)}%
        </div>

        <ProbBar
          long={longPrice}
          short={shortPrice}
          yesLabel={scalar ? "LONG" : "YES"}
          noLabel={scalar ? "SHORT" : "NO"}
        />
        <div className="prices">
          <div className="price-pill yes">
            <div className="lab">{scalar ? "LONG price" : "YES price"}</div>
            <div className="val">{formatPct(longPrice)}</div>
          </div>
          <div className="price-pill no">
            <div className="lab">{scalar ? "SHORT price" : "NO price"}</div>
            <div className="val">{formatPct(shortPrice)}</div>
          </div>
        </div>
        {scalar && (
          <div className="kv">
            <span className="k">
              {settledVal != null ? "Settled value" : "Implied value"}
            </span>
            <span>
              {settledVal != null ? fmtNum(settledVal) : fmtNum(impliedVal)} (range{" "}
              {fmtNum(market.lowerBound.toNumber())}–
              {fmtNum(market.upperBound.toNumber())})
            </span>
          </div>
        )}
        <div className="kv">
          <span className="k">Reserve {scalar ? "LONG" : "YES"}</span>
          <span>{formatUnits(market.reserveYes)}</span>
        </div>
        <div className="kv">
          <span className="k">Reserve {scalar ? "SHORT" : "NO"}</span>
          <span>{formatUnits(market.reserveNo)}</span>
        </div>
        <div className="kv">
          <span className="k">Collateral (TVL)</span>
          <span>{formatUnits(market.collateral)} USDC</span>
        </div>
        <div className="kv">
          <span className="k">Pool shares (total)</span>
          <span>{formatUnits(market.totalShares)}</span>
        </div>
        <div className="kv">
          <span className="k">Closes</span>
          <span title={formatAbsTime(market.closeTime)}>
            {formatAbsTime(market.closeTime)} ({formatRelTime(market.closeTime, now)})
          </span>
        </div>
        <div className="kv">
          <span className="k">Resolves</span>
          <span title={formatAbsTime(market.resolutionTime)}>
            {formatAbsTime(market.resolutionTime)} (
            {formatRelTime(market.resolutionTime, now)})
          </span>
        </div>
        {isResolved && !scalar && (
          <div className="kv">
            <span className="k">Winning outcome</span>
            <span>{market.outcome === OUTCOME_YES ? "YES" : "NO"}</span>
          </div>
        )}
        {isResolved && scalar && (
          <div className="kv">
            <span className="k">Settled fraction (LONG)</span>
            <span>
              {formatPct((settledLongFraction(market) ?? 0))} · value{" "}
              {settledVal != null ? fmtNum(settledVal) : "—"}
            </span>
          </div>
        )}
        {isVoid && (
          <div className="kv">
            <span className="k">Outcome</span>
            <span>Voided — 50/50 refund</span>
          </div>
        )}
      </div>

      {/* Price history chart */}
      <div className="card">
        <div className="flex-between" style={{ marginBottom: 8 }}>
          <strong>Price history</strong>
          <span className="small muted">
            {scalar ? "LONG probability" : "YES probability"} over time
          </span>
        </div>
        <PriceChart points={history} />
      </div>

      {/* Config / protocol panel */}
      <ConfigPanel config={config} />

      {/* Trust / risk panel */}
      <TrustPanel
        market={market}
        config={config}
        disputePeriod={disputePeriod}
      />

      {/* Wallet balances */}
      <div className="card">
        <div className="flex-between">
          <strong>Your balances</strong>
          <button
            className="btn secondary small"
            onClick={loadBalances}
            disabled={!wallet.publicKey}
          >
            Refresh
          </button>
        </div>
        {!wallet.publicKey ? (
          <div className="small muted" style={{ marginTop: 8 }}>
            Connect a wallet to trade.
          </div>
        ) : balances ? (
          <>
            <div className="kv">
              <span className="k">USDC</span>
              <span>{formatUnits(balances.usdc)}</span>
            </div>
            <div className="kv">
              <span className="k">{scalar ? "LONG" : "YES"} tokens</span>
              <span>{formatUnits(balances.yes)}</span>
            </div>
            <div className="kv">
              <span className="k">{scalar ? "SHORT" : "NO"} tokens</span>
              <span>{formatUnits(balances.no)}</span>
            </div>
            <div className="kv">
              <span className="k">Your LP shares</span>
              <span>{formatUnits(lpPosition?.shares ?? ZERO)}</span>
            </div>
          </>
        ) : (
          <div className="small muted" style={{ marginTop: 8 }}>
            Loading…
          </div>
        )}
      </div>

      {/* Shared tx feedback */}
      {txError && (
        <div className="notice err" role="alert">
          Transaction failed: {txError}
        </div>
      )}
      {txSig && (
        <div className="notice ok" role="status">
          <div>Transaction confirmed.</div>
          <div className="small" style={{ marginTop: 6 }}>
            <span className="mono">{txSig}</span>{" "}
            <button type="button" className="copybtn" onClick={copySig}>
              {copied ? "✓ copied" : "copy"}
            </button>
            {txExplorer && (
              <>
                {" · "}
                <a href={txExplorer} target="_blank" rel="noreferrer">
                  view on explorer
                </a>
              </>
            )}
          </div>
        </div>
      )}

      {/* Trading (OPEN only) */}
      {isOpen && (
        <>
          {tradingClosed && (
            <div className="notice info">
              Trading is <strong>closed</strong> — this market passed its close time
              ({formatAbsTime(market.closeTime)}). Awaiting resolution.
            </div>
          )}
          <BuyPanel
            market={market}
            scalar={scalar}
            feeBps={feeBps}
            balances={balances}
            busy={busy}
            canTrade={!!client && !!wallet.publicKey && tradingEnabled}
            tradingClosed={tradingClosed}
            onBuy={(side, collateralIn, minTokensOut) =>
              runAction(
                () =>
                  client!.buyIxs(
                    wallet.publicKey!,
                    market.marketId,
                    side,
                    collateralIn,
                    minTokensOut,
                    market.collateralMint
                  ),
                `Buy ${outcomeLabel(side, scalar)} · Market #${market.marketId.toString()}`
              ).then((sig) => {
                if (sig && marketPubkey) {
                  recordFill(
                    marketPubkey.toBase58(),
                    side,
                    collateralIn,
                    minTokensOut
                  );
                }
              })
            }
          />
          <SellPanel
            market={market}
            scalar={scalar}
            feeBps={feeBps}
            balances={balances}
            busy={busy}
            canTrade={!!client && !!wallet.publicKey && tradingEnabled}
            tradingClosed={tradingClosed}
            onSell={(side, collateralOut, maxTokensIn) =>
              runAction(() =>
                client!
                  .sellIx(
                    wallet.publicKey!,
                    market.marketId,
                    side,
                    collateralOut,
                    maxTokensIn,
                    market.collateralMint
                  )
                  .then((ix) => [ix])
              )
            }
          />
          {/* Liquidity (add/remove) — only meaningful while OPEN */}
          <LiquidityPanel
            market={market}
            balances={balances}
            lpShares={lpPosition?.shares ?? ZERO}
            busy={busy}
            canAct={!!client && !!wallet.publicKey && tradingEnabled}
            onAdd={(amount) =>
              runAction(() =>
                client!.addLiquidityIxs(
                  wallet.publicKey!,
                  market.marketId,
                  amount,
                  market.collateralMint
                )
              )
            }
            onRemove={(shares) =>
              runAction(() =>
                client!.removeLiquidityIxs(wallet.publicKey!, market.marketId, shares)
              )
            }
          />
        </>
      )}

      {/* Resolution controls, branched on resolverKind */}
      {(isOpen || isResolving) && (
        <ResolutionControls
          market={market}
          config={config}
          scalar={scalar}
          feed={feed}
          feedError={feedError}
          now={now}
          pastResolution={pastResolution}
          isOpen={isOpen}
          isResolving={isResolving}
          disputeEnd={disputeEnd}
          disputeWindowOpen={disputeWindowOpen}
          canFinalize={canFinalize}
          isResolver={isResolver}
          isGuardian={isGuardian}
          me={me ?? null}
          busy={busy}
          canAct={!!client}
          runAction={runAction}
          client={client}
        />
      )}

      {/* RESOLVED: redeem winners + LP claim */}
      {isResolved && !scalar && (
        <RedeemPanel
          market={market}
          balances={balances}
          busy={busy}
          canTrade={!!client && !!wallet.publicKey}
          onRedeem={(winning, amount) =>
            runAction(() =>
              client!
                .redeemIx(
                  wallet.publicKey!,
                  market.marketId,
                  winning,
                  amount,
                  market.collateralMint
                )
                .then((ix) => [ix])
            )
          }
        />
      )}

      {isResolved && scalar && (
        <RedeemScalarPanel
          market={market}
          balances={balances}
          busy={busy}
          canTrade={!!client && !!wallet.publicKey}
          onRedeem={(side, amount) =>
            runAction(() =>
              client!
                .redeemScalarIx(
                  wallet.publicKey!,
                  market.marketId,
                  side,
                  amount,
                  market.collateralMint
                )
                .then((ix) => [ix])
            )
          }
        />
      )}

      {/* VOID: 50/50 refund redeem for either held side */}
      {isVoid && (
        <RedeemVoidPanel
          market={market}
          scalar={scalar}
          balances={balances}
          busy={busy}
          canTrade={!!client && !!wallet.publicKey}
          onRedeemVoid={(side, amount) =>
            runAction(() =>
              client!
                .redeemVoidIx(
                  wallet.publicKey!,
                  market.marketId,
                  side,
                  amount,
                  market.collateralMint
                )
                .then((ix) => [ix])
            )
          }
        />
      )}

      {/* LP claim pool (RESOLVED or VOID) */}
      {(isResolved || isVoid) && isLp && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>LP — Claim pool</h3>
          <div className="small muted" style={{ marginBottom: 10 }}>
            You hold liquidity in this market. Claim your share of the remaining
            pool collateral now that it has settled.
          </div>
          <button
            className="btn full"
            disabled={!client || busy}
            onClick={() =>
              runAction(() =>
                client!
                  .claimPoolIx(
                    wallet.publicKey!,
                    market.marketId,
                    market.collateralMint
                  )
                  .then((ix) => [ix])
              )
            }
          >
            {busy ? "Submitting…" : "Claim pool"}
          </button>
        </div>
      )}
    </div>
  );
}

/* --------------------------- small derived helper ------------------------ */

// Re-derive the market PDA from the decoded account (we need it for the LP
// position lookup). Anchor's decoded account doesn't carry its own address.
function marketAddr(m: MarketAccount): PublicKey {
  return marketPda(m.marketId)[0];
}

/* ------------------------------ Config panel ----------------------------- */

function ConfigPanel({ config }: { config: ConfigAccount | null }) {
  if (!config) return null;
  return (
    <div className="card">
      <strong>Protocol config</strong>
      <div className="kv" style={{ marginTop: 8 }}>
        <span className="k">Taker fee</span>
        <span>{(config.feeBps / 100).toFixed(2)}%</span>
      </div>
      <div className="kv">
        <span className="k">LP fee (of taker fee)</span>
        <span>{(config.lpFeeBps / 100).toFixed(2)}%</span>
      </div>
      <div className="kv">
        <span className="k">Optimistic bond</span>
        <span>{formatUnits(config.bondAmount)} USDC</span>
      </div>
      <div className="kv">
        <span className="k">Dispute period</span>
        <span>{config.disputePeriod.toString()}s</span>
      </div>
      <div className="kv">
        <span className="k">Paused</span>
        <span>{config.paused ? "yes" : "no"}</span>
      </div>
      <div className="small" style={{ marginTop: 6 }}>
        <CopyKey label="Guardian:" value={config.guardian.toBase58()} />
      </div>
    </div>
  );
}

/* ------------------------------ Trust panel ------------------------------ */

function TrustPanel({
  market,
  config,
  disputePeriod,
}: {
  market: MarketAccount;
  config: ConfigAccount | null;
  disputePeriod: number;
}) {
  const cluster = clusterFromRpc(RPC_URL);
  const kind = market.resolverKind;
  return (
    <div className="card trust">
      <div className="flex-between">
        <strong>Settlement &amp; risk</strong>
        <span className={`badge cluster ${cluster}`}>{cluster}</span>
      </div>
      <ul className="trust-list small">
        {kind === RESOLVER_TRUSTED_KEY && (
          <li>
            <strong>Settlement:</strong> a single <strong>trusted resolver</strong>{" "}
            proposes the outcome.
          </li>
        )}
        {kind === RESOLVER_ORACLE_FEED && (
          <li>
            <strong>Settlement:</strong> derived permissionlessly from an{" "}
            <strong>on-chain oracle feed</strong> vs a strike/comparison.
          </li>
        )}
        {kind === RESOLVER_OPTIMISTIC && (
          <li>
            <strong>Settlement:</strong> <strong>optimistic</strong> — anyone may
            assert an outcome by posting a bond; a dispute escalates to the
            guardian. Bonds go to the correct asserter.
          </li>
        )}
        <li>
          <strong>Dispute window:</strong> {disputePeriod}s after an outcome is
          proposed/asserted.
        </li>
        <li>
          <strong>Guardian veto:</strong> the guardian can void a proposed outcome
          during the dispute window (trusted/oracle) or settle a disputed
          optimistic assertion.
        </li>
        <li>
          <strong>Voided markets</strong> refund both sides 50/50.
        </li>
      </ul>
      <div className="small" style={{ marginTop: 8 }}>
        <CopyKey label="Resolver:" value={market.resolver.toBase58()} />
      </div>
      {config && (
        <div className="small" style={{ marginTop: 4 }}>
          <CopyKey label="Guardian:" value={config.guardian.toBase58()} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Side selector ---------------------------- */

function SideToggle({
  side,
  setSide,
  scalar,
  disabled,
}: {
  side: Side;
  setSide: (s: Side) => void;
  scalar: boolean;
  disabled?: boolean;
}) {
  const yesLab = outcomeLabel(OUTCOME_YES, scalar);
  const noLab = outcomeLabel(OUTCOME_NO, scalar);
  return (
    <div className="seg" role="radiogroup" aria-label="Outcome side">
      <button
        className={side === OUTCOME_YES ? "active yes" : ""}
        onClick={() => setSide(OUTCOME_YES)}
        disabled={disabled}
        type="button"
        role="radio"
        aria-checked={side === OUTCOME_YES}
      >
        <span aria-hidden="true">{side === OUTCOME_YES ? "● " : "○ "}</span>
        {yesLab}
      </button>
      <button
        className={side === OUTCOME_NO ? "active no" : ""}
        onClick={() => setSide(OUTCOME_NO)}
        disabled={disabled}
        type="button"
        role="radio"
        aria-checked={side === OUTCOME_NO}
      >
        <span aria-hidden="true">{side === OUTCOME_NO ? "● " : "○ "}</span>
        {noLab}
      </button>
    </div>
  );
}

function SlippageInput({
  slippage,
  setSlippage,
}: {
  slippage: number;
  setSlippage: (v: number) => void;
}) {
  const pct = slippage * 100;
  const high = slippage > HIGH_SLIPPAGE;
  return (
    <div>
      <label htmlFor="slippage">Slippage tolerance (%)</label>
      <input
        id="slippage"
        type="number"
        min={0}
        max={MAX_SLIPPAGE * 100}
        step={0.1}
        value={pct.toString()}
        onChange={(e) => {
          const raw = parseFloat(e.target.value);
          if (isNaN(raw)) {
            setSlippage(0);
            return;
          }
          // Clamp to 0..50%.
          const clamped = Math.min(MAX_SLIPPAGE * 100, Math.max(0, raw));
          setSlippage(clamped / 100);
        }}
      />
      {high && (
        <div className="small warn-text" style={{ marginTop: 4 }}>
          High slippage ({pct.toFixed(1)}%) — you may get a much worse price.
        </div>
      )}
    </div>
  );
}

/** A short note explaining what a scalar side pays at settlement. */
function ScalarPayoutNote({ side }: { side: Side }) {
  return (
    <div className="small muted" style={{ marginTop: 8 }}>
      {side === OUTCOME_YES ? (
        <>
          <strong>LONG</strong> pays <code>fraction × 1</code> per token at
          settlement (higher settled value ⇒ bigger payout).
        </>
      ) : (
        <>
          <strong>SHORT</strong> pays <code>(1 − fraction) × 1</code> per token at
          settlement (lower settled value ⇒ bigger payout).
        </>
      )}
    </div>
  );
}

/* ------------------------------- Buy panel ------------------------------- */

function BuyPanel({
  market,
  scalar,
  feeBps,
  balances,
  busy,
  canTrade,
  tradingClosed,
  onBuy,
}: {
  market: MarketAccount;
  scalar: boolean;
  feeBps: number;
  balances: Balances | null;
  busy: boolean;
  canTrade: boolean;
  tradingClosed: boolean;
  onBuy: (side: Side, collateralIn: BN, minTokensOut: BN) => void;
}) {
  const [side, setSide] = useState<Side>(OUTCOME_YES);
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(0.01);

  const parsed = parseUnits(amount);

  const preview = useMemo(() => {
    if (!parsed || parsed.lten(0)) return null;
    const fee = feeAmount(parsed, feeBps);
    const net = parsed.sub(fee);
    const reserveBought =
      side === OUTCOME_YES ? market.reserveYes : market.reserveNo;
    const reserveOther =
      side === OUTCOME_YES ? market.reserveNo : market.reserveYes;
    const q = quoteBuy(reserveBought, reserveOther, net);
    const priceBefore = marginalPrice(reserveBought, reserveOther);
    const priceAfter = marginalPrice(q.newReserveBought, q.newReserveOther);
    const minOut = minOutWithSlippage(q.tokensOut, slippage);
    return { fee, net, tokensOut: q.tokensOut, priceBefore, priceAfter, minOut };
  }, [parsed, feeBps, side, market, slippage]);

  const impact = preview
    ? Math.abs(preview.priceAfter - preview.priceBefore)
    : 0;

  const insufficient = balances && parsed ? parsed.gt(balances.usdc) : false;

  const setMax = () => {
    if (balances) setAmount(formatUnits(balances.usdc, 6));
  };

  const disabled =
    !canTrade ||
    busy ||
    !parsed ||
    parsed.lten(0) ||
    !preview ||
    insufficient;

  const lab = outcomeLabel(side, scalar);

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Buy</h3>
      <div className="row">
        <div style={{ flex: "0 0 auto" }}>
          <label>Side</label>
          <SideToggle side={side} setSide={setSide} scalar={scalar} disabled={busy || tradingClosed} />
        </div>
        <div>
          <div className="flex-between">
            <label htmlFor="buy-amount">Collateral in (USDC)</label>
            <button
              type="button"
              className="linkbtn small"
              onClick={setMax}
              disabled={!balances}
            >
              Max
            </button>
          </div>
          <input
            id="buy-amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={tradingClosed}
          />
        </div>
        <SlippageInput slippage={slippage} setSlippage={setSlippage} />
      </div>

      {scalar && <ScalarPayoutNote side={side} />}

      {preview && (
        <div style={{ marginTop: 12 }}>
          <div className="kv">
            <span className="k">Fee ({(feeBps / 100).toFixed(2)}%)</span>
            <span>{formatUnits(preview.fee)} USDC</span>
          </div>
          <div className="kv">
            <span className="k">Est. tokens out</span>
            <span>
              {formatUnits(preview.tokensOut)} {lab}
            </span>
          </div>
          <div className="kv">
            <span className="k">Min tokens out (after slippage)</span>
            <span>{formatUnits(preview.minOut)}</span>
          </div>
          <div className="kv">
            <span className="k">Avg price</span>
            <span>
              {parsed && preview.tokensOut.gtn(0)
                ? formatPct(safeRatio(parsed, preview.tokensOut))
                : "—"}
            </span>
          </div>
          <div className="kv">
            <span className="k">Price impact</span>
            <span>
              {formatPct(preview.priceBefore)} → {formatPct(preview.priceAfter)} (
              {(impact * 100).toFixed(2)} pts)
            </span>
          </div>
          <div className="payout-line">
            <div>
              <div className="payout-cap">Payout if {lab} wins</div>
              <div className="payout-val">
                {formatUnits(preview.tokensOut)} USDC
              </div>
            </div>
            <div className="payout-mult">
              {parsed && parsed.gtn(0)
                ? `${safeRatio(preview.tokensOut, parsed).toFixed(2)}×`
                : "—"}
            </div>
          </div>
        </div>
      )}

      {insufficient && (
        <div className="notice err small">Insufficient USDC balance.</div>
      )}

      <div className="spacer" />
      <button
        className="btn full"
        disabled={disabled}
        onClick={() => {
          if (parsed && preview && !insufficient) onBuy(side, parsed, preview.minOut);
        }}
      >
        {busy ? "Submitting…" : `Buy ${lab}`}
      </button>
      {!canTrade && !tradingClosed && (
        <div className="small muted" style={{ marginTop: 8 }}>
          Connect a wallet to trade.
        </div>
      )}
    </div>
  );
}

/* ------------------------------- Sell panel ------------------------------ */

function SellPanel({
  market,
  scalar,
  feeBps,
  balances,
  busy,
  canTrade,
  tradingClosed,
  onSell,
}: {
  market: MarketAccount;
  scalar: boolean;
  feeBps: number;
  balances: Balances | null;
  busy: boolean;
  canTrade: boolean;
  tradingClosed: boolean;
  onSell: (side: Side, collateralOut: BN, maxTokensIn: BN) => void;
}) {
  const [side, setSide] = useState<Side>(OUTCOME_YES);
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(0.01);

  const parsed = parseUnits(amount);

  const heldTokens =
    balances == null ? null : side === OUTCOME_YES ? balances.yes : balances.no;

  const preview = useMemo(() => {
    if (!parsed || parsed.lten(0)) return null;
    // The on-chain program rejects collateral_out > market.collateral.
    if (parsed.gt(market.collateral)) return { overCollateral: true } as const;
    const reserveSold =
      side === OUTCOME_YES ? market.reserveYes : market.reserveNo;
    const reserveOther =
      side === OUTCOME_YES ? market.reserveNo : market.reserveYes;
    // collateral_out is gross; the program deducts the fee from the payout.
    const q = quoteSell(reserveSold, reserveOther, parsed);
    if (!q) return null;
    const priceBefore = marginalPrice(reserveSold, reserveOther);
    const priceAfter = marginalPrice(q.newReserveSold, q.newReserveOther);
    const maxIn = maxInWithSlippage(q.tokensIn, slippage);
    const fee = feeAmount(parsed, feeBps);
    const netToUser = parsed.sub(fee);
    return {
      overCollateral: false as const,
      tokensIn: q.tokensIn,
      priceBefore,
      priceAfter,
      maxIn,
      fee,
      netToUser,
    };
  }, [parsed, side, market, slippage, feeBps]);

  const overCollateral = preview != null && preview.overCollateral === true;
  const ready = preview != null && preview.overCollateral === false;

  const impact = ready
    ? Math.abs(preview.priceAfter - preview.priceBefore)
    : 0;

  // After-slippage requirement must fit within held tokens.
  const insufficient =
    heldTokens && ready ? preview.maxIn.gt(heldTokens) : false;

  // Liquidity error: quoteSell returned null (a was too large for the reserve).
  const liquidityError = parsed != null && parsed.gtn(0) && preview === null;

  const lab = outcomeLabel(side, scalar);

  // "Max" sell: clamp maxTokensIn to the held balance exactly, and size
  // collateralOut from the held balance via quoteSell's inverse preview.
  const setMaxFromHeld = () => {
    if (!heldTokens || heldTokens.lten(0)) return;
    // Binary search the largest collateral_out whose required tokensIn <= held,
    // also bounded by market.collateral.
    const reserveSold =
      side === OUTCOME_YES ? market.reserveYes : market.reserveNo;
    const reserveOther =
      side === OUTCOME_YES ? market.reserveNo : market.reserveYes;
    let lo = ZERO;
    let hi = BN.min(market.collateral, reserveOther.subn(1));
    if (hi.lten(0)) return;
    for (let i = 0; i < 64 && lo.lt(hi); i++) {
      const mid = lo.add(hi).addn(1).divn(2);
      const q = quoteSell(reserveSold, reserveOther, mid);
      if (q && q.tokensIn.lte(heldTokens)) {
        lo = mid;
      } else {
        hi = mid.subn(1);
      }
    }
    setAmount(formatUnits(lo, 6));
  };

  const disabled =
    !canTrade ||
    busy ||
    !parsed ||
    parsed.lten(0) ||
    !ready ||
    insufficient ||
    overCollateral;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Sell</h3>
      <div className="row">
        <div style={{ flex: "0 0 auto" }}>
          <label>Side</label>
          <SideToggle side={side} setSide={setSide} scalar={scalar} disabled={busy || tradingClosed} />
        </div>
        <div>
          <div className="flex-between">
            <label htmlFor="sell-amount">Collateral out (USDC, gross)</label>
            <button
              type="button"
              className="linkbtn small"
              onClick={setMaxFromHeld}
              disabled={!heldTokens || heldTokens.lten(0)}
            >
              Max
            </button>
          </div>
          <input
            id="sell-amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={tradingClosed}
          />
        </div>
        <SlippageInput slippage={slippage} setSlippage={setSlippage} />
      </div>

      {ready && (
        <div style={{ marginTop: 12 }}>
          <div className="kv">
            <span className="k">Est. tokens in (you pay)</span>
            <span>
              {formatUnits(preview.tokensIn)} {lab}
            </span>
          </div>
          <div className="kv">
            <span className="k">Max tokens in (after slippage)</span>
            <span>{formatUnits(preview.maxIn)}</span>
          </div>
          <div className="kv">
            <span className="k">Fee ({(feeBps / 100).toFixed(2)}%)</span>
            <span>{formatUnits(preview.fee)} USDC</span>
          </div>
          <div className="kv">
            <span className="k">Net USDC to you</span>
            <span>{formatUnits(preview.netToUser)} USDC</span>
          </div>
          <div className="kv">
            <span className="k">Price impact</span>
            <span>
              {formatPct(preview.priceBefore)} → {formatPct(preview.priceAfter)} (
              {(impact * 100).toFixed(2)} pts)
            </span>
          </div>
        </div>
      )}

      {overCollateral && (
        <div className="notice err small">
          Collateral out exceeds the market&apos;s collateral (
          {formatUnits(market.collateral)} USDC). The program would reject this.
        </div>
      )}
      {liquidityError && (
        <div className="notice err small">
          Amount exceeds available liquidity on this side.
        </div>
      )}
      {insufficient && (
        <div className="notice err small">
          You don&apos;t hold enough {lab} tokens for this (after slippage). Use
          “Max”.
        </div>
      )}

      <div className="spacer" />
      <button
        className="btn full secondary"
        disabled={disabled}
        onClick={() => {
          if (parsed && ready && !insufficient) onSell(side, parsed, preview.maxIn);
        }}
      >
        {busy ? "Submitting…" : `Sell ${lab}`}
      </button>
    </div>
  );
}

/* ----------------------------- Liquidity panel --------------------------- */

function LiquidityPanel({
  market,
  balances,
  lpShares,
  busy,
  canAct,
  onAdd,
  onRemove,
}: {
  market: MarketAccount;
  balances: Balances | null;
  lpShares: BN;
  busy: boolean;
  canAct: boolean;
  onAdd: (amount: BN) => void;
  onRemove: (shares: BN) => void;
}) {
  const scalar = isScalar(market);
  const [addAmount, setAddAmount] = useState("");
  const [removeShares, setRemoveShares] = useState("");
  const addParsed = parseUnits(addAmount);
  const removeParsed = parseUnits(removeShares);

  const addInsufficient =
    balances && addParsed ? addParsed.gt(balances.usdc) : false;
  const removeTooMuch = removeParsed ? removeParsed.gt(lpShares) : false;

  const addDisabled =
    !canAct ||
    busy ||
    !addParsed ||
    addParsed.lten(0) ||
    addInsufficient;
  const removeDisabled =
    !canAct ||
    busy ||
    !removeParsed ||
    removeParsed.lten(0) ||
    removeTooMuch;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Liquidity</h3>
      <div className="small muted" style={{ marginBottom: 10 }}>
        Anyone can provide liquidity. Adding USDC mints pool shares and returns
        some {scalar ? "LONG/SHORT" : "YES/NO"} outcome tokens to you
        (price-preserving send-back). Removing burns shares and withdraws the
        underlying outcome tokens.
      </div>
      <div className="kv">
        <span className="k">Your LP shares</span>
        <span>{formatUnits(lpShares)}</span>
      </div>
      <div className="kv">
        <span className="k">Pool shares (total)</span>
        <span>{formatUnits(market.totalShares)}</span>
      </div>

      <div className="divider" />

      {/* Add liquidity */}
      <div className="flex-between">
        <label htmlFor="lp-add">Add liquidity (USDC)</label>
        <button
          type="button"
          className="linkbtn small"
          onClick={() => balances && setAddAmount(formatUnits(balances.usdc, 6))}
          disabled={!balances}
        >
          Max
        </button>
      </div>
      <input
        id="lp-add"
        type="text"
        inputMode="decimal"
        placeholder="0.00"
        value={addAmount}
        onChange={(e) => setAddAmount(e.target.value)}
      />
      {addInsufficient && (
        <div className="notice err small">Insufficient USDC balance.</div>
      )}
      <div className="spacer" />
      <button
        className="btn full"
        disabled={addDisabled}
        onClick={() => {
          if (addParsed && !addInsufficient) onAdd(addParsed);
        }}
      >
        {busy ? "Submitting…" : "Add liquidity"}
      </button>

      <div className="divider" />

      {/* Remove liquidity */}
      <div className="flex-between">
        <label htmlFor="lp-remove">Remove liquidity (shares)</label>
        <button
          type="button"
          className="linkbtn small"
          onClick={() => setRemoveShares(formatUnits(lpShares, 6))}
          disabled={lpShares.lten(0)}
        >
          Max
        </button>
      </div>
      <input
        id="lp-remove"
        type="text"
        inputMode="decimal"
        placeholder="0.00"
        value={removeShares}
        onChange={(e) => setRemoveShares(e.target.value)}
      />
      {removeTooMuch && (
        <div className="notice err small">
          You only hold {formatUnits(lpShares)} shares.
        </div>
      )}
      <div className="spacer" />
      <button
        className="btn full secondary"
        disabled={removeDisabled}
        onClick={() => {
          if (removeParsed && !removeTooMuch) onRemove(removeParsed);
        }}
      >
        {busy ? "Submitting…" : "Remove liquidity"}
      </button>
      {!canAct && (
        <div className="small muted" style={{ marginTop: 8 }}>
          Connect a wallet (market must be open) to manage liquidity.
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Redeem panel ----------------------------- */

function RedeemPanel({
  market,
  balances,
  busy,
  canTrade,
  onRedeem,
}: {
  market: MarketAccount;
  balances: Balances | null;
  busy: boolean;
  canTrade: boolean;
  onRedeem: (winningOutcome: Side, amount: BN) => void;
}) {
  const winning: Side = market.outcome === OUTCOME_YES ? OUTCOME_YES : OUTCOME_NO;
  const held =
    balances == null ? ZERO : winning === OUTCOME_YES ? balances.yes : balances.no;
  const [amount, setAmount] = useState("");
  const parsed = parseUnits(amount);

  useEffect(() => {
    if (balances && amount === "" && held.gtn(0)) {
      setAmount(formatUnits(held, 6));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balances]);

  const disabled =
    !canTrade || busy || !parsed || parsed.lten(0) || parsed.gt(held);

  const lab = winning === OUTCOME_YES ? "YES" : "NO";

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Redeem winnings</h3>
      <div className="small muted" style={{ marginBottom: 10 }}>
        This market resolved {lab}. Redeem winning tokens 1:1 for USDC.
      </div>
      <div className="kv">
        <span className="k">Your {lab} balance</span>
        <span>{formatUnits(held)}</span>
      </div>
      <div className="flex-between" style={{ marginTop: 10 }}>
        <label htmlFor="redeem-amount">Amount to redeem</label>
        <button
          type="button"
          className="linkbtn small"
          onClick={() => setAmount(formatUnits(held, 6))}
          disabled={held.lten(0)}
        >
          Max
        </button>
      </div>
      <input
        id="redeem-amount"
        type="text"
        inputMode="decimal"
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <div className="spacer" />
      <button
        className="btn full"
        disabled={disabled}
        onClick={() => {
          if (parsed) onRedeem(winning, parsed);
        }}
      >
        {busy ? "Submitting…" : "Redeem"}
      </button>
      {!canTrade && (
        <div className="small muted" style={{ marginTop: 8 }}>
          Connect a wallet to redeem.
        </div>
      )}
    </div>
  );
}

/* -------------------------- Scalar redeem panel -------------------------- */

function RedeemScalarPanel({
  market,
  balances,
  busy,
  canTrade,
  onRedeem,
}: {
  market: MarketAccount;
  balances: Balances | null;
  busy: boolean;
  canTrade: boolean;
  onRedeem: (side: Side, amount: BN) => void;
}) {
  const frac = settledLongFraction(market) ?? 0;
  const fracMicro = new BN(market.settlementFraction);
  const [side, setSide] = useState<Side>(OUTCOME_YES);

  const yesHeld = balances?.yes ?? ZERO;
  const noHeld = balances?.no ?? ZERO;

  useEffect(() => {
    if (balances) {
      if (yesHeld.lten(0) && noHeld.gtn(0)) setSide(OUTCOME_NO);
      else setSide(OUTCOME_YES);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balances]);

  const held = side === OUTCOME_YES ? yesHeld : noHeld;
  const [amount, setAmount] = useState("");
  const parsed = parseUnits(amount);

  const payout = useMemo(() => {
    if (!parsed || parsed.lten(0)) return null;
    return scalarPayout(parsed, fracMicro, side === OUTCOME_YES);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, side, market.settlementFraction]);

  const disabled =
    !canTrade || busy || !parsed || parsed.lten(0) || parsed.gt(held);

  const lab = outcomeLabel(side, true);

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Redeem (scalar)</h3>
      <div className="small muted" style={{ marginBottom: 10 }}>
        This scalar market settled at fraction <strong>{formatPct(frac)}</strong>{" "}
        (value{" "}
        {fmtNum(settledScalarValue(market) ?? 0)}). LONG pays{" "}
        <code>fraction</code> per token; SHORT pays <code>(1 − fraction)</code>.
        Redeem either side you hold.
      </div>
      <div className="row">
        <div style={{ flex: "0 0 auto" }}>
          <label>Side</label>
          <SideToggle side={side} setSide={setSide} scalar disabled={busy} />
        </div>
        <div>
          <div className="flex-between">
            <label htmlFor="redeem-scalar-amount">Amount to redeem</label>
            <button
              type="button"
              className="linkbtn small"
              onClick={() => setAmount(formatUnits(held, 6))}
              disabled={held.lten(0)}
            >
              Max
            </button>
          </div>
          <input
            id="redeem-scalar-amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>
      <div className="kv" style={{ marginTop: 8 }}>
        <span className="k">Your {lab} balance</span>
        <span>{formatUnits(held)}</span>
      </div>
      {payout && (
        <div className="kv">
          <span className="k">Est. USDC payout</span>
          <span>{formatUnits(payout)} USDC</span>
        </div>
      )}
      <div className="spacer" />
      <button
        className="btn full"
        disabled={disabled}
        onClick={() => {
          if (parsed) onRedeem(side, parsed);
        }}
      >
        {busy ? "Submitting…" : `Redeem ${lab}`}
      </button>
      {!canTrade && (
        <div className="small muted" style={{ marginTop: 8 }}>
          Connect a wallet to redeem.
        </div>
      )}
    </div>
  );
}

/* --------------------------- Redeem void panel --------------------------- */

function RedeemVoidPanel({
  market,
  scalar,
  balances,
  busy,
  canTrade,
  onRedeemVoid,
}: {
  market: MarketAccount;
  scalar: boolean;
  balances: Balances | null;
  busy: boolean;
  canTrade: boolean;
  onRedeemVoid: (side: Side, amount: BN) => void;
}) {
  // Default to whichever side the user actually holds.
  const yesHeld = balances?.yes ?? ZERO;
  const noHeld = balances?.no ?? ZERO;
  const [side, setSide] = useState<Side>(OUTCOME_YES);

  useEffect(() => {
    if (balances) {
      if (yesHeld.lten(0) && noHeld.gtn(0)) setSide(OUTCOME_NO);
      else setSide(OUTCOME_YES);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balances]);

  const held = side === OUTCOME_YES ? yesHeld : noHeld;
  const [amount, setAmount] = useState("");
  const parsed = parseUnits(amount);

  const disabled =
    !canTrade || busy || !parsed || parsed.lten(0) || parsed.gt(held);

  const lab = outcomeLabel(side, scalar);

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Redeem (refund)</h3>
      <div className="small muted" style={{ marginBottom: 10 }}>
        This market was <strong>voided</strong>. Both sides refund at 50% of
        collateral per token. Redeem whichever side you hold.
      </div>
      <div className="row">
        <div style={{ flex: "0 0 auto" }}>
          <label>Side</label>
          <SideToggle side={side} setSide={setSide} scalar={scalar} disabled={busy} />
        </div>
        <div>
          <div className="flex-between">
            <label htmlFor="void-amount">Amount to redeem</label>
            <button
              type="button"
              className="linkbtn small"
              onClick={() => setAmount(formatUnits(held, 6))}
              disabled={held.lten(0)}
            >
              Max
            </button>
          </div>
          <input
            id="void-amount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>
      <div className="kv" style={{ marginTop: 8 }}>
        <span className="k">Your {lab} balance</span>
        <span>{formatUnits(held)}</span>
      </div>
      <div className="spacer" />
      <button
        className="btn full"
        disabled={disabled}
        onClick={() => {
          if (parsed) onRedeemVoid(side, parsed);
        }}
      >
        {busy ? "Submitting…" : "Redeem refund"}
      </button>
      {!canTrade && (
        <div className="small muted" style={{ marginTop: 8 }}>
          Connect a wallet to redeem.
        </div>
      )}
    </div>
  );
}

/* ====================== Resolution controls (router) ===================== */

import type { ComputeClient } from "../../lib/client";

function ResolutionControls({
  market,
  config,
  scalar,
  feed,
  feedError,
  now,
  pastResolution,
  isOpen,
  isResolving,
  disputeEnd,
  disputeWindowOpen,
  canFinalize,
  isResolver,
  isGuardian,
  me,
  busy,
  canAct,
  runAction,
  client,
}: {
  market: MarketAccount;
  config: ConfigAccount | null;
  scalar: boolean;
  feed: PriceFeedAccount | null;
  feedError: string | null;
  now: number;
  pastResolution: boolean;
  isOpen: boolean;
  isResolving: boolean;
  disputeEnd: number;
  disputeWindowOpen: boolean;
  canFinalize: boolean;
  isResolver: boolean;
  isGuardian: boolean;
  me: PublicKey | null;
  busy: boolean;
  canAct: boolean;
  runAction: (build: () => Promise<TransactionInstruction[]>) => void;
  client: ComputeClient | null;
}) {
  const kind = market.resolverKind;
  if (kind === RESOLVER_TRUSTED_KEY) {
    return (
      <TrustedResolution
        market={market}
        scalar={scalar}
        now={now}
        pastResolution={pastResolution}
        isOpen={isOpen}
        isResolving={isResolving}
        disputeEnd={disputeEnd}
        disputeWindowOpen={disputeWindowOpen}
        canFinalize={canFinalize}
        isResolver={isResolver}
        isGuardian={isGuardian}
        busy={busy}
        canAct={canAct}
        me={me}
        runAction={runAction}
        client={client}
      />
    );
  }
  if (kind === RESOLVER_ORACLE_FEED) {
    return (
      <OracleResolution
        market={market}
        feed={feed}
        feedError={feedError}
        now={now}
        pastResolution={pastResolution}
        isOpen={isOpen}
        isResolving={isResolving}
        disputeEnd={disputeEnd}
        disputeWindowOpen={disputeWindowOpen}
        canFinalize={canFinalize}
        isGuardian={isGuardian}
        busy={busy}
        canAct={canAct}
        me={me}
        runAction={runAction}
        client={client}
      />
    );
  }
  if (kind === RESOLVER_OPTIMISTIC) {
    return (
      <OptimisticResolution
        market={market}
        config={config}
        now={now}
        pastResolution={pastResolution}
        isOpen={isOpen}
        isResolving={isResolving}
        disputeEnd={disputeEnd}
        disputeWindowOpen={disputeWindowOpen}
        canFinalize={canFinalize}
        isGuardian={isGuardian}
        me={me}
        busy={busy}
        canAct={canAct}
        runAction={runAction}
        client={client}
      />
    );
  }
  return null;
}

/** Shared dispute-window status + finalize button for trusted/oracle paths. */
function DisputeWindow({
  market,
  disputeEnd,
  now,
  windowOpen,
  canFinalize,
  isGuardian,
  busy,
  canAct,
  onFinalize,
  onDisputeVoid,
}: {
  market: MarketAccount;
  disputeEnd: number;
  now: number;
  windowOpen: boolean;
  canFinalize: boolean;
  isGuardian: boolean;
  busy: boolean;
  canAct: boolean;
  onFinalize: () => void;
  onDisputeVoid: () => void;
}) {
  const scalar = isScalar(market);
  const proposed = scalar
    ? `value ${market.proposedValue.toString()} (LONG fraction ${formatPct(
        (fractionForValue(market.proposedValue, market.lowerBound, market.upperBound) ?? 0)
      )})`
    : market.proposedOutcome === OUTCOME_YES
    ? "YES"
    : "NO";
  return (
    <>
      <div className="kv">
        <span className="k">Proposed outcome</span>
        <span>{proposed}</span>
      </div>
      <div className="kv">
        <span className="k">Dispute window ends</span>
        <span title={formatAbsTime(disputeEnd)}>{formatAbsTime(disputeEnd)}</span>
      </div>
      {windowOpen ? (
        <div className="notice info small" style={{ marginTop: 10 }}>
          Dispute window open — finalize available in{" "}
          <strong>{formatCountdown(disputeEnd, now)}</strong>.
        </div>
      ) : (
        <div className="notice ok small" style={{ marginTop: 10 }}>
          Dispute window closed — anyone can finalize this outcome.
        </div>
      )}

      <div className="spacer" />
      <button
        className="btn full"
        disabled={!canAct || busy || !canFinalize}
        onClick={onFinalize}
        title={canFinalize ? undefined : "Available once the dispute window has elapsed"}
      >
        {busy ? "Submitting…" : "Finalize outcome"}
      </button>

      {isGuardian && windowOpen && (
        <>
          <div className="spacer" />
          <button
            className="btn full secondary"
            style={{ borderColor: "var(--no)", color: "var(--no)" }}
            disabled={!canAct || busy}
            onClick={onDisputeVoid}
          >
            {busy ? "Submitting…" : "Dispute / Void (guardian)"}
          </button>
          <div className="small muted" style={{ marginTop: 6 }}>
            As guardian you can veto this outcome, voiding the market (50/50
            refund).
          </div>
        </>
      )}
    </>
  );
}

/* --------------------------- Trusted resolution -------------------------- */

function TrustedResolution({
  market,
  scalar,
  now,
  pastResolution,
  isOpen,
  isResolving,
  disputeEnd,
  disputeWindowOpen,
  canFinalize,
  isResolver,
  isGuardian,
  busy,
  canAct,
  me,
  runAction,
  client,
}: {
  market: MarketAccount;
  scalar: boolean;
  now: number;
  pastResolution: boolean;
  isOpen: boolean;
  isResolving: boolean;
  disputeEnd: number;
  disputeWindowOpen: boolean;
  canFinalize: boolean;
  isResolver: boolean;
  isGuardian: boolean;
  busy: boolean;
  canAct: boolean;
  me: PublicKey | null;
  runAction: (build: () => Promise<TransactionInstruction[]>) => void;
  client: ComputeClient | null;
}) {
  const [scalarValue, setScalarValue] = useState("");
  const parsedValue = parseIntBN(scalarValue);
  const canPropose = isResolver && isOpen && pastResolution;

  // Nothing to show: open, not yet resolvable, and you're not the resolver.
  if (isOpen && !canPropose) {
    if (!isResolver) return null;
    return (
      <div className="card" style={{ borderColor: "var(--warn)" }}>
        <h3 style={{ marginTop: 0 }}>Resolver — trusted</h3>
        <div className="small muted">
          You are the resolver. You can propose the outcome at/after the
          resolution time ({formatAbsTime(market.resolutionTime)}).
        </div>
      </div>
    );
  }

  if (canPropose) {
    return (
      <div className="card" style={{ borderColor: "var(--warn)" }}>
        <h3 style={{ marginTop: 0 }}>Resolver — propose outcome</h3>
        <div className="small muted" style={{ marginBottom: 10 }}>
          You are the trusted resolver. Propose the {scalar ? "settlement value" : "winning outcome"}.
          This opens a dispute window before it is finalized.
        </div>
        {scalar ? (
          <>
            <label htmlFor="scalar-value">
              Settlement value (range {market.lowerBound.toString()}–
              {market.upperBound.toString()})
            </label>
            <input
              id="scalar-value"
              type="text"
              inputMode="numeric"
              placeholder="e.g. 42"
              value={scalarValue}
              onChange={(e) => setScalarValue(e.target.value)}
            />
            {parsedValue && (
              <div className="kv" style={{ marginTop: 8 }}>
                <span className="k">Implied LONG fraction</span>
                <span>
                  {formatPct(
                    fractionForValue(parsedValue, market.lowerBound, market.upperBound) ?? 0
                  )}
                </span>
              </div>
            )}
            <div className="spacer" />
            <button
              className="btn full"
              disabled={!canAct || busy || !parsedValue}
              onClick={() => {
                if (parsedValue)
                  runAction(() =>
                    client!
                      .proposeScalarIx(me!, market.marketId, parsedValue)
                      .then((ix) => [ix])
                  );
              }}
            >
              {busy ? "Submitting…" : "Propose settlement value"}
            </button>
          </>
        ) : (
          <div className="row">
            <button
              className="btn full"
              style={{ background: "var(--yes)", color: "#06241a" }}
              disabled={!canAct || busy}
              onClick={() =>
                runAction(() =>
                  client!
                    .proposeOutcomeIx(me!, market.marketId, OUTCOME_YES)
                    .then((ix) => [ix])
                )
              }
            >
              Propose YES
            </button>
            <button
              className="btn full"
              style={{ background: "var(--no)", color: "#2a0612" }}
              disabled={!canAct || busy}
              onClick={() =>
                runAction(() =>
                  client!
                    .proposeOutcomeIx(me!, market.marketId, OUTCOME_NO)
                    .then((ix) => [ix])
                )
              }
            >
              Propose NO
            </button>
          </div>
        )}
      </div>
    );
  }

  if (isResolving) {
    return (
      <div className="card" style={{ borderColor: "var(--warn)" }}>
        <h3 style={{ marginTop: 0 }}>Resolving — outcome proposed (trusted)</h3>
        <DisputeWindow
          market={market}
          disputeEnd={disputeEnd}
          now={now}
          windowOpen={disputeWindowOpen}
          canFinalize={canFinalize}
          isGuardian={isGuardian}
          busy={busy}
          canAct={canAct}
          onFinalize={() =>
            runAction(() =>
              client!.finalizeOutcomeIx(me!, market.marketId).then((ix) => [ix])
            )
          }
          onDisputeVoid={() =>
            runAction(() =>
              client!.disputeVoidIx(me!, market.marketId).then((ix) => [ix])
            )
          }
        />
      </div>
    );
  }

  return null;
}

/* ---------------------------- Oracle resolution -------------------------- */

function OracleResolution({
  market,
  feed,
  feedError,
  now,
  pastResolution,
  isOpen,
  isResolving,
  disputeEnd,
  disputeWindowOpen,
  canFinalize,
  isGuardian,
  busy,
  canAct,
  me,
  runAction,
  client,
}: {
  market: MarketAccount;
  feed: PriceFeedAccount | null;
  feedError: string | null;
  now: number;
  pastResolution: boolean;
  isOpen: boolean;
  isResolving: boolean;
  disputeEnd: number;
  disputeWindowOpen: boolean;
  canFinalize: boolean;
  isGuardian: boolean;
  busy: boolean;
  canAct: boolean;
  me: PublicKey | null;
  runAction: (build: () => Promise<TransactionInstruction[]>) => void;
  client: ComputeClient | null;
}) {
  const canResolve = isOpen && pastResolution;
  return (
    <div className="card" style={{ borderColor: "var(--warn)" }}>
      <h3 style={{ marginTop: 0 }}>Resolver — oracle feed</h3>
      <div className="small" style={{ marginBottom: 8 }}>
        <CopyKey label="Feed:" value={market.oracleFeed.toBase58()} />
      </div>
      <div className="kv">
        <span className="k">Current feed value</span>
        <span>
          {feed
            ? `${feed.value.toString()} (${feed.decimals} dp)`
            : feedError
            ? "unavailable"
            : "—"}
        </span>
      </div>
      {feed && (
        <div className="kv">
          <span className="k">Last published</span>
          <span title={formatAbsTime(feed.publishedAt)}>
            {formatAbsTime(feed.publishedAt)} ({formatRelTime(feed.publishedAt, now)})
          </span>
        </div>
      )}
      <div className="kv">
        <span className="k">Resolves YES iff value</span>
        <span>
          {comparisonLabel(market.oracleComparison)} {market.oracleStrike.toString()}
        </span>
      </div>
      <div className="kv">
        <span className="k">Max staleness</span>
        <span>{market.oracleMaxStaleness.toString()}s</span>
      </div>
      {feedError && (
        <div className="notice err small">Could not load feed: {feedError}</div>
      )}

      {isOpen && (
        <>
          <div className="divider" />
          <div className="small muted" style={{ marginBottom: 10 }}>
            Anyone can permissionlessly derive the outcome from the feed once the
            resolution time has passed ({formatAbsTime(market.resolutionTime)}).
          </div>
          <button
            className="btn full"
            disabled={!canAct || busy || !canResolve}
            onClick={() =>
              runAction(() =>
                client!
                  .proposeFromOracleIx(me!, market.marketId, market.oracleFeed)
                  .then((ix) => [ix])
              )
            }
            title={canResolve ? undefined : "Available at/after the resolution time"}
          >
            {busy ? "Submitting…" : "Resolve from oracle"}
          </button>
        </>
      )}

      {isResolving && (
        <>
          <div className="divider" />
          <DisputeWindow
            market={market}
            disputeEnd={disputeEnd}
            now={now}
            windowOpen={disputeWindowOpen}
            canFinalize={canFinalize}
            isGuardian={isGuardian}
            busy={busy}
            canAct={canAct}
            onFinalize={() =>
              runAction(() =>
                client!.finalizeOutcomeIx(me!, market.marketId).then((ix) => [ix])
              )
            }
            onDisputeVoid={() =>
              runAction(() =>
                client!.disputeVoidIx(me!, market.marketId).then((ix) => [ix])
              )
            }
          />
        </>
      )}
    </div>
  );
}

/* -------------------------- Optimistic resolution ------------------------ */

function OptimisticResolution({
  market,
  config,
  now,
  pastResolution,
  isOpen,
  isResolving,
  disputeEnd,
  disputeWindowOpen,
  canFinalize,
  isGuardian,
  me,
  busy,
  canAct,
  runAction,
  client,
}: {
  market: MarketAccount;
  config: ConfigAccount | null;
  now: number;
  pastResolution: boolean;
  isOpen: boolean;
  isResolving: boolean;
  disputeEnd: number;
  disputeWindowOpen: boolean;
  canFinalize: boolean;
  isGuardian: boolean;
  me: PublicKey | null;
  busy: boolean;
  canAct: boolean;
  runAction: (build: () => Promise<TransactionInstruction[]>) => void;
  client: ComputeClient | null;
}) {
  const bond = config?.bondAmount ?? ZERO;
  const canAssert = isOpen && pastResolution;
  const proposed = market.proposedOutcome === OUTCOME_YES ? "YES" : "NO";
  const isAsserter = me != null && market.asserter.equals(me);

  // For guardian dispute resolution: winner is the asserter if the chosen
  // correct outcome matches their proposed outcome, else the disputer.
  const resolveDispute = (correctOutcome: Side) => {
    const winner =
      correctOutcome === market.proposedOutcome ? market.asserter : market.disputer;
    runAction(() =>
      client!
        .resolveDisputeIx(me!, market.marketId, correctOutcome, winner, market.collateralMint)
        .then((ix) => [ix])
    );
  };

  return (
    <div className="card" style={{ borderColor: "var(--warn)" }}>
      <h3 style={{ marginTop: 0 }}>Resolver — optimistic (bonded)</h3>
      <div className="kv">
        <span className="k">Bond required</span>
        <span>{formatUnits(bond)} USDC</span>
      </div>
      <div className="small muted" style={{ marginTop: 6 }}>
        Anyone may assert an outcome by posting the bond. An undisputed assertion
        finalizes after the dispute window; a dispute (matching bond) escalates to
        the guardian. The 2× bond escrow goes to the correct asserter.
      </div>

      {isOpen && (
        <>
          <div className="divider" />
          {canAssert ? (
            <>
              <div className="small muted" style={{ marginBottom: 10 }}>
                Assert the outcome (posts {formatUnits(bond)} USDC bond):
              </div>
              <div className="row">
                <button
                  className="btn full"
                  style={{ background: "var(--yes)", color: "#06241a" }}
                  disabled={!canAct || busy}
                  onClick={() =>
                    runAction(() =>
                      client!.assertOutcomeIxs(
                        me!,
                        market.marketId,
                        OUTCOME_YES,
                        market.collateralMint
                      )
                    )
                  }
                >
                  Assert YES
                </button>
                <button
                  className="btn full"
                  style={{ background: "var(--no)", color: "#2a0612" }}
                  disabled={!canAct || busy}
                  onClick={() =>
                    runAction(() =>
                      client!.assertOutcomeIxs(
                        me!,
                        market.marketId,
                        OUTCOME_NO,
                        market.collateralMint
                      )
                    )
                  }
                >
                  Assert NO
                </button>
              </div>
            </>
          ) : (
            <div className="small muted">
              Assertions open at/after the resolution time (
              {formatAbsTime(market.resolutionTime)}).
            </div>
          )}
        </>
      )}

      {isResolving && (
        <>
          <div className="divider" />
          <div className="kv">
            <span className="k">Asserter</span>
            <span className="mono">{market.asserter.toBase58().slice(0, 8)}…</span>
          </div>
          <div className="kv">
            <span className="k">Proposed outcome</span>
            <span>{proposed}</span>
          </div>
          <div className="kv">
            <span className="k">Bond posted</span>
            <span>{formatUnits(market.bond)} USDC</span>
          </div>
          <div className="kv">
            <span className="k">Disputed</span>
            <span>{market.disputed ? "yes" : "no"}</span>
          </div>
          <div className="kv">
            <span className="k">Dispute window ends</span>
            <span title={formatAbsTime(disputeEnd)}>{formatAbsTime(disputeEnd)}</span>
          </div>

          {!market.disputed && disputeWindowOpen && (
            <div className="notice info small" style={{ marginTop: 10 }}>
              Window open for <strong>{formatCountdown(disputeEnd, now)}</strong>.
              Anyone (except the asserter) can dispute by posting a matching bond.
            </div>
          )}

          {/* Dispute (anyone except the asserter), while window open + undisputed */}
          {!market.disputed && disputeWindowOpen && !isAsserter && (
            <>
              <div className="spacer" />
              <button
                className="btn full secondary"
                style={{ borderColor: "var(--no)", color: "var(--no)" }}
                disabled={!canAct || busy}
                onClick={() =>
                  runAction(() =>
                    client!
                      .disputeAssertionIx(me!, market.marketId, market.collateralMint)
                      .then((ix) => [ix])
                  )
                }
              >
                {busy ? "Submitting…" : `Dispute (post ${formatUnits(market.bond)} USDC)`}
              </button>
            </>
          )}

          {/* Finalize undisputed after the window (anyone) */}
          {!market.disputed && canFinalize && (
            <>
              <div className="spacer" />
              <button
                className="btn full"
                disabled={!canAct || busy}
                onClick={() =>
                  runAction(() =>
                    client!
                      .finalizeAssertionIx(me!, market.marketId, market.collateralMint)
                      .then((ix) => [ix])
                  )
                }
              >
                {busy ? "Submitting…" : "Finalize assertion"}
              </button>
              <div className="small muted" style={{ marginTop: 6 }}>
                Refunds the asserter&apos;s bond and resolves to {proposed}.
              </div>
            </>
          )}

          {/* Disputed → guardian settles */}
          {market.disputed && (
            <>
              <div className="notice info small" style={{ marginTop: 10 }}>
                Assertion <strong>disputed</strong> — awaiting guardian resolution.
              </div>
              {isGuardian ? (
                <>
                  <div className="small muted" style={{ margin: "10px 0" }}>
                    As guardian, settle the dispute. The 2× bond goes to the
                    correct asserter (asserter if their proposed outcome was
                    correct, else the disputer).
                  </div>
                  <div className="row">
                    <button
                      className="btn full"
                      style={{ background: "var(--yes)", color: "#06241a" }}
                      disabled={!canAct || busy}
                      onClick={() => resolveDispute(OUTCOME_YES)}
                    >
                      Resolve YES
                    </button>
                    <button
                      className="btn full"
                      style={{ background: "var(--no)", color: "#2a0612" }}
                      disabled={!canAct || busy}
                      onClick={() => resolveDispute(OUTCOME_NO)}
                    >
                      Resolve NO
                    </button>
                  </div>
                </>
              ) : (
                <div className="small muted" style={{ marginTop: 8 }}>
                  Only the guardian can resolve a disputed assertion.
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
