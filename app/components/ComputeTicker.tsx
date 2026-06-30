// A scrolling "compute index" ticker strip: live oracle-feed values plus the
// implied $/hr from scalar GPU markets. Makes the theme unmistakable.
import { useEffect, useState } from "react";
import { useReadClient } from "./useComputeClient";
import { isScalar, impliedScalarValue } from "./market";
import { marginalPrice } from "../lib/amm";
import type { MarketEntry } from "./types";

interface TickItem {
  label: string;
  value: string;
}

function feedValue(value: any, decimals: number): number {
  const n = Number(value?.toString?.() ?? value);
  return n / 10 ** decimals;
}

export default function ComputeTicker({ markets }: { markets: MarketEntry[] | null }) {
  const client = useReadClient();
  const [feeds, setFeeds] = useState<TickItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = (await client.program.account.priceFeed.all()) as any[];
        if (cancelled) return;
        const items = all.map((f) => {
          const a = f.account;
          const dec = Number(a.decimals);
          const v = feedValue(a.value, dec);
          const isPrice = dec >= 2;
          return {
            label: String(a.description || "feed"),
            value: isPrice ? `$${v.toFixed(2)}` : v.toLocaleString(),
          };
        });
        setFeeds(items);
      } catch {
        /* feeds optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Implied $/hr from scalar GPU markets (bounds stored in cents → /100).
  const implied: TickItem[] = (markets ?? [])
    .filter((m) => isScalar(m.account) && /\$\/hr/i.test(m.account.question))
    .map((m) => {
      const a = m.account;
      const long = marginalPrice(a.reserveYes, a.reserveNo);
      const val = impliedScalarValue(long, a.lowerBound, a.upperBound) / 100;
      const chip = a.question.match(/H100|H200|B200|A100|MI300X/i)?.[0] ?? "GPU";
      return { label: `${chip} $/hr`, value: `$${val.toFixed(2)}` };
    });

  const items = [...implied, ...feeds];
  if (items.length === 0) return null;

  // Duplicate the row so the marquee loops seamlessly.
  const row = [...items, ...items];

  return (
    <div className="ticker" aria-label="Live compute prices">
      <div className="ticker-track">
        {row.map((it, i) => (
          <span className="tick" key={i}>
            <span className="tick-label">{it.label}</span>
            <span className="tick-value">{it.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
