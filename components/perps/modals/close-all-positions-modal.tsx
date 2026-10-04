"use client";

import { BaseModalContent } from "../../ui/base-modal-content";
import { useTheme } from "@/contexts/theme-context";

interface CloseAllPositionsModalProps {
  count: number;
  onClose: () => void;
  onConfirm: () => void;
}

export const CloseAllPositionsModal = ({ count, onClose, onConfirm }: CloseAllPositionsModalProps) => {
  const { isDark } = useTheme();
  return (
    <BaseModalContent
      title="Close Positions"
      width="418px"
      gap="gap-5"
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <p className={`text-[12px] leading-[18px] font-medium ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
        All {count} position{count === 1 ? "" : "s"} will be closed at the market price, one transaction at a time (one
        wallet approval each). Are you sure you want to close all positions?
      </p>
    </BaseModalContent>
  );
};
