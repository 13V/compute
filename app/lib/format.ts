// UI helpers (not part of the copied SDK). Format/parse 6-decimal base-unit BN amounts.
import BN from "bn.js";
import { DECIMALS } from "./pdas";

const SCALE = new BN(10).pow(new BN(DECIMALS));

/** Format a base-unit BN to a human string with up to `maxFrac` decimals. */
export function formatUnits(amount: BN, maxFrac = 4): string {
  const neg = amount.isNeg();
  const abs = amount.abs();
  const whole = abs.div(SCALE).toString();
  const frac = abs.mod(SCALE).toString().padStart(DECIMALS, "0");
  let fracTrimmed = frac.slice(0, maxFrac).replace(/0+$/, "");
  const sign = neg ? "-" : "";
  return fracTrimmed.length > 0 ? `${sign}${whole}.${fracTrimmed}` : `${sign}${whole}`;
}

/** Parse a human decimal string (e.g. "12.5") into a base-unit BN, or null if invalid. */
export function parseUnits(input: string): BN | null {
  const s = input.trim();
  if (s === "") return null;
  if (!/^\d*\.?\d*$/.test(s)) return null;
  const [wholeRaw, fracRaw = ""] = s.split(".");
  const whole = wholeRaw === "" ? "0" : wholeRaw;
  if (fracRaw.length > DECIMALS) return null;
  const frac = fracRaw.padEnd(DECIMALS, "0");
  try {
    const combined = new BN(whole).mul(SCALE).add(new BN(frac || "0"));
    return combined;
  } catch {
    return null;
  }
}

/** Format a probability/price (0..1) as a percentage string. */
export function formatPct(price: number): string {
  return `${(price * 100).toFixed(1)}%`;
}

/** Shorten a base58 pubkey string for display. */
export function shortKey(key: string, edge = 4): string {
  if (key.length <= edge * 2 + 1) return key;
  return `${key.slice(0, edge)}…${key.slice(-edge)}`;
}

/** Format a unix-seconds BN/number as an absolute local datetime string. */
export function formatAbsTime(secs: BN | number): string {
  const n = typeof secs === "number" ? secs : secs.toNumber();
  if (!n) return "—";
  return new Date(n * 1000).toLocaleString();
}

/**
 * Human relative time vs `nowSecs`. Positive deltas render as "in 5m", past as
 * "3m ago". Pass the current unix seconds so callers can drive a live clock.
 */
export function formatRelTime(targetSecs: BN | number, nowSecs: number): string {
  const target = typeof targetSecs === "number" ? targetSecs : targetSecs.toNumber();
  if (!target) return "—";
  const delta = target - nowSecs;
  const abs = Math.abs(delta);
  const unit = (n: number, u: string) => `${n}${u}`;
  let s: string;
  if (abs < 60) s = unit(abs, "s");
  else if (abs < 3600) s = unit(Math.floor(abs / 60), "m");
  else if (abs < 86400) s = unit(Math.floor(abs / 3600), "h");
  else s = unit(Math.floor(abs / 86400), "d");
  return delta >= 0 ? `in ${s}` : `${s} ago`;
}

/** A short countdown like "4m 12s" (clamped at 0). */
export function formatCountdown(targetSecs: BN | number, nowSecs: number): string {
  const target = typeof targetSecs === "number" ? targetSecs : targetSecs.toNumber();
  let rem = Math.max(0, target - nowSecs);
  if (rem === 0) return "0s";
  const d = Math.floor(rem / 86400);
  rem -= d * 86400;
  const h = Math.floor(rem / 3600);
  rem -= h * 3600;
  const m = Math.floor(rem / 60);
  const s = rem - m * 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

/**
 * Derive a Solana cluster moniker from an RPC URL for explorer links + a badge.
 * Returns one of "localnet" | "devnet" | "testnet" | "mainnet".
 */
export type Cluster = "localnet" | "devnet" | "testnet" | "mainnet";
export function clusterFromRpc(rpc: string): Cluster {
  const u = rpc.toLowerCase();
  if (u.includes("devnet")) return "devnet";
  if (u.includes("testnet")) return "testnet";
  if (u.includes("localhost") || u.includes("127.0.0.1") || u.includes("0.0.0.0")) {
    return "localnet";
  }
  return "mainnet";
}

/** Build a cluster-aware explorer URL for a tx signature. */
export function explorerTxUrl(sig: string, rpc: string): string {
  const cluster = clusterFromRpc(rpc);
  const base = `https://explorer.solana.com/tx/${sig}`;
  if (cluster === "mainnet") return base;
  if (cluster === "localnet") {
    return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpc)}`;
  }
  return `${base}?cluster=${cluster}`;
}
