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
import { RPC_URL } from "../../components/WalletProviders";
import { useComputeClient, useReadClient } from "../../components/useComputeClient";
import { useNow, marketStateLabel, StateBadge, CopyKey } from "../../components/ui";
import type { MarketAccount, ConfigAccount } from "../../components/types";
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
} from "../../lib/amm";
import {
  OUTCOME_YES,
  OUTCOME_NO,
  STATE_OPEN,
  STATE_RESOLVING,
  STATE_RESOLVED,
  STATE_VOID,
} from "../../lib/pdas";

type Side = typeof OUTCOME_YES | typeof OUTCOME_NO;

interface Balances {
  usdc: BN;
  yes: BN;
  no: BN;
}

const ZERO = new BN(0);
const MAX_SLIPPAGE = 0.5; // 50%
const HIGH_SLIPPAGE = 0.05; // warn above ~5%

function sideLabel(side: Side): string {
  return side === OUTCOME_YES ? "YES" : "NO";
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
    const [usdc, yes, no] = await Promise.all([
      read(market.collateralMint),
      read(market.yesMint),
      read(market.noMint),
    ]);
    setBalances({ usdc, yes, no });
  }, [market, wallet.publicKey, connection]);

  useEffect(() => {
    loadMarket();
  }, [loadMarket]);

  useEffect(() => {
    loadBalances();
  }, [loadBalances]);

  const refreshAll = useCallback(async () => {
    await loadMarket();
    await loadBalances();
  }, [loadMarket, loadBalances]);

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

  const runAction = useCallback(
    async (build: () => Promise<TransactionInstruction[]>) => {
      setBusy(true);
      setTxError(null);
      setTxSig(null);
      try {
        const ixs = await build();
        const sig = await sendIxs(ixs);
        setTxSig(sig);
        await refreshAll();
      } catch (e: any) {
        // Decode program errors before surfacing.
        setTxError(client ? client.parseError(e) : readClient.parseError(e));
      } finally {
        setBusy(false);
      }
    },
    [sendIxs, refreshAll, client, readClient]
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
        <div className="notice info">Loading market…</div>
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
  const yesPrice = marginalPrice(market.reserveYes, market.reserveNo);
  const noPrice = marginalPrice(market.reserveNo, market.reserveYes);
  const feeBps = config?.feeBps ?? 0;

  const me = wallet.publicKey;
  const isResolver = me != null && market.resolver.equals(me);
  const isGuardian =
    me != null && config != null && config.guardian.equals(me);
  const isLp = me != null && market.lp.equals(me);
  const canProposeNow = isResolver && isOpen && now >= resolutionTime;
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
        <div className="small muted" style={{ marginTop: 6 }}>
          Resolution source: {market.resolutionSource || "—"}
        </div>
        <div className="small muted" style={{ marginTop: 2 }}>
          Market #{market.marketId.toString()} · fee {(feeBps / 100).toFixed(2)}%
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          <CopyKey label="Resolver:" value={market.resolver.toBase58()} />
        </div>

        <div className="prices">
          <div className="price-pill yes">
            <div className="lab">YES price</div>
            <div className="val">{formatPct(yesPrice)}</div>
          </div>
          <div className="price-pill no">
            <div className="lab">NO price</div>
            <div className="val">{formatPct(noPrice)}</div>
          </div>
        </div>
        <div className="kv">
          <span className="k">Reserve YES</span>
          <span>{formatUnits(market.reserveYes)}</span>
        </div>
        <div className="kv">
          <span className="k">Reserve NO</span>
          <span>{formatUnits(market.reserveNo)}</span>
        </div>
        <div className="kv">
          <span className="k">Collateral (TVL)</span>
          <span>{formatUnits(market.collateral)} USDC</span>
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
        {isResolved && (
          <div className="kv">
            <span className="k">Winning outcome</span>
            <span>{market.outcome === OUTCOME_YES ? "YES" : "NO"}</span>
          </div>
        )}
        {isVoid && (
          <div className="kv">
            <span className="k">Outcome</span>
            <span>Voided — 50/50 refund</span>
          </div>
        )}
      </div>

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
              <span className="k">YES tokens</span>
              <span>{formatUnits(balances.yes)}</span>
            </div>
            <div className="kv">
              <span className="k">NO tokens</span>
              <span>{formatUnits(balances.no)}</span>
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
            feeBps={feeBps}
            balances={balances}
            busy={busy}
            canTrade={!!client && !!wallet.publicKey && tradingEnabled}
            tradingClosed={tradingClosed}
            onBuy={(side, collateralIn, minTokensOut) =>
              runAction(() =>
                client!.buyIxs(
                  wallet.publicKey!,
                  market.marketId,
                  side,
                  collateralIn,
                  minTokensOut,
                  market.collateralMint
                )
              )
            }
          />
          <SellPanel
            market={market}
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
        </>
      )}

      {/* Resolver: propose outcome (OPEN & past resolution time) */}
      {canProposeNow && (
        <ProposePanel
          busy={busy}
          canAct={!!client}
          onPropose={(outcome) =>
            runAction(() =>
              client!
                .proposeOutcomeIx(wallet.publicKey!, market.marketId, outcome)
                .then((ix) => [ix])
            )
          }
        />
      )}

      {/* RESOLVING: dispute window + finalize / dispute */}
      {isResolving && (
        <ResolvingPanel
          market={market}
          disputeEnd={disputeEnd}
          now={now}
          windowOpen={disputeWindowOpen}
          canFinalize={canFinalize}
          isGuardian={isGuardian}
          busy={busy}
          canAct={!!client}
          onFinalize={() =>
            runAction(() =>
              client!
                .finalizeOutcomeIx(wallet.publicKey!, market.marketId)
                .then((ix) => [ix])
            )
          }
          onDispute={() =>
            runAction(() =>
              client!
                .disputeVoidIx(wallet.publicKey!, market.marketId)
                .then((ix) => [ix])
            )
          }
        />
      )}

      {/* RESOLVED: redeem winners + LP claim */}
      {isResolved && (
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

      {/* VOID: 50/50 refund redeem for either held side */}
      {isVoid && (
        <RedeemVoidPanel
          market={market}
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
            You seeded this market&apos;s liquidity. Claim the remaining pool
            collateral now that it has settled.
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
  return (
    <div className="card trust">
      <div className="flex-between">
        <strong>Settlement &amp; risk</strong>
        <span className={`badge cluster ${cluster}`}>{cluster}</span>
      </div>
      <ul className="trust-list small">
        <li>
          <strong>Settlement:</strong> single trusted resolver (no external oracle
          yet).
        </li>
        <li>
          <strong>Dispute window:</strong> {disputePeriod}s after an outcome is
          proposed.
        </li>
        <li>
          <strong>Guardian veto:</strong> the guardian can void a proposed outcome
          during the dispute window.
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
  disabled,
}: {
  side: Side;
  setSide: (s: Side) => void;
  disabled?: boolean;
}) {
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
        <span aria-hidden="true">{side === OUTCOME_YES ? "● " : "○ "}</span>YES
      </button>
      <button
        className={side === OUTCOME_NO ? "active no" : ""}
        onClick={() => setSide(OUTCOME_NO)}
        disabled={disabled}
        type="button"
        role="radio"
        aria-checked={side === OUTCOME_NO}
      >
        <span aria-hidden="true">{side === OUTCOME_NO ? "● " : "○ "}</span>NO
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

/* ------------------------------- Buy panel ------------------------------- */

function BuyPanel({
  market,
  feeBps,
  balances,
  busy,
  canTrade,
  tradingClosed,
  onBuy,
}: {
  market: MarketAccount;
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

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Buy</h3>
      <div className="row">
        <div style={{ flex: "0 0 auto" }}>
          <label>Side</label>
          <SideToggle side={side} setSide={setSide} disabled={busy || tradingClosed} />
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

      {preview && (
        <div style={{ marginTop: 12 }}>
          <div className="kv">
            <span className="k">Fee ({(feeBps / 100).toFixed(2)}%)</span>
            <span>{formatUnits(preview.fee)} USDC</span>
          </div>
          <div className="kv">
            <span className="k">Est. tokens out</span>
            <span>
              {formatUnits(preview.tokensOut)} {sideLabel(side)}
            </span>
          </div>
          <div className="kv">
            <span className="k">Min tokens out (after slippage)</span>
            <span>{formatUnits(preview.minOut)}</span>
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
        {busy ? "Submitting…" : `Buy ${sideLabel(side)}`}
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
  feeBps,
  balances,
  busy,
  canTrade,
  tradingClosed,
  onSell,
}: {
  market: MarketAccount;
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
          <SideToggle side={side} setSide={setSide} disabled={busy || tradingClosed} />
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
              {formatUnits(preview.tokensIn)} {sideLabel(side)}
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
          You don&apos;t hold enough {sideLabel(side)} tokens for this (after
          slippage). Use “Max”.
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
        {busy ? "Submitting…" : `Sell ${sideLabel(side)}`}
      </button>
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

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Redeem winnings</h3>
      <div className="small muted" style={{ marginBottom: 10 }}>
        This market resolved {sideLabel(winning)}. Redeem winning tokens 1:1 for
        USDC.
      </div>
      <div className="kv">
        <span className="k">Your {sideLabel(winning)} balance</span>
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

/* --------------------------- Redeem void panel --------------------------- */

function RedeemVoidPanel({
  market,
  balances,
  busy,
  canTrade,
  onRedeemVoid,
}: {
  market: MarketAccount;
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

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Redeem (refund)</h3>
      <div className="small muted" style={{ marginBottom: 10 }}>
        This market was <strong>voided</strong>. Both YES and NO refund at 50% of
        collateral per token. Redeem whichever side you hold.
      </div>
      <div className="row">
        <div style={{ flex: "0 0 auto" }}>
          <label>Side</label>
          <SideToggle side={side} setSide={setSide} disabled={busy} />
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
        <span className="k">Your {sideLabel(side)} balance</span>
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

/* ----------------------------- Propose panel ----------------------------- */

function ProposePanel({
  busy,
  canAct,
  onPropose,
}: {
  busy: boolean;
  canAct: boolean;
  onPropose: (outcome: Side) => void;
}) {
  return (
    <div className="card" style={{ borderColor: "var(--warn)" }}>
      <h3 style={{ marginTop: 0 }}>Resolver — propose outcome</h3>
      <div className="small muted" style={{ marginBottom: 10 }}>
        You are the resolver. Propose the winning outcome. This opens a dispute
        window before the outcome is finalized.
      </div>
      <div className="row">
        <button
          className="btn full"
          style={{ background: "var(--yes)", color: "#06241a" }}
          disabled={!canAct || busy}
          onClick={() => onPropose(OUTCOME_YES)}
        >
          Propose YES
        </button>
        <button
          className="btn full"
          style={{ background: "var(--no)", color: "#2a0612" }}
          disabled={!canAct || busy}
          onClick={() => onPropose(OUTCOME_NO)}
        >
          Propose NO
        </button>
      </div>
    </div>
  );
}

/* ---------------------------- Resolving panel ---------------------------- */

function ResolvingPanel({
  market,
  disputeEnd,
  now,
  windowOpen,
  canFinalize,
  isGuardian,
  busy,
  canAct,
  onFinalize,
  onDispute,
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
  onDispute: () => void;
}) {
  const proposed = market.proposedOutcome === OUTCOME_YES ? "YES" : "NO";
  return (
    <div className="card" style={{ borderColor: "var(--warn)" }}>
      <h3 style={{ marginTop: 0 }}>Resolving — outcome proposed</h3>
      <div className="kv">
        <span className="k">Proposed outcome</span>
        <span>{proposed}</span>
      </div>
      <div className="kv">
        <span className="k">Dispute window ends</span>
        <span title={formatAbsTime(disputeEnd)}>
          {formatAbsTime(disputeEnd)}
        </span>
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
        title={
          canFinalize
            ? undefined
            : "Available once the dispute window has elapsed"
        }
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
            onClick={onDispute}
          >
            {busy ? "Submitting…" : "Dispute / Void (guardian)"}
          </button>
          <div className="small muted" style={{ marginTop: 6 }}>
            As guardian you can veto this outcome, voiding the market (50/50
            refund).
          </div>
        </>
      )}
    </div>
  );
}
