import dynamic from "next/dynamic";
import Link from "next/link";
import { RPC_URL } from "./WalletProviders";

// WalletMultiButton renders browser-only; load without SSR.
const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (m) => m.WalletMultiButton
    ),
  { ssr: false }
);

export default function TopBar() {
  return (
    <div className="topbar">
      <Link href="/" className="brand">
        <h1>Compute</h1>
        <span className="tag">prediction markets · {RPC_URL.replace(/^https?:\/\//, "")}</span>
      </Link>
      <WalletMultiButton />
    </div>
  );
}
