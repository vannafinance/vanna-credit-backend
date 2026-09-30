"use client";

import type { ClarifyOption } from "@/lib/copilot/types";
import { StrategyOptionsGrid } from "./strategy-options-grid";

export interface ClarifyOptionsProps {
  options: ClarifyOption[];
  disabled?: boolean;
  onPick: (option: ClarifyOption) => void;
}

/**
 * The server needs one more answer before it will build anything. Short choices are buttons;
 * options that carry an explanation are drawn as strategy cards instead. The choice goes back as
 * the option id together with the server's pending id, so the client never resends slots.
 */
export function ClarifyOptions({ options, disabled = false, onPick }: ClarifyOptionsProps) {
  if (options.length === 0) return null;
  if (options.some((o) => (o.description ?? "").length > 40)) {
    return <StrategyOptionsGrid options={options} disabled={disabled} onSelect={onPick} />;
  }
  return (
    <div className="mt-1 flex flex-col gap-2.5">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.15em] text-vgray-400">choose an option</p>
      <div className="flex flex-wrap gap-2.5">
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            onClick={() => onPick(opt)}
            className="rounded-r3 border border-violet-100 bg-violet-50 px-4 py-3 text-left transition-colors hover:border-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="block font-mono text-[13px] font-semibold text-violet-600">{opt.label}</span>
            {opt.description && (
              <span className="mt-0.5 block text-[12px] leading-snug text-vgray-500">{opt.description}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
