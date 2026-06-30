import dynamic from "next/dynamic";
import Link from "next/link";
import { RPC_URL } from "./WalletProviders";
import { clusterFromRpc } from "../lib/format";
import styles from "./Portfolio.module.css";

// WalletMultiButton renders browser-only; load without SSR.
const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (m) => m.WalletMultiButton
    ),
  { ssr: false }
);

export default function TopBar() {
  const cluster = clusterFromRpc(RPC_URL);
  return (
    <div className="topbar">
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Link href="/" className="brand" aria-label="Compute — home">
          <span className="glyph" aria-hidden="true" />
          <span className="wordmark">
            <h1>Compute</h1>
            <span className="tag">
              prediction markets{" "}
              <span className={`badge cluster ${cluster}`}>{cluster}</span>
            </span>
          </span>
        </Link>
        <Link href="/portfolio" className={styles.navlink}>
          Portfolio
        </Link>
      </div>
      <WalletMultiButton />
    </div>
  );
}
