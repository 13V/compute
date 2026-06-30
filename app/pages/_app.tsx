import type { AppProps } from "next/app";
import dynamic from "next/dynamic";
import Head from "next/head";
import { Inter } from "next/font/google";
import "../styles/globals.css";

// Self-host Inter at build time (no render-blocking external request).
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

// Wallet providers touch `window`/browser globals, so load them client-side only.
const WalletProviders = dynamic(
  () => import("../components/WalletProviders"),
  { ssr: false }
);

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>Compute — Prediction Markets</title>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1"
        />
      </Head>
      <div className={inter.className} style={{ minHeight: "100vh" }}>
        <WalletProviders>
          <Component {...pageProps} />
        </WalletProviders>
      </div>
    </>
  );
}
