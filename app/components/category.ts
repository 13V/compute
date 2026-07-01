// Derive a display category for a market from its question + resolution source.
// The on-chain account has no category field, so we classify by keywords. Keep
// this aligned with the seed catalog themes.
import type { MarketAccount } from "./types";

export type CategoryKey = "gpu" | "ai" | "hardware" | "cloud" | "other";

export interface Category {
  key: CategoryKey;
  label: string;
  /** Short label for the filter chip. */
  short: string;
}

export const CATEGORIES: Category[] = [
  { key: "gpu", label: "GPU rental rates", short: "GPU rental" },
  { key: "ai", label: "AI capability milestones", short: "AI milestones" },
  { key: "hardware", label: "Hardware supply & power", short: "Hardware & power" },
  { key: "cloud", label: "Cloud spot & inference", short: "Cloud & inference" },
];

const MATCHERS: { key: CategoryKey; re: RegExp }[] = [
  // Cloud spot / inference cost first (more specific than the bare GPU names).
  { key: "cloud", re: /\b(aws|p5|gcp|a3|azure|spot|inference|\$\/m|per[- ]token)\b/i },
  { key: "hardware", re: /\b(nvidia|tsmc|cowos|hbm|wafer|blackwell|rubin|power|datacenter|data center|grid|gw|capex|fab|supply)\b/i },
  { key: "ai", re: /\b(model|frontier|gpt|lmarena|elo|swe-?bench|benchmark|open-?weights|agi|reasoning|capability)\b/i },
  { key: "gpu", re: /\b(h100|h200|b200|gb200|a100|mi300|gpu|neocloud|\$\/hr|per[- ]hour|rental)\b/i },
];

/** Classify a market into a category. */
export function categoryOf(m: Pick<MarketAccount, "question" | "resolutionSource">): CategoryKey {
  const hay = `${m.question} ${m.resolutionSource}`;
  for (const { key, re } of MATCHERS) {
    if (re.test(hay)) return key;
  }
  return "other";
}

export function categoryLabel(key: CategoryKey): string {
  return CATEGORIES.find((c) => c.key === key)?.label ?? "Other";
}

export function categoryShort(key: CategoryKey): string {
  return CATEGORIES.find((c) => c.key === key)?.short ?? "Other";
}
