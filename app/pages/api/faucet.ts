// Devnet/localnet test-USDC faucet. Mints demo collateral to a connected wallet
// so anyone can place their first trade with zero setup. Disabled on mainnet and
// when no faucet authority is configured.
//
// Server env:
//   FAUCET_SECRET_KEY   JSON array (id.json contents) of the mint authority.
//   FAUCET_AMOUNT       optional, whole USDC to dispense (default 25000).
//   NEXT_PUBLIC_RPC_URL the cluster RPC (shared with the client).
//   NEXT_PUBLIC_USDC_MINT optional override; otherwise read from on-chain Config.
import type { NextApiRequest, NextApiResponse } from "next";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { ComputeClient } from "../../lib/client";
import { clusterFromRpc } from "../../lib/format";

const RPC = process.env.NEXT_PUBLIC_RPC_URL || "http://127.0.0.1:8899";
const AMOUNT = Number(process.env.FAUCET_AMOUNT || "25000");
const COOLDOWN_MS = 60_000;

// In-memory per-owner cooldown (best-effort; resets on redeploy).
const lastDrip: Record<string, number> = {};

function loadAuthority(): Keypair | null {
  const raw = process.env.FAUCET_SECRET_KEY;
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    return null;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }
  if (clusterFromRpc(RPC) === "mainnet") {
    return res.status(403).json({ error: "faucet is disabled on mainnet" });
  }
  const authority = loadAuthority();
  if (!authority) {
    return res
      .status(503)
      .json({ error: "faucet not configured (set FAUCET_SECRET_KEY)" });
  }

  let owner: PublicKey;
  try {
    owner = new PublicKey((req.body?.owner ?? "").toString());
  } catch {
    return res.status(400).json({ error: "invalid owner pubkey" });
  }

  const key = owner.toBase58();
  const now = Date.now();
  if (lastDrip[key] && now - lastDrip[key] < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - lastDrip[key])) / 1000);
    return res.status(429).json({ error: `try again in ${wait}s` });
  }

  try {
    const connection = new Connection(RPC, "confirmed");
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(authority),
      { commitment: "confirmed" }
    );
    const client = new ComputeClient(provider);

    const mint = process.env.NEXT_PUBLIC_USDC_MINT
      ? new PublicKey(process.env.NEXT_PUBLIC_USDC_MINT)
      : (await client.fetchConfig()).collateralMint;

    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      authority,
      mint,
      owner
    );
    const sig = await mintTo(
      connection,
      authority,
      mint,
      ata.address,
      authority,
      BigInt(Math.round(AMOUNT * 1_000_000))
    );
    lastDrip[key] = now;
    return res.status(200).json({ signature: sig, amount: AMOUNT, mint: mint.toBase58() });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? "faucet failed" });
  }
}
