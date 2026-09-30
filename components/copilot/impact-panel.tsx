"use client";

import { ChevronRight } from "lucide-react";
import type { Simulation } from "@/lib/copilot/types";

/**
 * Before -> after for a write that touches the margin account.
 *
 * Every figure is the MCP's own (`can_borrow` / `can_withdraw` / the envelope preview) carried
 * by the plan. A missing figure is drawn as "—": a null health factor is only shown as "∞"
 * when the same simulation says there is no debt afterwards, never as a default.
 */

const OK_INK = "var(--cp-ok-fg)";
const WARN_INK = "var(--cp-warn-fg)";
const BAD_INK = "var(--cp-danger-fg)";
const LIQUIDATION = 1.1;

const usd = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function hfText(v: number | null, debt: number): string {
  if (v != null && Number.isFinite(v)) return v.toFixed(2);
  return debt === 0 ? "∞" : "—";
}

function hfPct(v: number | null, debt: number): string {
  if (v == null || !Number.isFinite(v)) return debt === 0 ? "100%" : "0%";
  return `${Math.max(2, Math.min(100, (v / 3) * 100))}%`;
}

function hfColor(v: number | null, floor: number): string {
  if (v == null || !Number.isFinite(v)) return OK_INK;
  if (v >= floor + 0.35) return OK_INK;
  if (v >= floor) return WARN_INK;
  return BAD_INK;
}

export function ImpactPanel({ sim, floor = 1.15 }: { sim: Simulation; floor?: number }) {
  if (sim.margin_applicable === false) {
    return (
      <div className="mt-[18px] rounded-2xl border border-vgray-100 bg-vgray-50 px-5 py-4">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-violet-500">projected impact</p>
        <p className="text-[13px] leading-[19px] text-vgray-500">
          None. This moves tokens in your wallet and does not touch your margin account, so your collateral, debt and health factor are unchanged.
        </p>
      </div>
    );
  }

  const color = hfColor(sim.hf_after, floor);
  const rows = [
    { k: "collateral", before: usd(sim.collateral_before), after: usd(sim.collateral_after) },
    { k: "debt", before: usd(sim.debt_before), after: usd(sim.debt_after) },
  ];

  return (
    <div className="mt-[18px] rounded-2xl border border-vgray-100 bg-vgray-50 p-5">
      <p className="mb-3.5 font-mono text-[10px] uppercase tracking-[0.2em] text-violet-500">projected impact</p>

      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[11px] uppercase tracking-wider text-vgray-400">health factor</span>
        <span className="flex items-baseline gap-2.5 font-mono">
          <span className="text-[16px] text-vgray-500">{hfText(sim.hf_before, sim.debt_before)}</span>
          <ChevronRight size={13} className="self-center text-vgray-300" />
          <span className="text-[22px] font-bold" style={{ color }}>
            {hfText(sim.hf_after, sim.debt_after)}
          </span>
        </span>
      </div>

      <div className="relative mt-3 h-2.5 overflow-hidden rounded-full bg-vgray-100">
        <div className="absolute inset-y-0 left-0 bg-vgray-200" style={{ width: hfPct(sim.hf_before, sim.debt_before) }} />
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out"
          style={{ width: hfPct(sim.hf_after, sim.debt_after), background: color }}
        />
        <div className="absolute inset-y-0 w-0.5" style={{ left: `${(LIQUIDATION / 3) * 100}%`, background: BAD_INK }} />
        <div className="absolute inset-y-0 w-0.5" style={{ left: `${(floor / 3) * 100}%`, background: WARN_INK }} />
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-vgray-400">
        <span style={{ color: BAD_INK }}>1.10 liquidation</span>
        <span style={{ color: WARN_INK }}>{floor.toFixed(2)} copilot floor</span>
        <span>3.00+</span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.k} className="flex items-baseline justify-between gap-3 border-b border-vgray-100 py-[7px] last:border-0">
            <span className="font-mono text-[11px] uppercase tracking-wider text-vgray-400">{r.k}</span>
            <span className="flex items-baseline gap-[7px] font-mono text-[13px]">
              <span className="text-vgray-500">{r.before}</span>
              <span className="text-vgray-300">→</span>
              <span className="font-semibold text-vgray-900">{r.after}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
