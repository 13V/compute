import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import TopBar from "../components/TopBar";
import { useReadClient } from "../components/useComputeClient";
import { useNow, marketStateLabel, StateBadge } from "../components/ui";
import type { MarketEntry } from "../components/types";
import {
  formatUnits,
  formatPct,
  formatAbsTime,
  formatRelTime,
} from "../lib/format";
import { STATE_RESOLVED, STATE_VOID } from "../lib/pdas";
import { marginalPrice as marginal } from "../lib/amm";

export default function Home() {
  const client = useReadClient();
  const now = useNow();
  const [markets, setMarkets] = useState<MarketEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = (await client.listMarkets()) as unknown as MarketEntry[];
      // Sort newest first by market id.
      list.sort((a, b) => b.account.marketId.cmp(a.account.marketId));
      setMarkets(list);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setMarkets([]);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="container">
      <TopBar />

      <div className="flex-between" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>Markets</h2>
        <button className="btn secondary" onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="notice err">
          Failed to load markets: {error}
          <div className="small muted" style={{ marginTop: 6 }}>
            Make sure the program is deployed on the RPC cluster and NEXT_PUBLIC_RPC_URL
            points at it.
          </div>
        </div>
      )}

      {!error && markets && markets.length === 0 && !loading && (
        <div className="notice info">
          No markets found on this cluster yet.
        </div>
      )}

      {markets &&
        markets.map((m) => {
          const a = m.account;
          const yesPrice = marginal(a.reserveYes, a.reserveNo);
          const noPrice = marginal(a.reserveNo, a.reserveYes);
          const label = marketStateLabel(a.state, a.closeTime.toNumber(), now);
          return (
            <Link
              key={m.publicKey.toBase58()}
              href={`/market/${a.marketId.toString()}`}
              className="card market-card"
            >
              <div className="flex-between">
                <strong style={{ fontSize: 16 }}>{a.question}</strong>
                <StateBadge label={label} />
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>
                Source: {a.resolutionSource || "—"}
              </div>
              <div className="prices">
                <div className="price-pill yes">
                  <div className="lab">YES</div>
                  <div className="val">{formatPct(yesPrice)}</div>
                </div>
                <div className="price-pill no">
                  <div className="lab">NO</div>
                  <div className="val">{formatPct(noPrice)}</div>
                </div>
              </div>
              <div className="kv">
                <span className="k">Collateral (TVL)</span>
                <span>{formatUnits(a.collateral)} USDC</span>
              </div>
              <div className="kv">
                <span className="k">Reserves (YES / NO)</span>
                <span>
                  {formatUnits(a.reserveYes)} / {formatUnits(a.reserveNo)}
                </span>
              </div>
              <div className="kv">
                <span className="k">Closes</span>
                <span title={formatAbsTime(a.closeTime)}>
                  {formatAbsTime(a.closeTime)} ({formatRelTime(a.closeTime, now)})
                </span>
              </div>
              <div className="kv">
                <span className="k">Resolves</span>
                <span title={formatAbsTime(a.resolutionTime)}>
                  {formatAbsTime(a.resolutionTime)} (
                  {formatRelTime(a.resolutionTime, now)})
                </span>
              </div>
              {a.state === STATE_RESOLVED && (
                <div className="kv">
                  <span className="k">Outcome</span>
                  <span>{a.outcome === 0 ? "YES" : "NO"}</span>
                </div>
              )}
              {a.state === STATE_VOID && (
                <div className="kv">
                  <span className="k">Outcome</span>
                  <span>Voided — 50/50 refund</span>
                </div>
              )}
            </Link>
          );
        })}
    </div>
  );
}
