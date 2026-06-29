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
import { useComputeClient, useReadClient } from "../../components/useComputeClient";
import type { MarketAccount, ConfigAccount } from "../../components/types";
import { formatUnits, parseUnits, formatPct, shortKey } from "../../lib/format";
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
  STATE_RESOLVED,
} from "../../lib/pdas";

type Side = typeof OUTCOME_YES | typeof OUTCOME_NO;

interface Balances {
  usdc: BN;
  yes: BN;
  no: BN;
}

const ZERO = new BN(0);

export default function MarketPage() {
  const router = useRouter();
  const { id } = router.query;
  const marketId = typeof id === "string" ? id : undefined;

  const { connection } = useConnection();
  const wallet = useWallet();
  const readClient = useReadClient();
  const client = useComputeClient(); // null until connected

  const [market, setMarket] = useState<MarketAccount | null>(null);
  const [config, setConfig] = useState<ConfigAccount | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // tx feedback shared across panels
  const [busy, setBusy] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  const loadMarket = useCallback(async () => {
    if (marketId === undefined) return;
    setLoading(true);
    setLoadError(null);
    try {
      const idBn = new BN(marketId);
      const [m, cfg] = await Promise.all([
        readClient.fetchMarketById(idBn) as unknown as Promise<MarketAccount>,
        readClient.fetchConfig() as unknown as Promise<ConfigAccount>,
      ]);
      setMarket(m);
      setConfig(cfg);
    } catch (e: any) {
      setLoadError(e?.message ?? String(e));
      setMarket(null);
    } finally {
      setLoading(false);
    }
  }, [marketId, readClient]);

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
        setTxError(e?.message ?? String(e));
      } finally {
        setBusy(false);
      }
    },
    [sendIxs, refreshAll]
  );

  if (loading) {
    return (
      <div className="container">
        <TopBar />
        <div className="notice info">Loading market…</div>
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
          Could not load market {marketId}: {loadError ?? "not found"}
        </div>
      </div>
    );
  }

  const resolved = market.state === STATE_RESOLVED;
  const yesPrice = marginalPrice(market.reserveYes, market.reserveNo);
  const noPrice = marginalPrice(market.reserveNo, market.reserveYes);
  const feeBps = config?.feeBps ?? 0;
  const isResolver =
    wallet.publicKey != null &&
    market.resolver.equals(wallet.publicKey);

  return (
    <div className="container">
      <TopBar />
      <p style={{ marginTop: -8 }}>
        <Link href="/">← Back to markets</Link>
      </p>

      <div className="card">
        <div className="flex-between">
          <h2 style={{ margin: 0 }}>{market.question}</h2>
          <span className={`badge ${resolved ? "resolved" : "open"}`}>
            {resolved ? "Resolved" : "Open"}
          </span>
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          Resolution source: {market.resolutionSource || "—"}
        </div>
        <div className="small muted">
          Market #{market.marketId.toString()} · resolver{" "}
          <span className="mono">{shortKey(market.resolver.toBase58())}</span> · fee{" "}
          {(feeBps / 100).toFixed(2)}%
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
        {resolved && (
          <div className="kv">
            <span className="k">Winning outcome</span>
            <span>{market.outcome === OUTCOME_YES ? "YES" : "NO"}</span>
          </div>
        )}
      </div>

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
      {txError && <div className="notice err">Transaction failed: {txError}</div>}
      {txSig && (
        <div className="notice ok">
          Transaction confirmed. Signature:{" "}
          <span className="mono">{txSig}</span>
          <div className="small" style={{ marginTop: 4 }}>
            (Market data and balances were refreshed.)
          </div>
        </div>
      )}

      {resolved ? (
        <RedeemPanel
          market={market}
          balances={balances}
          busy={busy}
          canTrade={!!client && !!wallet.publicKey}
          onRedeem={(winning, amount) =>
            runAction(() =>
              client!.redeemIx(
                wallet.publicKey!,
                market.marketId,
                winning,
                amount,
                market.collateralMint
              ).then((ix) => [ix])
            )
          }
        />
      ) : (
        <>
          <BuyPanel
            market={market}
            feeBps={feeBps}
            balances={balances}
            busy={busy}
            canTrade={!!client && !!wallet.publicKey}
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
            canTrade={!!client && !!wallet.publicKey}
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

      {/* Resolver affordance */}
      {isResolver && !resolved && (
        <ResolvePanel
          busy={busy}
          canResolve={!!client}
          onResolve={(outcome) =>
            runAction(() =>
              client!
                .resolveIx(wallet.publicKey!, market.marketId, outcome)
                .then((ix) => [ix])
            )
          }
        />
      )}
    </div>
  );
}

/* ------------------------------- Buy panel ------------------------------- */

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
    <div className="seg">
      <button
        className={side === OUTCOME_YES ? "active yes" : ""}
        onClick={() => setSide(OUTCOME_YES)}
        disabled={disabled}
        type="button"
      >
        YES
      </button>
      <button
        className={side === OUTCOME_NO ? "active no" : ""}
        onClick={() => setSide(OUTCOME_NO)}
        disabled={disabled}
        type="button"
      >
        NO
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
  return (
    <div>
      <label>Slippage tolerance (%)</label>
      <input
        type="number"
        min={0}
        step={0.1}
        value={(slippage * 100).toString()}
        onChange={(e) => {
          const pct = parseFloat(e.target.value);
          setSlippage(isNaN(pct) ? 0 : Math.max(0, pct) / 100);
        }}
      />
    </div>
  );
}

function BuyPanel({
  market,
  feeBps,
  balances,
  busy,
  canTrade,
  onBuy,
}: {
  market: MarketAccount;
  feeBps: number;
  balances: Balances | null;
  busy: boolean;
  canTrade: boolean;
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

  const insufficient =
    balances && parsed ? parsed.gt(balances.usdc) : false;

  const disabled =
    !canTrade || busy || !parsed || parsed.lten(0) || !preview;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Buy</h3>
      <div className="row">
        <div style={{ flex: "0 0 auto" }}>
          <label>Side</label>
          <SideToggle side={side} setSide={setSide} disabled={busy} />
        </div>
        <div>
          <label>Collateral in (USDC)</label>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
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
              {formatUnits(preview.tokensOut)}{" "}
              {side === OUTCOME_YES ? "YES" : "NO"}
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
          if (parsed && preview) onBuy(side, parsed, preview.minOut);
        }}
      >
        {busy ? "Submitting…" : `Buy ${side === OUTCOME_YES ? "YES" : "NO"}`}
      </button>
      {!canTrade && (
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
  onSell,
}: {
  market: MarketAccount;
  feeBps: number;
  balances: Balances | null;
  busy: boolean;
  canTrade: boolean;
  onSell: (side: Side, collateralOut: BN, maxTokensIn: BN) => void;
}) {
  const [side, setSide] = useState<Side>(OUTCOME_YES);
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(0.01);

  const parsed = parseUnits(amount);

  const preview = useMemo(() => {
    if (!parsed || parsed.lten(0)) return null;
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
      tokensIn: q.tokensIn,
      priceBefore,
      priceAfter,
      maxIn,
      fee,
      netToUser,
    };
  }, [parsed, side, market, slippage, feeBps]);

  const impact = preview
    ? Math.abs(preview.priceAfter - preview.priceBefore)
    : 0;

  const heldTokens =
    balances == null
      ? null
      : side === OUTCOME_YES
      ? balances.yes
      : balances.no;

  const insufficient =
    heldTokens && preview ? preview.maxIn.gt(heldTokens) : false;

  const liquidityError = parsed && parsed.gten(0) && !preview;

  const disabled =
    !canTrade || busy || !parsed || parsed.lten(0) || !preview;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Sell</h3>
      <div className="row">
        <div style={{ flex: "0 0 auto" }}>
          <label>Side</label>
          <SideToggle side={side} setSide={setSide} disabled={busy} />
        </div>
        <div>
          <label>Collateral out (USDC, gross)</label>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <SlippageInput slippage={slippage} setSlippage={setSlippage} />
      </div>

      {preview && (
        <div style={{ marginTop: 12 }}>
          <div className="kv">
            <span className="k">Est. tokens in (you pay)</span>
            <span>
              {formatUnits(preview.tokensIn)}{" "}
              {side === OUTCOME_YES ? "YES" : "NO"}
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

      {liquidityError && (
        <div className="notice err small">
          Amount exceeds available liquidity on this side.
        </div>
      )}
      {insufficient && (
        <div className="notice err small">
          You don&apos;t hold enough {side === OUTCOME_YES ? "YES" : "NO"} tokens
          for this (after slippage).
        </div>
      )}

      <div className="spacer" />
      <button
        className="btn full secondary"
        disabled={disabled}
        onClick={() => {
          if (parsed && preview) onSell(side, parsed, preview.maxIn);
        }}
      >
        {busy ? "Submitting…" : `Sell ${side === OUTCOME_YES ? "YES" : "NO"}`}
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
    balances == null
      ? ZERO
      : winning === OUTCOME_YES
      ? balances.yes
      : balances.no;
  const [amount, setAmount] = useState("");
  const parsed = parseUnits(amount);

  useEffect(() => {
    // Default the field to the full winning balance once known.
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
        This market resolved {winning === OUTCOME_YES ? "YES" : "NO"}. Redeem
        winning tokens 1:1 for USDC.
      </div>
      <div className="kv">
        <span className="k">
          Your {winning === OUTCOME_YES ? "YES" : "NO"} balance
        </span>
        <span>{formatUnits(held)}</span>
      </div>
      <label style={{ marginTop: 10 }}>Amount to redeem</label>
      <input
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

/* ------------------------------ Resolve panel ---------------------------- */

function ResolvePanel({
  busy,
  canResolve,
  onResolve,
}: {
  busy: boolean;
  canResolve: boolean;
  onResolve: (outcome: Side) => void;
}) {
  return (
    <div className="card" style={{ borderColor: "var(--warn)" }}>
      <h3 style={{ marginTop: 0 }}>Resolver controls</h3>
      <div className="small muted" style={{ marginBottom: 10 }}>
        You are the resolver for this market. Resolve it to a winning outcome.
        (Only valid at/after the resolution time.)
      </div>
      <div className="row">
        <button
          className="btn full"
          style={{ background: "var(--yes)", color: "#06241a" }}
          disabled={!canResolve || busy}
          onClick={() => onResolve(OUTCOME_YES)}
        >
          Resolve YES
        </button>
        <button
          className="btn full"
          style={{ background: "var(--no)", color: "#2a0612" }}
          disabled={!canResolve || busy}
          onClick={() => onResolve(OUTCOME_NO)}
        >
          Resolve NO
        </button>
      </div>
    </div>
  );
}
