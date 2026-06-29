import type { AppProps } from "next/app";
import dynamic from "next/dynamic";
import Head from "next/head";
import "../styles/globals.css";

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
      <WalletProviders>
        <Component {...pageProps} />
      </WalletProviders>
    </>
  );
}
