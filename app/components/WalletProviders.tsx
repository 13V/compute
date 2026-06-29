import React, { FC, ReactNode, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import type { Adapter } from "@solana/wallet-adapter-base";

// wallet-adapter-react-ui styles for the WalletMultiButton + modal.
import "@solana/wallet-adapter-react-ui/styles.css";

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "http://localhost:8899";

/**
 * Wraps the app in Connection + Wallet + WalletModal providers.
 * Phantom / Solflare and any wallet-standard wallets auto-register, so we pass
 * an empty adapter array and let wallet-standard discovery do the work.
 */
const WalletProviders: FC<{ children: ReactNode }> = ({ children }) => {
  const endpoint = RPC_URL;

  // Empty array: wallet-standard wallets (Phantom, Solflare, Backpack, ...)
  // are auto-detected by @solana/wallet-adapter-react.
  const wallets = useMemo<Adapter[]>(() => [], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};

// Re-export network enum in case callers want it; keeps tree-shaking happy.
export { WalletAdapterNetwork };
export default WalletProviders;
