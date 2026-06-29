import { useEffect, useState } from "react";
import { shortKey } from "../lib/format";
import {
  STATE_OPEN,
  STATE_RESOLVING,
  STATE_RESOLVED,
  STATE_VOID,
} from "../lib/pdas";

/** A live unix-seconds clock that ticks every second (client-side only). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export interface StateLabel {
  text: string;
  cls: string;
}

/**
 * Map (state, closeTime, now) → a badge label. An OPEN market past its close
 * time renders as "Closed" even though the on-chain state is still OPEN.
 */
export function marketStateLabel(
  state: number,
  closeTimeSecs: number,
  now: number
): StateLabel {
  switch (state) {
    case STATE_OPEN:
      return now >= closeTimeSecs
        ? { text: "Closed", cls: "closed" }
        : { text: "Open", cls: "open" };
    case STATE_RESOLVING:
      return { text: "Resolving", cls: "resolving" };
    case STATE_RESOLVED:
      return { text: "Resolved", cls: "resolved" };
    case STATE_VOID:
      return { text: "Void", cls: "void" };
    default:
      return { text: "Unknown", cls: "" };
  }
}

export function StateBadge({ label }: { label: StateLabel }) {
  return <span className={`badge ${label.cls}`}>{label.text}</span>;
}

/** A pubkey chip with a copy button. */
export function CopyKey({
  value,
  label,
  short = true,
}: {
  value: string;
  label?: string;
  short?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard may be unavailable; ignore */
    }
  };
  return (
    <span className="copykey">
      {label && <span className="muted">{label} </span>}
      <span className="mono" title={value}>
        {short ? shortKey(value) : value}
      </span>
      <button
        type="button"
        className="copybtn"
        onClick={copy}
        aria-label={`Copy ${label ?? "value"}`}
        title="Copy"
      >
        {copied ? "✓" : "copy"}
      </button>
    </span>
  );
}
