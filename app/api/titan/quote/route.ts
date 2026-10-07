import { NextRequest, NextResponse } from "next/server";
import { titanConfigured, titanQuote } from "@/lib/solana/server/titan-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/titan/quote?inputMint&outputMint&amount&userPublicKey[&slippageBps][&mode=wallet|margin]
 * — a Titan quote with its instructions, fetched with the server's TITAN_API_KEY. 503 when no key is
 * configured (the Spot page then quotes Jupiter only).
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  if (!titanConfigured()) return NextResponse.json({ error: "Titan is not configured on this server", configured: false }, { status: 503 });
  const inputMint = q.get("inputMint");
  const outputMint = q.get("outputMint");
  const amount = q.get("amount");
  const userPublicKey = q.get("userPublicKey");
  if (!inputMint || !outputMint || !amount || !userPublicKey) {
    return NextResponse.json({ error: "inputMint, outputMint, amount and userPublicKey are required" }, { status: 400 });
  }
  try {
    const route = await titanQuote({
      inputMint,
      outputMint,
      amount,
      userPublicKey,
      slippageBps: Number(q.get("slippageBps") ?? 50),
      mode: q.get("mode") === "margin" ? "margin" : "wallet",
      dexes: q.get("dexes") ?? undefined,
    });
    return NextResponse.json(route);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Titan quote failed" }, { status: 502 });
  }
}
