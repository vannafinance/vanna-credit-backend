"use client";

import type { ReactNode } from "react";
import { useTheme } from "@/contexts/theme-context";

export interface PerpsColumn<T> {
  id: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: "left" | "right";
  /** Hide from the mobile card (e.g. the action, rendered separately). */
  hideOnMobile?: boolean;
}

interface PerpsTableProps<T> {
  columns: PerpsColumn<T>[];
  data: T[];
  getRowKey: (row: T) => string;
  getSide?: (row: T) => "long" | "short";
  emptyText: string;
  /** Mobile card header (title + action). */
  mobileHeader?: (row: T) => ReactNode;
}

/** Themed table (desktop) + card list (mobile) used by the positions and open-orders tabs. */
export function PerpsTable<T>({ columns, data, getRowKey, getSide, emptyText, mobileHeader }: PerpsTableProps<T>) {
  const { isDark } = useTheme();
  const primary = isDark ? "text-[#FFFFFF]" : "text-[#111111]";
  const shell = `p-2 rounded-lg border ${isDark ? "border-[#333333] bg-[#222222]" : "border-[#E2E2E2] bg-[#F7F7F7]"}`;

  if (data.length === 0) {
    return (
      <div className={`${shell} min-h-[200px] flex items-center justify-center`}>
        <span className="text-[12px] font-medium text-[#919191]">{emptyText}</span>
      </div>
    );
  }

  return (
    <>
      <div className={`hidden md:block ${shell}`}>
        <div className="w-full max-h-[340px] overflow-auto scrollbar-hide">
          <table className="min-w-full border-separate border-spacing-y-1">
            <thead className={`sticky top-0 z-10 ${isDark ? "bg-[#222222]" : "bg-[#F7F7F7]"}`}>
              <tr>
                {columns.map((col) => (
                  <th
                    key={col.id}
                    className={`px-2 py-1 h-8 text-[12px] leading-[18px] font-medium text-[#919191] whitespace-nowrap border-b ${isDark ? "border-[#333333]" : "border-[#E8E8E8]"} ${col.align === "right" ? "text-right" : "text-left"}`}
                  >
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row) => {
                const side = getSide?.(row);
                return (
                  <tr key={getRowKey(row)}>
                    {columns.map((col, i) => (
                      <td
                        key={col.id}
                        className={`px-2 py-2 text-[12px] leading-[18px] font-medium whitespace-nowrap ${primary} ${col.align === "right" ? "text-right" : "text-left"} ${
                          i === 0 && side ? `border-l-2 ${side === "long" ? "border-l-[#24A0A9]" : "border-l-[#FC5457]"}` : ""
                        }`}
                      >
                        {col.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className={`md:hidden flex flex-col gap-2 ${shell}`}>
        {data.map((row) => (
          <div
            key={getRowKey(row)}
            className={`rounded-lg border p-4 flex flex-col gap-3 ${isDark ? "border-[#333333] bg-[#2A2A2A]" : "border-[#E2E2E2] bg-white"}`}
          >
            {mobileHeader?.(row)}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              {columns
                .filter((c) => !c.hideOnMobile)
                .map((col, i) => (
                  <div key={col.id} className={i % 2 === 1 ? "text-right" : ""}>
                    <div className="text-[11px] text-[#A7A7A7] font-medium">{col.header}</div>
                    <div className={`text-[12px] font-medium ${primary}`}>{col.render(row)}</div>
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Small bordered action button used in the tables. */
export function TableActionButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const { isDark } = useTheme();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`cursor-pointer inline-flex items-center border-[0.75px] rounded-md py-1.5 px-3 text-[12px] leading-[18px] font-medium hover:text-[#703AE6] disabled:opacity-50 disabled:cursor-not-allowed ${isDark ? "bg-[#222222] border-[#333333] text-[#FFFFFF]" : "bg-[#FFFFFF] border-[#E2E2E2] text-[#111111]"}`}
    >
      {label}
    </button>
  );
}
