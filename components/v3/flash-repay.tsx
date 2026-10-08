"use client";

/**
 * Flash repay entry points shared by every V3 page.
 *
 * - `FlashRepayButton` opens the modal (`useFlashRepayStore`).
 * - `FlashRepayHost` is mounted once in the root layout and renders the modal when open.
 *
 * The modal itself (components/v3/flash-repay-modal.tsx) and its multi-step service
 * (lib/solana/flash-repay.ts) close every position and repay every loan as a sequence of
 * transactions (not atomic), showing progress per step.
 */
import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { useFlashRepayStore } from "@/store/flash-repay-store";
import { IC } from "./icons";

const FlashRepayModal = dynamic(() => import("./flash-repay-modal"), { ssr: false });

export function FlashRepayButton({
  label = "Flash repay",
  className = "btn-o",
  disabled,
  transfer,
  children,
}: {
  label?: string;
  className?: string;
  disabled?: boolean;
  transfer?: boolean;
  children?: ReactNode;
}) {
  const openFlashRepay = useFlashRepayStore((s) => s.openFlashRepay);
  return (
    <button type="button" className={className} disabled={disabled} onClick={() => openFlashRepay({ transfer })}>
      {children ?? (
        <>
          {IC.bolt}
          {label}
        </>
      )}
    </button>
  );
}

export function FlashRepayHost() {
  const open = useFlashRepayStore((s) => s.open);
  return open ? <FlashRepayModal /> : null;
}
