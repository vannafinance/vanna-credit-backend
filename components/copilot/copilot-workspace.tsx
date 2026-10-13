"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWallet as useAdapterWallet } from "@solana/wallet-adapter-react";
import { useWallet } from "@/hooks/use-wallet";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { HEALTH_FACTOR_INFINITY_SENTINEL } from "@/lib/margin-health";
import { useCopilot } from "@/lib/copilot/client/use-copilot";
import { useUserPositions } from "@/hooks/use-earn";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { usePerpsView } from "@/hooks/use-perps";
import { usePredictPositions } from "@/hooks/use-predict";
import { PERP_MARKETS } from "@/lib/solana/phoenix";
import { CopilotShell } from "./copilot-shell";
import {
  CopilotRailBody,
  CopilotRailMini,
  CopilotRailTop,
  type RailPosition,
  type RailStatusChip,
} from "./copilot-rail";
import { AssistantTurn } from "./assistant-turn";
import { NeedsLoginCard } from "./needs-login-card";
import { UserBubble, WorkingRow } from "./chat-message";

/**
 * The /copilot workspace: rail + thread + composer, with every answer drawn from the server's reply.
 *
 * Layout, tokens and components are the Stellar Copilot's. What differs is the wiring: one signer
 * (the user's wallet), Sign-In-With-Solana for identity, server-held plans approved by digest, and no
 * figure shown that the server or the chain did not provide.
 */

const STARTERS = ["Price of SOL", "What's my health factor?", "Supply 5 USDC to Earn"];

const usd = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/**
 * How long a remembered wallet may take to reconnect on page load before the sign-in card offers "Connect wallet"
 * instead of waiting (the wallet may be locked, or the user declined it).
 */
const RECONNECT_GRACE_MS = 5_000;

/** Eight lines of the prompt box (21px line height) plus its 10px top and bottom padding. */
const COMPOSER_MAX_HEIGHT = 8 * 21 + 20;
export function CopilotWorkspace() {
  const { address, walletName, connectWallet } = useWallet();
  const { connecting } = useAdapterWallet();
  const copilot = useCopilot();
  // A wallet the site remembers reconnects by itself a moment after the page loads: until then (or the grace period
  // ends) the sign-in card says it is connecting, never "Connect wallet" for a wallet that is about to be connected.
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setGraceOver(true), RECONNECT_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const walletReconnecting = !address && (connecting || (walletName != null && !graceOver));
  const { session, turns, runs, busy } = copilot;

  const [input, setInput] = useState("");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // The prompt box grows with what is typed, like any chat composer, up to about eight lines; only a longer prompt
  // scrolls inside it (with a thin scrollbar). Sending clears the text and the box shrinks back to one line.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const full = el.scrollHeight;
    el.style.height = `${Math.min(full, COMPOSER_MAX_HEIGHT)}px`;
    el.style.overflowY = full > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
  }, [input]);

  // The rail shows the account the app already reads from chain; it is never the Copilot's own copy.
  const hasMarginAccount = useMarginAccountInfoStore((s) => s.hasMarginAccount);
  const avgHealthFactor = useMarginAccountInfoStore((s) => s.avgHealthFactor);
  const collateralBalances = useMarginAccountInfoStore((s) => s.collateralBalances);
  const borrowedBalances = useMarginAccountInfoStore((s) => s.borrowedBalances);

  const noDebt = hasMarginAccount && avgHealthFactor >= HEALTH_FACTOR_INFINITY_SENTINEL;
  const healthFactor = hasMarginAccount && avgHealthFactor > 0 && !noDebt ? avgHealthFactor : null;

  const positions: RailPosition[] = useMemo(() => {
    const rows = (map: typeof collateralBalances, role: string): RailPosition[] =>
      Object.entries(map)
        // Hide anything that would read as 0: dust left by interest rounding after a repay is not a position.
        .filter(([, v]) => Number(v.amount).toLocaleString(undefined, { maximumFractionDigits: 4 }) !== "0" && Number(v.amount) > 0)
        .map(([symbol, v]) => ({
          symbol,
          role,
          amount: Number(v.amount).toLocaleString(undefined, { maximumFractionDigits: 4 }),
          usd: usd(Number(v.usdValue)),
        }));
    // A borrow lands in the margin vault, so the vault balance of an asset includes what was borrowed of it. The panel
    // shows the two apart: Borrowed is the debt, Collateral is the vault balance minus that debt (what the user put in or
    // swapped into). Borrowing then changes only the Borrowed row, and depositing only the Collateral row. The health
    // factor and the app's other pages still use the full vault balance, as the program does.
    const ownCollateral: typeof collateralBalances = {};
    for (const [symbol, v] of Object.entries(collateralBalances)) {
      const held = Number(v.amount);
      const owed = Number(borrowedBalances[symbol]?.amount ?? 0);
      const diff = held - (Number.isFinite(owed) ? owed : 0);
      const own = diff > 1e-9 ? diff : 0; // float dust from the subtraction is not a position
      const price = held > 0 ? Number(v.usdValue) / held : 0;
      ownCollateral[symbol] = { amount: String(own), usdValue: String(own * price) };
    }
    return [...rows(ownCollateral, "Margin · Collateral"), ...rows(borrowedBalances, "Margin · Borrowed")];
  }, [collateralBalances, borrowedBalances]);

  // Earn pool deposits: the same lender positions and oracle prices the Earn page reads (share balance × the pool's
  // exchange rate = the amount redeemable now). They are outside the margin account, so they get their own list.
  const { positions: lenderPositions } = useUserPositions();
  const prices = useTokenPrices();
  const earnPositions: RailPosition[] = useMemo(
    () =>
      Object.values(lenderPositions)
        .filter((p) => p.assets > 0 && p.assets.toLocaleString(undefined, { maximumFractionDigits: 4 }) !== "0")
        .map((p) => {
          const price = prices[p.symbol] ?? 0;
          return {
            symbol: p.symbol,
            role: "Earn · Supplied",
            amount: p.assets.toLocaleString(undefined, { maximumFractionDigits: 4 }),
            usd: price > 0 ? usd(p.assets * price) : "—",
          };
        }),
    [lenderPositions, prices],
  );

  // Phoenix perps positions: the same view the Perps page polls (size, side, leverage, PnL), shown in their own section.
  const { view: perpsView } = usePerpsView();
  const perpsPositions: RailPosition[] = useMemo(
    () =>
      (perpsView?.positions ?? []).map((p) => {
        const pnl = `${p.pnlUsd < 0 ? "-" : "+"}${usd(Math.abs(p.pnlUsd))}`;
        return {
          symbol: p.marketName,
          icon: PERP_MARKETS.find((m) => m.key === p.market)?.icon,
          role: `Perp · ${p.side === "long" ? "Long" : "Short"} ${p.leverage.toFixed(1)}x`,
          amount: p.sizeTokens.toLocaleString(undefined, { maximumFractionDigits: 4 }),
          usd: `${usd(p.sizeUsd)} · ${pnl}`,
        };
      }),
    [perpsView],
  );

  // Predict positions (World.xyz prediction markets): the same read the Predict page polls; wallet-only, so they sit
  // apart from the margin account and never touch the health factor.
  const { data: predictData } = usePredictPositions(address);
  const predictPositions: RailPosition[] = useMemo(
    () =>
      (predictData?.positions ?? [])
        .filter((p) => p.shares > 0)
        .map((p) => ({
          symbol: `${p.outcome} ${p.label}`,
          role: `Predict · ${p.event}`,
          amount: `${p.shares.toLocaleString(undefined, { maximumFractionDigits: 2 })} shares`,
          usd: `${usd(p.value)} · ${p.pnl < 0 ? "-" : "+"}${usd(Math.abs(p.pnl))}`,
        })),
    [predictData],
  );

  const chips: RailStatusChip[] = useMemo(() => {
    // Only the sign-in state: the network and server chips were noise (an unreachable server shows on the page).
    const list: RailStatusChip[] = [];
    if (session.state === "signed_in") {
      const mismatch = address != null && address !== session.wallet;
      list.push({
        label: mismatch ? "Wallet differs from sign-in" : `Signed in · ${shortAddress(session.wallet)}`,
        tone: mismatch ? "warn" : "ok",
        title: mismatch ? "The connected wallet is not the one you signed in with. Click to sign out." : "Click to sign out",
        onClick: () => void copilot.signOut(),
      });
    } else if (session.state === "signed_out") {
      list.push({ label: "Not signed in", tone: "warn" });
    }
    return list;
  }, [session, address, copilot]);

  const stageEmpty = turns.length === 0;
  const lastAssistantIndex = turns.reduce((acc, t, i) => (t.role === "assistant" ? i : acc), -1);
  const lastTurn = turns[turns.length - 1];

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void copilot.send(text);
  };

  const modifyFrom = (turnIndex: number) => {
    for (let i = turnIndex - 1; i >= 0; i--) {
      if (turns[i]?.role === "user") {
        setInput(turns[i]!.text);
        inputRef.current?.focus();
        return;
      }
    }
  };

  const login = {
    walletConnected: Boolean(address),
    walletConnecting: walletReconnecting,
    walletName,
    busy: copilot.signInBusy,
    error: copilot.signInError,
    onSignIn: () => void copilot.signIn(),
    onConnect: () => void connectWallet(),
  };

  return (
    <div className="cp-root">
      <CopilotShell
        collapsed={railCollapsed}
        onToggleCollapsed={() => setRailCollapsed((v) => !v)}
        empty={stageEmpty}
        conversationId={copilot.activeId}
        justSubmitted={busy}
        scrollKey={`${turns.length}-${busy}-${lastTurn?.id}-${Object.values(runs)
          .map((r) => `${r.phase}${r.plan.steps.map((s) => s.status).join("")}`)
          .join("|")}`}
        railTop={<CopilotRailTop onNewChat={copilot.newChat} chips={chips} />}
        railBody={
          <CopilotRailBody
            hasWallet={Boolean(address)}
            healthFactor={healthFactor}
            noDebt={noDebt}
            positions={positions}
            earnPositions={earnPositions}
            perpsPositions={perpsPositions}
            predictPositions={predictPositions}
            conversations={copilot.conversations}
            activeId={copilot.activeId}
            onOpen={copilot.open}
            onRename={copilot.rename}
            onDelete={copilot.remove}
          />
        }
        railMini={
          <CopilotRailMini
            onExpand={() => setRailCollapsed(false)}
            onNewChat={copilot.newChat}
            healthFactor={healthFactor}
            noDebt={noDebt}
            conversations={copilot.conversations}
            activeId={copilot.activeId}
            onOpen={copilot.open}
            onRename={copilot.rename}
            onDelete={copilot.remove}
          />
        }
        thread={
          <div style={{ paddingTop: 24, paddingBottom: 8, display: "flex", flexDirection: "column", gap: 34 }}>
            {turns.length > 0 && (
              <section aria-label="Copilot conversation" className="min-w-0">
                <div style={{ display: "flex", flexDirection: "column", gap: 34 }} aria-label="Conversation">
                  {turns.map((turn, index) => {
                    if (turn.role !== "user") return null;
                    const reply = turns[index + 1];
                    const response = reply?.response;
                    return (
                      <section key={turn.id} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        <UserBubble>{turn.text}</UserBubble>
                        {response ? (
                          <AssistantTurn
                            response={response}
                            run={response.workflow_id ? runs[response.workflow_id] : undefined}
                            isLatest={index + 1 === lastAssistantIndex}
                            busy={busy}
                            plan={copilot.plan}
                            onPickClarify={copilot.pickClarify}
                            onModify={() => modifyFrom(index + 1)}
                            login={login}
                          />
                        ) : index === turns.length - 1 && busy ? (
                          <WorkingRow lines={copilot.statusLines} />
                        ) : null}
                      </section>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        }
        composer={
          <>
            {stageEmpty && (
              <div style={{ textAlign: "center", marginBottom: 16 }}>
                <div className="text-[28px] leading-[42px] font-semibold text-vgray-900">What&apos;s the next move?</div>
                <div className="mt-1.5 text-[16px] leading-[24px] text-vgray-500">
                  Read the book, size a plan, or run a change.
                </div>
                {/* Signed out: the sign-in card is offered before anything is typed, not only after a first message. */}
                {session.state === "signed_out" && (
                  <div className="mt-4 text-left">
                    <NeedsLoginCard {...login} />
                  </div>
                )}
                {session.state === "unreachable" && (
                  <p role="alert" className="mt-3 text-[13px] leading-5 text-imperial-500">
                    The Copilot server is not reachable right now. Nothing can be read or sent until it is back.
                  </p>
                )}
              </div>
            )}
            <div
              className="cp-composer"
              style={{
                minWidth: 0,
                background: "var(--cp-surface)",
                border: "1px solid var(--cp-g100)",
                borderRadius: 28,
                padding: "8px 8px 8px 18px",
              }}
            >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
              >
                <div className="flex items-end gap-2">
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder="Ask about a position, or describe a change"
                    aria-label="Copilot message"
                    maxLength={8000}
                    rows={1}
                    className="cp-composer-input min-w-0 flex-1 bg-transparent text-vgray-900 placeholder:text-vgray-300 focus:outline-none"
                    style={{ resize: "none" }}
                    spellCheck={false}
                  />
                  <button
                    type={busy ? "button" : "submit"}
                    disabled={!busy && !input.trim()}
                    onClick={busy ? (e) => { e.preventDefault(); copilot.stop(); } : undefined}
                    aria-label={busy ? "Stop" : "Send"}
                    title={busy ? "Stop" : "Send"}
                    className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-100"
                    style={{ background: "var(--gradient, linear-gradient(135deg, #FC5457 10%, #703AE6 80%))" }}
                  >
                    {busy ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden>
                        <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
                      </svg>
                    ) : (
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
                      </svg>
                    )}
                  </button>
                </div>
              </form>
            </div>
            <p className="mt-1.5 text-center text-[11px] leading-[17px] text-vgray-400">
              Every write asks your wallet for a signature · nothing is sent without it
            </p>
            {stageEmpty && (
              <div style={{ paddingTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
                {STARTERS.map((text) => (
                  <button
                    key={text}
                    type="button"
                    disabled={busy}
                    onClick={() => void copilot.send(text)}
                    className="w-full cursor-pointer rounded-r2 px-1.5 py-2.5 text-left text-[14px] leading-[21px] text-vgray-500 transition-colors hover:bg-vgray-50 hover:text-vgray-900 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}
          </>
        }
      />
    </div>
  );
}

export default CopilotWorkspace;
