// Global transaction-lifecycle toasts. Every signing action routes through
// useTxRunner(), which shows a toast that progresses building → signing →
// confirming → confirmed (with an Explorer link) or surfaces a decoded error.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction, TransactionInstruction } from "@solana/web3.js";
import { RPC_URL } from "./WalletProviders";
import { explorerTxUrl } from "../lib/format";
import { computeBudgetIxs } from "./priorityFee";

export type TxStatus = "building" | "signing" | "confirming" | "success" | "error";

export interface Toast {
  id: number;
  label: string;
  status: TxStatus;
  sig?: string;
  message?: string;
}

interface ToastCtx {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => number;
  update: (id: number, patch: Partial<Toast>) => void;
  dismiss: (id: number) => void;
  /** Fire-and-forget info/success/error toast (no tx). */
  notify: (label: string, status?: TxStatus, message?: string) => number;
}

const Ctx = createContext<ToastCtx | null>(null);

export function TxProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    const tm = timers.current[id];
    if (tm) {
      clearTimeout(tm);
      delete timers.current[id];
    }
  }, []);

  const scheduleAutoDismiss = useCallback(
    (id: number, ms: number) => {
      const existing = timers.current[id];
      if (existing) clearTimeout(existing);
      timers.current[id] = setTimeout(() => dismiss(id), ms);
    },
    [dismiss]
  );

  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = nextId.current++;
    setToasts((ts) => [...ts, { ...t, id }]);
    return id;
  }, []);

  const update = useCallback(
    (id: number, patch: Partial<Toast>) => {
      setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      if (patch.status === "success") scheduleAutoDismiss(id, 7000);
    },
    [scheduleAutoDismiss]
  );

  const notify = useCallback(
    (label: string, status: TxStatus = "success", message?: string) => {
      const id = push({ label, status, message });
      if (status === "success") scheduleAutoDismiss(id, 5000);
      return id;
    },
    [push, scheduleAutoDismiss]
  );

  const value = useMemo(
    () => ({ toasts, push, update, dismiss, notify }),
    [toasts, push, update, dismiss, notify]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <ToastHost />
    </Ctx.Provider>
  );
}

export function useToasts(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToasts must be used within <TxProvider>");
  return ctx;
}

export interface RunOpts {
  /** Short human label, e.g. "Buy YES · Market #2". */
  label: string;
  /** Builds the instructions to send. */
  build: () => Promise<TransactionInstruction[]>;
  /** Optional program-error decoder (e.g. client.parseError). */
  parseError?: (e: any) => string;
  /** Called after on-chain confirmation. */
  onSuccess?: (sig: string) => void | Promise<void>;
}

/**
 * Returns a `run()` that builds, signs, sends, and confirms a transaction while
 * driving a lifecycle toast. Resolves to the signature, or null on error.
 */
export function useTxRunner(): (opts: RunOpts) => Promise<string | null> {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { push, update } = useToasts();

  return useCallback(
    async (opts: RunOpts) => {
      const id = push({ label: opts.label, status: "building" });
      try {
        if (!wallet.publicKey || !wallet.sendTransaction) {
          throw new Error("Connect a wallet first.");
        }
        const ixs = await opts.build();
        // Prepend priority fee + compute-unit budget for reliability under load.
        const budget = await computeBudgetIxs(connection, wallet.publicKey, ixs);
        update(id, { status: "signing" });

        const tx = new Transaction().add(...budget, ...ixs);
        tx.feePayer = wallet.publicKey;
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;

        const sig = await wallet.sendTransaction(tx, connection);
        update(id, { status: "confirming", sig });

        await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "confirmed"
        );
        update(id, { status: "success", sig });
        await opts.onSuccess?.(sig);
        return sig;
      } catch (e: any) {
        const message = opts.parseError
          ? opts.parseError(e)
          : e?.message ?? String(e);
        update(id, { status: "error", message });
        return null;
      }
    },
    [connection, wallet, push, update]
  );
}

const STATUS_TEXT: Record<TxStatus, string> = {
  building: "Preparing…",
  signing: "Approve in your wallet…",
  confirming: "Confirming on-chain…",
  success: "Confirmed",
  error: "Failed",
};

function ToastHost() {
  const ctx = useContext(Ctx);
  if (!ctx) return null;
  const { toasts, dismiss } = ctx;
  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((t) => {
        const pending =
          t.status === "building" ||
          t.status === "signing" ||
          t.status === "confirming";
        return (
          <div key={t.id} className={`toast ${t.status}`} role="status">
            <div className="toast-icon" aria-hidden>
              {pending ? (
                <span className="spinner" />
              ) : t.status === "success" ? (
                "✓"
              ) : (
                "✕"
              )}
            </div>
            <div className="toast-body">
              <div className="toast-label">{t.label}</div>
              <div className="toast-sub">
                {t.status === "error"
                  ? t.message ?? STATUS_TEXT.error
                  : STATUS_TEXT[t.status]}
              </div>
              {t.sig && (
                <a
                  className="toast-link"
                  href={explorerTxUrl(t.sig, RPC_URL)}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on Explorer ↗
                </a>
              )}
            </div>
            <button
              className="toast-x"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
