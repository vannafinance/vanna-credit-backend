"use client";

/**
 * "Create your Margin Account" — the borrow agreement the user signs before `user_create_margin`
 * (store `createMarginAccount`, which drives the transaction-progress modal and its toasts). After
 * creation the account is rediscovered and the per-wallet snapshot refetched, so the page leaves the
 * pre-creation state.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "@/components/v3/ui";
import { useMarginAccountInfoStore, createMarginAccount, checkUserMarginAccount } from "@/store/margin-account-info-store";
import { ACCOUNT_SNAPSHOT_KEY } from "@/hooks/use-account-snapshot";

const TERMS: [string, string[]][] = [
  ["Collateral Requirement", ["All borrowed positions must remain fully collateralized.", "If collateral value falls below the liquidation threshold, your position may be liquidated."]],
  ["Borrow Limits & Leverage", ["You may only borrow assets up to the maximum Loan-to-Value (LTV) allowed.", "Leverage is enabled only when collateral value supports it."]],
  ["Interest & Fees", ["Interest rates are variable and accrue in real time.", "Additional protocol fees may apply for borrowing or liquidation events."]],
  ["Liquidation Risk", ["Market volatility can reduce collateral value.", "If your position health factor drops below safe limits, collateral may be partially or fully liquidated without prior notice."]],
  ["User Responsibility", ["You are responsible for monitoring your positions, balances, and risks.", "VANNA is a non-custodial protocol; all actions are initiated by your wallet."]],
  ["No Guarantee of Returns", ["Using borrowed assets in trading, farming, or external protocols involves risk.", "VANNA does not guarantee profits or protection against losses."]],
];

/** Two steps, as before: what a margin account is, then the agreement + Sign. */
export function CreateAccountModal({ address, onClose }: { address: string; onClose: () => void }) {
  const qc = useQueryClient();
  const creating = useMarginAccountInfoStore((s) => s.isCreatingAccount);
  const [step, setStep] = useState<"intro" | "sign">("intro");
  const [agreed, setAgreed] = useState(false);

  const sign = async () => {
    if (creating) return;
    try {
      const created = await createMarginAccount(address);
      if (created) {
        await checkUserMarginAccount(address);
        // The snapshot was read before the account existed — refetch it.
        qc.invalidateQueries({ queryKey: [...ACCOUNT_SNAPSHOT_KEY, address] });
        onClose();
      }
    } catch (error) {
      console.error("Failed to create margin account:", error);
    }
  };

  return (
    <Modal onClose={onClose}>
      {step === "intro" ? (
        <>
          <h2>Create Margin Account</h2>
          <ol style={{ margin: "16px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8, fontSize: 14, color: "var(--label)" }}>
            <li>Connect your wallet to get started.</li>
            <li>Confirm your Margin Account — we will generate a unique address for you.</li>
            <li>Make a deposit to activate borrowing.</li>
          </ol>
          <button
            type="button"
            className="mg-btn"
            style={{ marginTop: 20 }}
            onClick={() => {
              // An interrupted earlier attempt can leave the flag set; reset it on entering this step.
              useMarginAccountInfoStore.getState().set({ isCreatingAccount: false });
              setStep("sign");
            }}
          >
            Create Your Account
          </button>
        </>
      ) : (
        <>
          <h2>Review and Sign Agreement</h2>
          <p className="msub">
            Before you proceed, please review and accept the terms of borrowing on VANNA. This agreement ensures you understand the risks, responsibilities, and conditions associated with using the platform.
          </p>
          <div style={{ marginTop: 16, maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, fontSize: 13, color: "var(--label)" }}>
            {TERMS.map(([h, pts]) => (
              <div key={h}>
                <b style={{ color: "var(--text)", fontSize: 13 }}>{h}</b>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  {pts.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16, fontSize: 13, color: "var(--text)", cursor: "pointer" }}>
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />I have read and agree to the VANNA Borrow Agreement.
          </label>
          <button type="button" className="mg-btn" style={{ marginTop: 16 }} disabled={!agreed || creating} onClick={() => void sign()}>
            {creating ? "Creating Account..." : "Sign Agreement"}
          </button>
        </>
      )}
    </Modal>
  );
}
