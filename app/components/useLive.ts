// Real-time market data via account subscriptions. When a market's on-chain
// account changes (someone trades, LPs, or it resolves), we re-fetch and push
// the decoded account so the UI ticks live without a refresh button.
import { useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useReadClient } from "./useComputeClient";
import type { MarketAccount, MarketEntry } from "./types";

/**
 * Subscribe to a single market account. Returns the latest decoded account,
 * seeded with `initial`. `flash` increments on each update so callers can
 * trigger a tick animation.
 */
export function useLiveMarket(
  pubkey: PublicKey | null,
  initial: MarketAccount | null
): { account: MarketAccount | null; flash: number } {
  const { connection } = useConnection();
  const client = useReadClient();
  const [account, setAccount] = useState<MarketAccount | null>(initial);
  const [flash, setFlash] = useState(0);

  useEffect(() => {
    setAccount(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial && JSON.stringify({ y: initial.reserveYes, n: initial.reserveNo })]);

  useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    const id = connection.onAccountChange(
      pubkey,
      async () => {
        try {
          const acct = (await client.program.account.market.fetch(
            pubkey
          )) as unknown as MarketAccount;
          if (!cancelled) {
            setAccount(acct);
            setFlash((f) => f + 1);
          }
        } catch {
          /* transient; ignore */
        }
      },
      { commitment: "confirmed" }
    );
    return () => {
      cancelled = true;
      connection.removeAccountChangeListener(id);
    };
  }, [pubkey?.toBase58(), connection, client]);

  return { account, flash };
}

/**
 * Subscribe to every market in `entries`. Returns a map keyed by market pubkey
 * (base58) of the latest decoded account, plus a monotonically increasing
 * `version` that bumps whenever any market updates.
 */
export function useLiveMarkets(entries: MarketEntry[] | null): {
  live: Record<string, MarketAccount>;
  version: number;
} {
  const { connection } = useConnection();
  const client = useReadClient();
  const [live, setLive] = useState<Record<string, MarketAccount>>({});
  const [version, setVersion] = useState(0);
  const keysRef = useRef<string>("");

  // Seed the map from the initial fetch.
  useEffect(() => {
    if (!entries) return;
    const seed: Record<string, MarketAccount> = {};
    for (const e of entries) seed[e.publicKey.toBase58()] = e.account;
    setLive(seed);
  }, [entries]);

  useEffect(() => {
    if (!entries || entries.length === 0) return;
    const keys = entries.map((e) => e.publicKey.toBase58()).sort().join(",");
    keysRef.current = keys;
    let cancelled = false;
    const ids = entries.map((e) =>
      connection.onAccountChange(
        e.publicKey,
        async () => {
          try {
            const acct = (await client.program.account.market.fetch(
              e.publicKey
            )) as unknown as MarketAccount;
            if (cancelled) return;
            setLive((prev) => ({ ...prev, [e.publicKey.toBase58()]: acct }));
            setVersion((v) => v + 1);
          } catch {
            /* ignore */
          }
        },
        { commitment: "confirmed" }
      )
    );
    return () => {
      cancelled = true;
      ids.forEach((id) => connection.removeAccountChangeListener(id));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries?.map((e) => e.publicKey.toBase58()).sort().join(","), connection, client]);

  return { live, version };
}
