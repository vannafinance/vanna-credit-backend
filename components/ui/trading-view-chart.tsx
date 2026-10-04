"use client";

import React, { useEffect, useRef, memo } from "react";

interface TradingViewChartProps {
  /** TradingView symbol, e.g. "PYTH:ETHUSD". */
  symbol?: string;
  theme?: "light" | "dark";
  interval?: string;
}

function TradingViewChart({
  symbol = "COINBASE:BTCUSD",
  theme = "light",
  interval = "D",
}: TradingViewChartProps) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = container.current;
    if (!el) return;

    const script = document.createElement("script");
    script.src =
      "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;

    const chartConfig = {
      autosize: true,
      symbol,
      interval,
      timezone: "Etc/UTC",
      theme,
      style: "1",
      locale: "en",
      backgroundColor: theme === "dark" ? "#222222" : "#FFFFFF",
      allow_symbol_change: true,
      save_image: false,
      calendar: false,
      support_host: "https://www.tradingview.com",
    };

    script.innerHTML = JSON.stringify(chartConfig);

    el.innerHTML = "";
    el.appendChild(script);

    return () => {
      el.innerHTML = "";
    };
  }, [symbol, theme, interval]);

  return (
    <div
      ref={container}
      className="tradingview-widget-container h-full w-full "
    >
      <div className="tradingview-widget-container__widget h-full w-full" />
    </div>
  );
}

export default memo(TradingViewChart);
