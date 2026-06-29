import { useMemo } from "react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ComputeClient } from "../lib/client";

/**
 * Builds an Anchor `AnchorProvider` from the connected wallet + connection and
 * wraps it in a `ComputeClient`. Returns null until a wallet is connected.
 *
 * Read-only data fetches still work without a wallet via `useReadClient`.
 */
export function useComputeClient(): ComputeClient | null {
  const { connection } = useConnection();
  const wallet = useWallet();

  return useMemo(() => {
    if (!wallet.publicKey || !wallet.signTransaction) return null;
    const provider = new AnchorProvider(
      connection,
      // The wallet-adapter wallet implements the AnchorProvider wallet shape
      // (publicKey + signTransaction + signAllTransactions).
      wallet as unknown as AnchorProvider["wallet"],
      { commitment: "confirmed" }
    );
    return new ComputeClient(provider);
  }, [connection, wallet]);
}

/**
 * A client usable for read-only fetches even before a wallet connects. Uses a
 * dummy read-only wallet so `Program` can be constructed.
 */
export function useReadClient(): ComputeClient {
  const { connection } = useConnection();

  return useMemo(() => {
    const dummy = {
      publicKey: undefined,
      signTransaction: async () => {
        throw new Error("read-only");
      },
      signAllTransactions: async () => {
        throw new Error("read-only");
      },
    };
    const provider = new AnchorProvider(
      connection,
      dummy as unknown as AnchorProvider["wallet"],
      { commitment: "confirmed" }
    );
    return new ComputeClient(provider);
  }, [connection]);
}
