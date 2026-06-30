// "Get test USDC" button — calls the devnet/localnet faucet API route so a user
// can fund their wallet and trade immediately. Hidden on mainnet.
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useToasts } from "./tx";
import { RPC_URL } from "./WalletProviders";
import { clusterFromRpc } from "../lib/format";

export default function Faucet({ className }: { className?: string }) {
  const wallet = useWallet();
  const { notify } = useToasts();
  const [busy, setBusy] = useState(false);
  const cluster = clusterFromRpc(RPC_URL);

  if (cluster === "mainnet") return null;

  const drip = async () => {
    if (!wallet.publicKey) {
      notify("Connect a wallet to receive test USDC", "error");
      return;
    }
    setBusy(true);
    const id = notify("Requesting test USDC…", "confirming");
    try {
      const r = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: wallet.publicKey.toBase58() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "faucet failed");
      notify(`+${(data.amount ?? 0).toLocaleString()} test USDC`, "success");
    } catch (e: any) {
      notify(e?.message ?? "faucet failed", "error");
    } finally {
      // The "confirming" toast auto-clears via the success/error replacement.
      void id;
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={className ?? "btn secondary"}
      onClick={drip}
      disabled={busy}
      title="Mint demo USDC to your wallet"
    >
      {busy ? "Dripping…" : "Get test USDC"}
    </button>
  );
}
