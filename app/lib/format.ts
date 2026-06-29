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
