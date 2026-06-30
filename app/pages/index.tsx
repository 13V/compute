import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import BN from "bn.js";
import TopBar from "../components/TopBar";
import { RPC_URL } from "../components/WalletProviders";
import { useReadClient } from "../components/useComputeClient";
import { useNow, marketStateLabel, StateBadge } from "../components/ui";
import { useLiveMarkets } from "../components/useLive";
import ComputeTicker from "../components/ComputeTicker";
import Faucet from "../components/Faucet";
import { categoryOf, categoryShort, CATEGORIES, CategoryKey } from "../components/category";
import type { MarketEntry } from "../components/types";
import {
  isScalar,
  marketKindLabel,
  resolverKindLabel,
  resolverKindClass,
  impliedScalarValue,
} from "../components/market";
import {
  formatUnits,
  formatPct,
  formatAbsTime,
  formatRelTime,
  clusterFromRpc,
} from "../lib/format";
import { STATE_OPEN, STATE_RESOLVED, STATE_VOID, OUTCOME_YES } from "../lib/pdas";
import { marginalPrice as marginal } from "../lib/amm";
import {
  settledScalarValue,
  settledLongFraction,
} from "../components/market";

type SortKey = "newest" | "closing" | "tvl";

function fmtNum(n: number): string {
  // Trim to at most 2 decimals, drop trailing zeros.
  return Number.isFinite(n) ? parseFloat(n.toFixed(2)).toString() : "—";
}

/** Compact human number for stat chips: 1234 -> "1.2K". */
function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${parseFloat((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1_000) return `${parseFloat((n / 1_000).toFixed(1))}K`;
  return parseFloat(n.toFixed(2)).toString();
}

/**
 * A Polymarket-style split probability bar. `long`/`short` are 0..1 prices;
 * guarded against NaN / non-positive sums (falls back to 50/50).
 */
export function ProbBar({
  long,
  short,
  yesLabel,
  noLabel,
}: {
  long: number;
  short: number;
  yesLabel: string;
  noLabel: string;
}) {
  const l = Number.isFinite(long) && long > 0 ? long : 0;
  const s = Number.isFinite(short) && short > 0 ? short : 0;
  const sum = l + s;
  const longFrac = sum > 0 ? l / sum : 0.5;
  const pct = Math.max(0, Math.min(100, longFrac * 100));
  return (
    <div className="probbar">
      <div className="probbar-head">
        <span className="probbar-side yes">
          <span className="lab">{yesLabel}</span>
          <span className="pct">{formatPct(long)}</span>
        </span>
        <span className="probbar-side no">
          <span className="lab">{noLabel}</span>
          <span className="pct">{formatPct(short)}</span>
        </span>
      </div>
      <div
        className="probbar-track"
        style={{ ["--split" as any]: `${pct}%` }}
        role="img"
        aria-label={`${yesLabel} ${formatPct(long)}, ${noLabel} ${formatPct(
          short
        )}`}
      >
        <div className="probbar-fill yes" style={{ width: `${pct}%` }} />
        <div className="probbar-fill no" style={{ width: `${100 - pct}%` }} />
      </div>
    </div>
  );
}

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

  // Real-time: subscribe to every market account so the cards tick live.
  const { live, version } = useLiveMarkets(markets);

  // Discovery state.
  const [cat, setCat] = useState<CategoryKey | "all">("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");

  // Merge in the latest live account for each market.
  const liveEntries = useMemo<MarketEntry[] | null>(() => {
    if (!markets) return null;
    return markets.map((m) => ({
      publicKey: m.publicKey,
      account: live[m.publicKey.toBase58()] ?? m.account,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets, version]);

  // Per-category counts (over the full set).
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: liveEntries?.length ?? 0 };
    for (const cat of CATEGORIES) c[cat.key] = 0;
    for (const m of liveEntries ?? []) {
      const k = categoryOf(m.account);
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [liveEntries]);

  // Filtered + sorted list to render.
  const display = useMemo(() => {
    if (!liveEntries) return null;
    let list = liveEntries;
    if (cat !== "all") list = list.filter((m) => categoryOf(m.account) === cat);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (m) =>
          m.account.question.toLowerCase().includes(q) ||
          m.account.resolutionSource.toLowerCase().includes(q)
      );
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      if (sort === "tvl") return b.account.collateral.cmp(a.account.collateral);
      if (sort === "closing") {
        const ao = a.account.state === STATE_OPEN ? 0 : 1;
        const bo = b.account.state === STATE_OPEN ? 0 : 1;
        if (ao !== bo) return ao - bo;
        return a.account.closeTime.cmp(b.account.closeTime);
      }
      return b.account.marketId.cmp(a.account.marketId); // newest
    });
    return sorted;
  }, [liveEntries, cat, query, sort]);

  const cluster = clusterFromRpc(RPC_URL);
  // Hero stats derived from already-loaded data.
  const marketCount = markets?.length ?? 0;
  const totalTvl = (liveEntries ?? []).reduce(
    (acc, m) => acc.add(m.account.collateral),
    new BN(0)
  );
  const tvlNum = parseFloat(formatUnits(totalTvl));

  return (
    <div className="container">
      <TopBar />

      <section className="hero">
        <div className="hero-content">
          <span className="eyebrow">
            <span className="dot" /> Live on {cluster}
          </span>
          <h1>
            Trade on the price of <span className="grad">compute</span>.
          </h1>
          <p className="sub">
            On-chain prediction markets for GPU rental rates, compute costs, and
            AI milestones. Take a position on where the future of compute is
            headed — settled trustlessly on Solana.
          </p>
          <div className="hero-cta">
            <Faucet className="btn" />
            <span className="small muted">
              Free test USDC — connect a wallet and trade in seconds.
            </span>
          </div>
        </div>
        <div className="hero-stats">
          <span className="stat-chip">
            <span className="num tnum">{marketCount}</span>
            <span className="lab">{marketCount === 1 ? "market" : "markets"}</span>
          </span>
          <span className="stat-chip">
            <span className="num tnum">{fmtCompact(tvlNum)}</span>
            <span className="lab">USDC TVL</span>
          </span>
          <span className="stat-chip live">
            <span className="num">●</span>
            <span className="lab">{cluster}</span>
          </span>
        </div>
      </section>

      <ComputeTicker markets={liveEntries} />

      <div className="flex-between" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>Markets</h2>
        <button className="btn secondary" onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {markets && markets.length > 0 && (
        <div className="discovery">
          <div className="cat-tabs">
            <button
              className={`cat-tab ${cat === "all" ? "active" : ""}`}
              onClick={() => setCat("all")}
            >
              All <span className="count">{counts.all}</span>
            </button>
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                className={`cat-tab ${cat === c.key ? "active" : ""}`}
                onClick={() => setCat(c.key)}
              >
                {c.short} <span className="count">{counts[c.key] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="discovery-spacer" />
          <input
            className="search-input"
            placeholder="Search markets…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search markets"
          />
          <select
            className="sort-select"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort markets"
          >
            <option value="newest">Newest</option>
            <option value="closing">Closing soon</option>
            <option value="tvl">Top TVL</option>
          </select>
        </div>
      )}

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
        <div className="empty">
          <div className="icon" aria-hidden="true">◎</div>
          <div className="title">No markets yet</div>
          <div className="desc">
            No markets have been created on this cluster. Check back soon.
          </div>
        </div>
      )}

      {loading && !markets && (
        <div className="skel-grid" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div className="skel-card" key={i}>
              <div className="skel line" style={{ width: "70%" }} />
              <div className="skel line" style={{ width: "40%" }} />
              <div className="skel bar" />
              <div className="skel line" style={{ width: "55%" }} />
              <div className="skel line" style={{ width: "50%", marginBottom: 0 }} />
            </div>
          ))}
        </div>
      )}

      {display && markets && markets.length > 0 && display.length === 0 && (
        <div className="empty">
          <div className="icon" aria-hidden="true">⌕</div>
          <div className="title">No markets match</div>
          <div className="desc">Try a different category or clear your search.</div>
        </div>
      )}

      {display &&
        display.map((m) => {
          const a = m.account;
          const scalar = isScalar(a);
          const catKey = categoryOf(a);
          // For scalar markets YES=LONG, NO=SHORT.
          const longPrice = marginal(a.reserveYes, a.reserveNo);
          const shortPrice = marginal(a.reserveNo, a.reserveYes);
          const label = marketStateLabel(a.state, a.closeTime.toNumber(), now);
          const impliedVal = scalar
            ? impliedScalarValue(longPrice, a.lowerBound, a.upperBound)
            : 0;
          const settledVal = a.state === STATE_RESOLVED ? settledScalarValue(a) : null;
          const settledFrac = settledLongFraction(a);
          return (
            <Link
              key={m.publicKey.toBase58()}
              href={`/market/${a.marketId.toString()}`}
              className="card market-card"
            >
              <div className="flex-between">
                <span className="q">{a.question}</span>
                <StateBadge label={label} />
              </div>
              <div className="kindrow" style={{ marginTop: 6 }}>
                <span className={`badge kind ${scalar ? "scalar" : "binary"}`}>
                  {marketKindLabel(a.marketKind)}
                  {scalar && (
                    <>
                      {" "}
                      [{fmtNum(a.lowerBound.toNumber())},{" "}
                      {fmtNum(a.upperBound.toNumber())}]
                    </>
                  )}
                </span>
                <span className={`badge resolver ${resolverKindClass(a.resolverKind)}`}>
                  {resolverKindLabel(a.resolverKind)}
                </span>
                <span className="badge cat">{categoryShort(catKey)}</span>
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>
                Source: {a.resolutionSource || "—"}
              </div>

              {scalar ? (
                <>
                  <ProbBar
                    long={longPrice}
                    short={shortPrice}
                    yesLabel="LONG"
                    noLabel="SHORT"
                  />
                  <div className="kv">
                    <span className="k">
                      {settledVal != null ? "Settled value" : "Implied value"}
                    </span>
                    <span>
                      {settledVal != null
                        ? fmtNum(settledVal)
                        : fmtNum(impliedVal)}
                    </span>
                  </div>
                </>
              ) : (
                <ProbBar
                  long={longPrice}
                  short={shortPrice}
                  yesLabel="YES"
                  noLabel="NO"
                />
              )}

              <div className="kv">
                <span className="k">Collateral (TVL)</span>
                <span>{formatUnits(a.collateral)} USDC</span>
              </div>
              <div className="kv">
                <span className="k">
                  Reserves ({scalar ? "LONG / SHORT" : "YES / NO"})
                </span>
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
                  <span>
                    {scalar
                      ? `Settled fraction ${
                          settledFrac != null ? formatPct(settledFrac) : "—"
                        }`
                      : a.outcome === OUTCOME_YES
                      ? "YES"
                      : "NO"}
                  </span>
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
