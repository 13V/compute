// A compact YES-probability price chart backed by lightweight-charts. Renders
// client-side only (canvas). Feed it PricePoint[] (oldest→newest).
import { useEffect, useRef } from "react";
import type { PricePoint } from "./history";

export default function PriceChart({
  points,
  height = 240,
  color = "#2ec28a",
}: {
  points: PricePoint[];
  height?: number;
  color?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || points.length === 0) return;
    let chart: any;
    let ro: ResizeObserver | undefined;
    let disposed = false;

    (async () => {
      const lc = await import("lightweight-charts");
      if (disposed || !ref.current) return;
      const { createChart, ColorType, LineStyle } = lc as any;
      chart = createChart(el, {
        height,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: "#8a93a6",
          fontFamily:
            "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
        },
        grid: {
          vertLines: { color: "rgba(40,50,68,0.35)" },
          horzLines: { color: "rgba(40,50,68,0.35)" },
        },
        rightPriceScale: { borderColor: "rgba(40,50,68,0.6)" },
        timeScale: {
          borderColor: "rgba(40,50,68,0.6)",
          timeVisible: true,
          secondsVisible: false,
        },
        crosshair: {
          horzLine: { labelBackgroundColor: color },
          vertLine: { labelBackgroundColor: color, style: LineStyle?.Dotted ?? 2 },
        },
        handleScale: false,
        handleScroll: false,
      });

      const series = chart.addAreaSeries({
        lineColor: color,
        lineWidth: 2,
        topColor: "rgba(46,194,138,0.28)",
        bottomColor: "rgba(46,194,138,0.02)",
        priceFormat: { type: "custom", formatter: (v: number) => `${v.toFixed(1)}%` },
        priceLineVisible: true,
        lastValueVisible: true,
      });

      // lightweight-charts requires strictly ascending, unique time keys.
      let lastT = 0;
      const data = points
        .map((p) => ({ time: Math.floor(p.time), value: Math.max(0.1, Math.min(99.9, p.price * 100)) }))
        .map((d) => {
          if (d.time <= lastT) d.time = lastT + 1;
          lastT = d.time;
          return d;
        });
      series.setData(data);
      chart.timeScale().fitContent();

      ro = new ResizeObserver(() => {
        if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
      });
      ro.observe(el);
      chart.applyOptions({ width: el.clientWidth });
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      if (chart) chart.remove();
    };
  }, [points, height, color]);

  if (points.length === 0) {
    return (
      <div className="chart-empty">
        No trades yet — the price line appears once trading starts.
      </div>
    );
  }
  return <div className="price-chart" ref={ref} style={{ height }} />;
}
