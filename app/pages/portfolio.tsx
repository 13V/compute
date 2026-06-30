import Link from "next/link";
import { TransactionInstruction } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";

import TopBar from "../components/TopBar";
import styles from "../components/Portfolio.module.css";
import { useComputeClient } from "../components/useComputeClient";
import { useTxRunner } from "../components/tx";
import { useNow } from "../components/ui";
import { usePositions, type Holding } from "../components/usePositions";
import { isScalar, outcomeLabel } from "../components/market";
import { marketProbs } from "../components/preview";
import { formatUnits, formatPct, formatRelTime } from "../lib/format";
import {
  OUTCOME_YES,
  OUTCOME_NO,
  STATE_OPEN,
  STATE_RESOLVING,
  STATE_RESOLVED,
  STATE_VOID,
} from "../lib/pdas";

export default function PortfolioPage() {
  const { connected, holdings, summary, loading, error, refresh } =
    usePositions();

  return (
    <div className="container">
      <TopBar />

      <div className={styles.head}>
        <h2 style={{ margin: 0 }}>Portfolio</h2>
        <button
          className="btn secondary"
          onClick={() => refresh()}
          disabled={loading || !connected}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {!connected ? (
        <div className="empty">
          <div className="icon" aria-hidden="true">◎</div>
          <div className="title">Connect your wallet to see your positions</div>
          <div className="desc">
            Your outcome-token holdings, liquidity, and claimable winnings will
            show up here once a wallet is connected.
          </div>
        </div>
      ) : (
        <>
          <SummaryTiles
            totalValue={summary.totalValue}
            openCount={summary.openCount}
            claimableCount={summary.claimableCount}
          />

          {error && (
            <div className="notice err" role="alert">
              Failed to load positions: {error}
            </div>
          )}

          {loading && holdings.length === 0 && (
            <div className="skel-card" aria-hidden="true">
              <div className="skel line" style={{ width: "55%" }} />
              <div className="skel line" style={{ width: "35%" }} />
              <div className="skel bar" />
              <div className="skel line" style={{ width: "45%", marginBottom: 0 }} />
            </div>
          )}

          {!loading && !error && holdings.length === 0 && (
            <div className="empty">
              <div className="icon" aria-hidden="true">◎</div>
              <div className="title">No positions yet</div>
              <div className="desc">
                You don&apos;t hold any outcome tokens or liquidity.{" "}
                <Link href="/">Browse markets</Link> to take a position.
              </div>
            </div>
          )}

          {holdings.map((h) => (
            <HoldingRow
              key={h.entry.publicKey.toBase58()}
              holding={h}
              onClaimed={refresh}
            />
          ))}
        </>
      )}
    </div>
  );
}

/* ------------------------------ Summary tiles ---------------------------- */

function SummaryTiles({
  totalValue,
  openCount,
  claimableCount,
}: {
  totalValue: BN;
  openCount: number;
  claimableCount: number;
}) {
  return (
    <div className={styles.summary}>
      <div className={styles.tile}>
        <div className={styles.tileLabel}>Portfolio value</div>
        <div className={`${styles.tileValue} ${styles.accent}`}>
          {formatUnits(totalValue)} <span style={{ fontSize: 14 }}>USDC</span>
        </div>
      </div>
      <div className={styles.tile}>
        <div className={styles.tileLabel}>Open positions</div>
        <div className={styles.tileValue}>{openCount}</div>
      </div>
      <div className={styles.tile}>
        <div className={styles.tileLabel}>Claimable</div>
        <div className={`${styles.tileValue} ${claimableCount > 0 ? styles.good : ""}`}>
          {claimableCount}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Holding row ------------------------------ */

function HoldingRow({
  holding,
  onClaimed,
}: {
  holding: Holding;
  onClaimed: () => void | Promise<void>;
}) {
  const { publicKey } = useWallet();
  const client = useComputeClient();
  const run = useTxRunner();
  const now = useNow();

  const m = holding.entry.account;
  const scalar = isScalar(m);
  const idStr = m.marketId.toString();
  const probs = marketProbs(m);

  const yesLab = outcomeLabel(OUTCOME_YES, scalar);
  const noLab = outcomeLabel(OUTCOME_NO, scalar);

  const canTx = !!client && !!publicKey;

  // Build the claim instructions for this holding in a single transaction:
  // redeem held outcome tokens (binary/scalar/void) + claimPool if LP-settled.
  const buildClaimIxs = async (): Promise<TransactionInstruction[]> => {
    if (!client || !publicKey) throw new Error("Connect a wallet first.");
    const user = publicKey;
    const ixs: TransactionInstruction[] = [];
    const collateral = m.collateralMint;

    if (m.state === STATE_RESOLVED) {
      if (scalar) {
        // Redeem whichever side(s) the user holds; payout computed on-chain.
        if (holding.yesTokens.gtn(0)) {
          ixs.push(
            await client.redeemScalarIx(user, m.marketId, OUTCOME_YES, holding.yesTokens, collateral)
          );
        }
        if (holding.noTokens.gtn(0)) {
          ixs.push(
            await client.redeemScalarIx(user, m.marketId, OUTCOME_NO, holding.noTokens, collateral)
          );
        }
      } else {
        // Binary: only the winning side is redeemable.
        const winning = m.outcome === OUTCOME_YES ? OUTCOME_YES : OUTCOME_NO;
        const winTokens = winning === OUTCOME_YES ? holding.yesTokens : holding.noTokens;
        if (winTokens.gtn(0)) {
          ixs.push(await client.redeemIx(user, m.marketId, winning, winTokens, collateral));
        }
      }
    } else if (m.state === STATE_VOID) {
      // Both sides refund 50/50.
      if (holding.yesTokens.gtn(0)) {
        ixs.push(await client.redeemVoidIx(user, m.marketId, OUTCOME_YES, holding.yesTokens, collateral));
      }
      if (holding.noTokens.gtn(0)) {
        ixs.push(await client.redeemVoidIx(user, m.marketId, OUTCOME_NO, holding.noTokens, collateral));
      }
    }

    // LP claim (RESOLVED or VOID), combined into the same tx.
    if (holding.lpClaimable) {
      ixs.push(await client.claimPoolIx(user, m.marketId, collateral));
    }

    if (ixs.length === 0) throw new Error("Nothing to claim.");
    return ixs;
  };

  const onClaim = () => {
    run({
      label: `Claim · Market #${idStr}`,
      build: buildClaimIxs,
      parseError: client ? (e) => client.parseError(e) : undefined,
      onSuccess: () => onClaimed(),
    });
  };

  const state = m.state;
  const settlesNote =
    state === STATE_OPEN
      ? `Open · settles ${formatRelTime(m.resolutionTime, now)}`
      : state === STATE_RESOLVING
      ? "Resolving"
      : state === STATE_RESOLVED
      ? scalar
        ? "Resolved"
        : `Resolved · ${m.outcome === OUTCOME_YES ? "YES" : "NO"} won`
      : state === STATE_VOID
      ? "Voided · 50/50 refund"
      : "Unknown";

  return (
    <div className="card">
      <div className={styles.holding}>
        <div className={styles.holdingMain}>
          <Link href={`/market/${idStr}`} className={styles.qlink}>
            {m.question}
          </Link>
          <div className="small muted" style={{ marginTop: 4 }}>
            Market #{idStr} ·{" "}
            {scalar
              ? `LONG ${formatPct(probs.yes)} / SHORT ${formatPct(probs.no)}`
              : `YES ${formatPct(probs.yes)} / NO ${formatPct(probs.no)}`}
          </div>

          <div className={styles.legs}>
            {holding.yesTokens.gtn(0) && (
              <span className={`${styles.leg} yes`}>
                <span className={styles.legLab}>{yesLab}</span>
                <span className={styles.legVal}>{formatUnits(holding.yesTokens)}</span>
              </span>
            )}
            {holding.noTokens.gtn(0) && (
              <span className={`${styles.leg} no`}>
                <span className={styles.legLab}>{noLab}</span>
                <span className={styles.legVal}>{formatUnits(holding.noTokens)}</span>
              </span>
            )}
            {holding.lpShares.gtn(0) && (
              <span className={`${styles.leg} lp`}>
                <span className={styles.legLab}>LP shares</span>
                <span className={styles.legVal}>{formatUnits(holding.lpShares)}</span>
              </span>
            )}
          </div>

          <div className="kv" style={{ marginTop: 12 }}>
            <span className="k">Value (mark-to-market)</span>
            <span>{formatUnits(holding.value)} USDC</span>
          </div>
          <div className="kv">
            <span className="k">Unrealized P&amp;L</span>
            <Pnl pnl={holding.unrealizedPnl} />
          </div>
        </div>

        <div className={styles.holdingSide}>
          {holding.claimable ? (
            <div className={styles.actions}>
              <button className="btn full" onClick={onClaim} disabled={!canTx}>
                Claim
              </button>
              <div className="small muted" style={{ textAlign: "center" }}>
                {settlesNote}
              </div>
            </div>
          ) : (
            <div className={styles.statusNote}>{settlesNote}</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- P&L ----------------------------------- */

function Pnl({ pnl }: { pnl: BN | null }) {
  if (pnl === null) {
    return <span className="muted">—</span>;
  }
  const neg = pnl.isNeg();
  const cls = pnl.isZero() ? "" : neg ? styles.down : styles.up;
  const sign = neg ? "-" : pnl.isZero() ? "" : "+";
  return (
    <span className={`${styles.pnl} ${cls}`}>
      {sign}
      {formatUnits(pnl.abs())} USDC
    </span>
  );
}
