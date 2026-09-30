"use client";

import { ChevronRight } from "lucide-react";
import type { ClarifyOption } from "@/lib/copilot/types";

export interface StrategyOptionsGridProps {
  options: ClarifyOption[];
  disabled?: boolean;
  onSelect: (option: ClarifyOption) => void;
}

/**
 * The server offered several ways to do what was asked, each with a sentence of explanation.
 * Drawn as cards so the explanation gets room; a choice is sent back by id (`clarify.option_id`),
 * never by echoing the label, so what the server runs is what it offered.
 */
export function StrategyOptionsGrid({ options, disabled = false, onSelect }: StrategyOptionsGridProps) {
  if (options.length === 0) return null;
  return (
    <div className="mt-3.5 space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-vgray-500">Options</span>
        <span className="text-[11px] text-vgray-400">Pick one to continue</span>
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(option)}
            className="relative flex flex-col justify-between rounded-xl border border-vgray-100 bg-surface p-3.5 text-left transition-all hover:border-violet-400 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            <div>
              <h4 className="text-[13px] font-semibold leading-snug text-vgray-900">{option.label}</h4>
              {option.description && (
                <p className="mt-1 text-[12px] leading-[18px] text-vgray-500">{option.description}</p>
              )}
            </div>
            <div className="mt-3 flex items-center justify-end border-t border-vgray-100 pt-2 text-[11.5px] font-semibold text-violet-600">
              <span className="flex items-center gap-1">
                <span>Choose</span>
                <ChevronRight size={13} />
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
