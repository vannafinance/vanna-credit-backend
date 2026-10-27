"use client";

/**
 * Conversation state for the /copilot page: the session, the thread, and one run controller per plan.
 *
 * The server is the source of truth. This hook keeps the words (in this browser, for Recents) and
 * drives server-held plans through `createRunController`; it never computes an amount, a quote or a
 * health factor, and it never sends a wallet address in a request body.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet as useAdapterWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatResponse, PlanStepView, PlanView } from "@/lib/copilot/types";
import { cancelPlan, getSession, getStatusLines, logout, sendChat } from "./api";
import {
  isLocalId,
  loadActiveId,
  loadConversations,
  newLocalId,
  saveActiveId,
  saveConversations,
  summarize,
  titleFrom,
  type Conversation,
  type ConversationSummary,
  type StoredRun,
  type Turn,
} from "./conversations";
import { createRunController, initialRunState, type RunController, type RunState } from "./run";
import { signInWithWallet, SignInCancelledError } from "./siws";
import { autoSignIn } from "./auto-signin";
import { COPILOT_SESSION_EVENT } from "@/components/copilot/wallet-session";
import { getActiveSigner } from "@/lib/solana/wallet-bridge";
import { refreshWalletBalancesOnChain } from "@/hooks/use-wallet";
import { refreshMarginAccount } from "@/store/margin-account-info-store";

export type SessionStatus =
  | { state: "loading" }
  | { state: "signed_in"; wallet: string; expiresAt: number | null }
  | { state: "signed_out" }
  /** The server could not be reached: shown as disconnected, never as signed in or out. */
  | { state: "unreachable" };

const HISTORY_TURNS = 8;
const uid = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A `needs_wallet_sign` answer for a single action should carry its one-step plan. If the server
 * sent only the transaction, the card still needs a step to hang the signature on; nothing in it is
 * invented beyond what the response already said.
 */
function planForSingleAction(res: ChatResponse): PlanView | null {
  if (res.plan) return res.plan;
  if (!res.workflow_id || !res.unsigned_tx) return null;
  const slots = res.preview?.slots ?? {};
  const step: PlanStepView = {
    n: 1,
    kind: "write",
    op: res.preview?.template_id ?? "action",
    asset: typeof slots.asset === "string" ? slots.asset : null,
    amount: slots.amount != null ? String(slots.amount) : null,
    label: res.preview?.human_summary ?? res.message,
    venue: "other",
    status: "awaiting_signature",
  };
  const now = Date.now();
  return {
    plan_id: res.workflow_id,
    digest: "",
    summary: step.label,
    created_at: now,
    expires_at: now,
    signature_count: 1,
    warnings: [],
    hf_floor: 1.15,
    state: "running",
    steps: [step],
    simulation: res.preview?.simulation ?? null,
  };
}

/** How a run ended, for the stored chat; null while it can still go on. */
function outcomeOf(state: RunState): StoredRun["outcome"] | null {
  switch (state.phase) {
    case "completed":
    case "failed":
    case "cancelled":
    case "expired":
      return state.phase;
    case "awaiting_signature":
      return state.rejected ? "declined" : null;
    default:
      return null;
  }
}

const DECLINED_MESSAGE = "You declined this in your wallet, so the plan stopped. Nothing further will be sent; ask again for a fresh plan.";

export function useCopilot() {
  const adapter = useAdapterWallet();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<SessionStatus>({ state: "loading" });
  const [items, setItems] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [signInBusy, setSignInBusy] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  /** Progress lines the model worded for the prompt in flight; empty until they arrive (or if they never do). */
  const [statusLines, setStatusLines] = useState<string[]>([]);
  const statusSeq = useRef(0);

  const controllers = useRef(new Map<string, RunController>());
  const abortRef = useRef<AbortController | null>(null);
  const retryRef = useRef<{ text: string; clarify?: { pending_id: string; option_id: string } } | null>(null);
  const sessionRef = useRef(session);
  const itemsRef = useRef(items);
  const activeRef = useRef(activeId);
  useEffect(() => {
    sessionRef.current = session;
    itemsRef.current = items;
    activeRef.current = activeId;
  });
  const busyRef = useRef(false);

  const sessionWallet = session.state === "signed_in" ? session.wallet : null;

  // ── session ───────────────────────────────────────────────────────────────
  const refreshSession = useCallback(async () => {
    try {
      const res = await getSession();
      if (res.authenticated && res.wallet) {
        setSession({ state: "signed_in", wallet: res.wallet, expiresAt: res.expires_at ?? null });
      } else {
        setSession({ state: "signed_out" });
        // A wallet that is already connected on the site should not be asked to sign in through a card: prove it here too
        // (shared with the site-wide component, so there is never a second prompt, and a "no" is respected).
        const wallet = adapter.publicKey?.toBase58();
        if (wallet && adapter.connected && adapter.signMessage) {
          const proved = await autoSignIn({ wallet, signMessage: adapter.signMessage });
          if (proved?.authenticated && proved.wallet) {
            setSession({ state: "signed_in", wallet: proved.wallet, expiresAt: proved.expires_at ?? null });
          }
        }
      }
    } catch {
      setSession({ state: "unreachable" });
    }
  }, [adapter.publicKey, adapter.connected, adapter.signMessage]);

  useEffect(() => {
    void refreshSession();
    // The site signs a connecting wallet in by itself; pick that session up without a reload.
    const onSession = () => void refreshSession();
    window.addEventListener(COPILOT_SESSION_EVENT, onSession);
    return () => window.removeEventListener(COPILOT_SESSION_EVENT, onSession);
  }, [refreshSession]);

  // ── history (browser only, per signed-in wallet) ──────────────────────────
  useEffect(() => {
    if (session.state === "loading") return;
    const scope = sessionWallet;
    if (loadedFor === scope) return;
    // Signed-out chats live in memory only. Signing in adopts the one on screen (a pending
    // "sign in to continue" turn must survive it) next to that wallet's stored history.
    const adopting = loadedFor === null && scope !== null;
    const stored = scope ? loadConversations(scope) : [];
    setItems((prev) => (adopting ? [...prev, ...stored.filter((s) => !prev.some((p) => p.id === s.id))] : stored));
    if (!adopting) {
      // Coming back to /copilot from another page reopens the chat that was open, not a blank one.
      const remembered = scope ? loadActiveId(scope) : null;
      setActiveId(remembered && stored.some((c) => c.id === remembered) ? remembered : null);
    }
    setLoadedFor(scope);
  }, [session.state, sessionWallet, loadedFor]);

  useEffect(() => {
    if (!sessionWallet || loadedFor !== sessionWallet) return;
    saveActiveId(sessionWallet, activeId);
  }, [activeId, loadedFor, sessionWallet]);

  useEffect(() => {
    if (!sessionWallet || loadedFor !== sessionWallet) return;
    saveConversations(sessionWallet, items);
  }, [items, loadedFor, sessionWallet]);

  const active = useMemo(() => items.find((c) => c.id === activeId) ?? null, [items, activeId]);
  const turns = active?.turns ?? [];
  const conversations: ConversationSummary[] = useMemo(() => summarize(items), [items]);

  // ── runs ──────────────────────────────────────────────────────────────────
  const afterSettled = useCallback(() => {
    // A confirmed step changed balances and possibly health: re-read them from chain.
    const wallet = sessionRef.current.state === "signed_in" ? sessionRef.current.wallet : null;
    if (!wallet) return;
    void refreshWalletBalancesOnChain(wallet).catch(() => {});
    void refreshMarginAccount(wallet).catch(() => {});
    // Predict positions and CASH (the rail's Predict list and the Predict page share this query).
    void queryClient.invalidateQueries({ queryKey: ["predict"] }).catch(() => {});
  }, [queryClient]);

  /**
   * Writes how a plan ended into the turn that proposed it (and the plan as last seen, so its steps read right), so
   * a reopened chat shows it stopped instead of offering buttons for something already finished or abandoned.
   */
  const persisted = useRef(new Map<string, string>());
  const persistOutcome = useCallback((workflowId: string, state: RunState) => {
    const outcome = outcomeOf(state);
    const key = outcome ? `${outcome}|${state.message ?? ""}|${state.plan.steps.map((st) => st.status).join(",")}` : "";
    if ((persisted.current.get(workflowId) ?? "") === key) return;
    persisted.current.set(workflowId, key);
    const run: StoredRun | undefined = outcome ? { outcome, message: state.message, at: Date.now() } : undefined;
    setItems((prev) =>
      prev.map((c) =>
        c.turns.some((t) => t.response?.workflow_id === workflowId)
          ? {
              ...c,
              turns: c.turns.map((t) => {
                if (t.response?.workflow_id !== workflowId) return t;
                const { run: _old, ...rest } = t;
                void _old;
                return { ...rest, ...(run ? { run } : {}), response: { ...t.response, plan: state.plan } };
              }),
            }
          : c,
      ),
    );
  }, []);

  const register = useCallback(
    (workflowId: string, initial: RunState): RunController => {
      const existing = controllers.current.get(workflowId);
      if (existing) return existing;
      const controller = createRunController({
        initial,
        onState: (state) => {
          setRuns((prev) => ({ ...prev, [workflowId]: state }));
          persistOutcome(workflowId, state);
        },
        onSettled: afterSettled,
        signTransaction: async (tx) => {
          const signer = getActiveSigner();
          const signedIn = sessionRef.current.state === "signed_in" ? sessionRef.current.wallet : null;
          if (signedIn && signer.publicKey.toBase58() !== signedIn) {
            throw new Error("The connected wallet is not the wallet you signed in with. Switch back to it or sign in again.");
          }
          return signer.signTransaction(tx);
        },
        signAllTransactions: async (txs) => {
          const signer = getActiveSigner();
          const signedIn = sessionRef.current.state === "signed_in" ? sessionRef.current.wallet : null;
          if (signedIn && signer.publicKey.toBase58() !== signedIn) {
            throw new Error("The connected wallet is not the wallet you signed in with. Switch back to it or sign in again.");
          }
          return signer.signAllTransactions(txs);
        },
      });
      controllers.current.set(workflowId, controller);
      setRuns((prev) => ({ ...prev, [workflowId]: initial }));
      return controller;
    },
    [afterSettled, persistOutcome],
  );

  const adoptResponse = useCallback(
    (res: ChatResponse) => {
      if (!res.workflow_id) return;
      const plan = planForSingleAction(res);
      if (!plan) return;
      const initial = initialRunState(res.workflow_id, plan);
      if (res.kind === "needs_wallet_sign" && res.unsigned_tx) {
        const step = plan.steps.find((s) => s.status === "awaiting_signature") ?? plan.steps[0];
        if (step) {
          register(res.workflow_id, { ...initial, phase: "awaiting_signature", pending: { step, tx: res.unsigned_tx } });
          return;
        }
      }
      register(res.workflow_id, initial);
    },
    [register],
  );

  // Reopened conversations: rebuild each plan card from the stored view, then ask the server where it is.
  useEffect(() => {
    if (!active) return;
    for (const turn of active.turns) {
      const res = turn.response;
      if (!res?.workflow_id || !res.plan || controllers.current.has(res.workflow_id)) continue;
      const restored = initialRunState(res.workflow_id, res.plan);
      const ended = turn.run;
      if (ended) {
        // It already ended in this browser: show that, with no buttons. Not re-read from the server, which may still
        // list a plan the user declined in the wallet as running; that one is ended there now too.
        const declined = ended.outcome === "declined";
        persisted.current.set(res.workflow_id, `${declined ? "cancelled" : ended.outcome}|${declined ? DECLINED_MESSAGE : ended.message ?? ""}|${res.plan.steps.map((st) => st.status).join(",")}`);
        const phase: RunState["phase"] = ended.outcome === "declined" ? "cancelled" : ended.outcome;
        register(res.workflow_id, { ...restored, phase, message: declined ? DECLINED_MESSAGE : ended.message });
        if (declined) void cancelPlan(res.workflow_id).catch(() => {});
        continue;
      }
      const controller = register(
        res.workflow_id,
        restored.phase === "paused" && !restored.message
          ? { ...restored, message: "This plan was left mid-run. Re-check it to pick up where it stopped." }
          : restored,
      );
      void controller.refresh();
    }
  }, [active, register]);

  // ── conversation plumbing ─────────────────────────────────────────────────
  const mutate = useCallback((id: string, fn: (c: Conversation) => Conversation) => {
    setItems((prev) => prev.map((c) => (c.id === id ? fn(c) : c)));
  }, []);

  const send = useCallback(
    async (text: string, opts?: { clarify?: { pending_id: string; option_id: string }; replaceLast?: boolean }) => {
      const message = text.trim();
      if (!message || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      abortRef.current = new AbortController();

      // While the answer is worked out, the model words a few lines about what it is doing for THIS prompt. Cosmetic
      // and best effort: it runs beside the real request and never delays or changes it.
      const seq = ++statusSeq.current;
      setStatusLines([]);
      if (sessionRef.current.state === "signed_in") {
        const signal = abortRef.current.signal;
        void getStatusLines(message, signal).then((lines) => {
          if (statusSeq.current === seq && busyRef.current && lines.length) setStatusLines(lines);
        });
      }

      let convId = activeRef.current;
      const now = Date.now();
      const userTurn: Turn = { id: uid(), role: "user", text: message, at: now };
      let prior: Turn[] = [];
      if (!convId) {
        convId = newLocalId();
        const created: Conversation = { id: convId, title: titleFrom(message), updatedAt: now, turns: [userTurn] };
        setItems((prev) => [created, ...prev]);
        setActiveId(convId);
      } else {
        const current = itemsRef.current.find((c) => c.id === convId);
        prior = current?.turns ?? [];
        if (opts?.replaceLast) prior = prior.slice(0, -2);
        const base = prior;
        mutate(convId, (c) => ({ ...c, updatedAt: now, turns: [...base, userTurn] }));
      }
      const id = convId;

      const history = prior
        .filter((t) => t.text)
        .slice(-HISTORY_TURNS)
        .map((t) => ({ role: t.role, text: t.text }));

      let res: ChatResponse;
      try {
        res = await sendChat(
          {
            message,
            conversation_id: isLocalId(id) ? null : id,
            history: history.length ? history : null,
            surface: "copilot",
            clarify: opts?.clarify ?? null,
          },
          abortRef.current.signal,
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          res = { kind: "error", message: "Stopped. Nothing was sent to your wallet." };
        } else {
          res = { kind: "error", message: "Something went wrong reaching the Copilot. Nothing was sent to your wallet." };
        }
      }

      if (res.kind === "needs_login") {
        retryRef.current = { text: message, ...(opts?.clarify ? { clarify: opts.clarify } : {}) };
        setSession((s) => (s.state === "signed_in" ? { state: "signed_out" } : s.state === "unreachable" ? s : { state: "signed_out" }));
      } else if (sessionRef.current.state === "unreachable") {
        void refreshSession();
      }

      adoptResponse(res);

      const assistant: Turn = { id: uid(), role: "assistant", text: res.message, at: Date.now(), response: res };
      const serverId = res.conversation_id && res.conversation_id !== id ? res.conversation_id : null;
      setItems((prev) =>
        prev.map((c) =>
          c.id === id ? { ...c, id: serverId ?? c.id, updatedAt: Date.now(), turns: [...c.turns, assistant] } : c,
        ),
      );
      if (serverId) setActiveId((cur) => (cur === id ? serverId : cur));

      busyRef.current = false;
      setBusy(false);
      setStatusLines([]);
    },
    [adoptResponse, mutate, refreshSession],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const pickClarify = useCallback(
    (pendingId: string, option: { id: string; label: string }) =>
      send(option.label, { clarify: { pending_id: pendingId, option_id: option.id } }),
    [send],
  );

  // ── sign in / out ─────────────────────────────────────────────────────────
  const signIn = useCallback(async () => {
    const wallet = adapter.publicKey?.toBase58();
    if (!wallet || !adapter.signMessage) {
      setSignInError(
        wallet ? "This wallet cannot sign messages, which Sign-In-With-Solana needs." : "Connect a wallet first.",
      );
      return;
    }
    setSignInBusy(true);
    setSignInError(null);
    try {
      const res = await signInWithWallet({ wallet, signMessage: adapter.signMessage });
      if (!res.authenticated || !res.wallet) throw new Error("The server did not accept the signature.");
      const signedIn: SessionStatus = { state: "signed_in", wallet: res.wallet, expiresAt: res.expires_at ?? null };
      setSession(signedIn);
      // The retried message below is sent before React re-renders: without this it would still read "signed out" and
      // skip the model's progress lines for that first message (the reply itself always came from the model).
      sessionRef.current = signedIn;
      const retry = retryRef.current;
      retryRef.current = null;
      if (retry) void send(retry.text, { clarify: retry.clarify, replaceLast: true });
    } catch (error) {
      setSignInError(
        error instanceof SignInCancelledError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Sign-in failed.",
      );
    } finally {
      setSignInBusy(false);
    }
  }, [adapter.publicKey, adapter.signMessage, send]);

  const signOut = useCallback(async () => {
    try {
      await logout();
    } finally {
      retryRef.current = null;
      controllers.current.clear();
      setRuns({});
      setSession({ state: "signed_out" });
    }
  }, []);

  // ── conversations ─────────────────────────────────────────────────────────
  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setActiveId(null);
  }, []);
  const open = useCallback((id: string) => setActiveId(id), []);
  const rename = useCallback((id: string, title: string) => mutate(id, (c) => ({ ...c, title })), [mutate]);
  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((c) => c.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
  }, []);

  // ── plan actions (by workflow id) ─────────────────────────────────────────
  const plan = useMemo(
    () => ({
      approve: (id: string, digest: string) => void controllers.current.get(id)?.approve(digest),
      sign: (id: string) => void controllers.current.get(id)?.sign(),
      advance: (id: string) => void controllers.current.get(id)?.advance(),
      recheck: (id: string) => void controllers.current.get(id)?.recheck(),
      cancel: (id: string) => void controllers.current.get(id)?.cancel(),
    }),
    [],
  );

  return {
    session,
    signIn,
    signInBusy,
    signInError,
    signOut,
    conversations,
    activeId,
    turns,
    busy,
    statusLines,
    send,
    stop,
    pickClarify,
    newChat,
    open,
    rename,
    remove,
    runs,
    plan,
  };
}
