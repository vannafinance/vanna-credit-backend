/**
 * Brain against the REAL local MCP (http://localhost:8000/mcp, AUTH_ENABLED=false) and the real fork RPC.
 *
 *   default            read answers + builds/simulations only; nothing is sent to the chain
 *   COPILOT_LIVE_E2E=1 also airdrops a fresh keypair on the fork and drives real signed transactions
 *                      through approve -> advance -> sign -> submit -> confirm
 *
 * Skipped with a clear message when the MCP is unreachable. No language model is used (no
 * credentials needed): every answer here is the code-built one.
 */
import { Keypair, VersionedTransaction, Connection } from "@solana/web3.js";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import { beforeAll, describe, expect, it } from "vitest";

process.env.MCP_AUTH_MODE = "none";
process.env.MCP_BASE_URL = process.env.MCP_BASE_URL ?? "http://localhost:8000/mcp";

const { handleChat } = await import("../index");
const { mcp, mcpListTools, resetMcpClient } = await import("../mcp-client");
const { setLimitStoreForTests } = await import("../limits");
const { setLlmClient } = await import("../vertex");
const { advanceWorkflow, approveWorkflow, confirmWorkflow, submitWorkflow, workflowDeps } = await import("../workflow");
const { pendingDeps } = await import("../workflow/pending");
const { MemoryStore, WALLET_A, userFor } = await import("./helpers");

let reachable = false;
try {
  resetMcpClient();
  reachable = (await mcpListTools()).length >= 14;
} catch {
  reachable = false;
}
if (!reachable) console.warn(`[brain.live] SKIPPED: MCP at ${process.env.MCP_BASE_URL} is not reachable (start it with AUTH_ENABLED=false).`);

const live = describe.skipIf(!reachable);
const e2e = describe.skipIf(!reachable || process.env.COPILOT_LIVE_E2E !== "1");

beforeAll(() => {
  setLimitStoreForTests(new MemoryStore() as never);
  setLlmClient(null);
  const wf = new MemoryStore();
  Object.assign(workflowDeps, { store: () => wf });
  const conv = new MemoryStore();
  Object.assign(pendingDeps, { store: () => conv });
  process.env.COPILOT_RATE_CHAT_PER_MIN = "500";
  process.env.COPILOT_RATE_WRITE_PER_MIN = "500";
});

// The local MCP occasionally stalls a read past its 20 s client timeout while it is busy building; a retry is enough.
const T = { timeout: 90_000, retry: 2 };

live("read answers from the live MCP", () => {
  const user = userFor(WALLET_A); // a funded wallet with no margin account on the fork

  it("price of SOL equals the oracle's", async () => {
    const res = await handleChat({ req: { message: "what's the price of SOL" }, user });
    const live = Number((await mcp.price("SOL")).price_usd);
    expect(res.kind).toBe("answer");
    const shown = Number(res.answer!.facts[0].value.replace(/[$,]/g, ""));
    expect(Math.abs(shown - live) / live).toBeLessThan(0.02);
  }, T);

  it("pool rates are the MCP's own figures", async () => {
    const res = await handleChat({ req: { message: "USDC supply APY" }, user });
    const pool = await mcp.poolStats("USDC");
    expect(res.kind).toBe("answer");
    expect(res.answer!.headline).toContain(`${Number(pool.supply_apr_pct).toFixed(2)}%`);
  }, T);

  it("protocol and Kamino markets", async () => {
    const p = await handleChat({ req: { message: "what assets does the protocol support" }, user });
    expect(p.kind).toBe("answer");
    expect(JSON.stringify(p.answer)).toContain("SOL");
    const f = await handleChat({ req: { message: "what are the kamino apys" }, user });
    expect(f.kind).toBe("answer");
    expect(f.answer!.tables?.[0].rows).toHaveLength(5);
  }, T);

  it("wallet balance matches the MCP", async () => {
    const res = await handleChat({ req: { message: "what is my wallet balance" }, user });
    const w = await mcp.wallet(WALLET_A);
    expect(res.kind).toBe("answer");
    expect(res.answer!.facts[0].value).toContain(Number(w.sol_balance).toLocaleString("en-US", { maximumFractionDigits: 4 }));
  }, T);

  it("a wallet without a margin account is told so, with no invented health factor", async () => {
    const res = await handleChat({ req: { message: "what's my health factor?" }, user });
    expect(res.kind).toBe("answer");
    expect(res.answer!.headline).toMatch(/don't have a margin account/);
    const pos = await handleChat({ req: { message: "how much can I borrow" }, user });
    expect(pos.answer!.headline).toMatch(/don't have a margin account/);
  }, T);

  it("a quote comes from Jupiter through the MCP", async () => {
    const res = await handleChat({ req: { message: "quote 1 SOL to USDC" }, user });
    expect(res.kind).toBe("answer");
    expect(res.answer!.facts.map((f) => f.label)).toContain("minimum received");
  }, T);

  it("borrowing without a margin account is refused before anything is built", async () => {
    const res = await handleChat({ req: { message: "borrow 10 USDC" }, user });
    expect(res.kind).toBe("blocked");
  }, T);

  it("supply SOL: real MCP build + simulation gives a preview, then an unsigned transaction only after approval", async () => {
    const res = await handleChat({ req: { message: "supply 0.01 SOL" }, user });
    expect(res.kind).toBe("preview");
    expect(JSON.stringify(res)).not.toContain("unsignedTransaction");
    const plan = await approveWorkflow(res.workflow_id!, res.plan!.digest, user);
    expect(plan.state).toBe("approved");
    const adv = await advanceWorkflow(res.workflow_id!, user);
    expect(adv.unsigned_tx?.simulation_success).toBe(true);
    const tx = VersionedTransaction.deserialize(Buffer.from(adv.unsigned_tx!.transaction, "base64"));
    expect(tx.message.staticAccountKeys[0].toBase58()).toBe(WALLET_A);
    // a transaction signed by anyone but the session wallet is never broadcast
    const stranger = Keypair.generate();
    tx.signatures[0] = nacl.sign.detached(tx.message.serialize(), stranger.secretKey);
    await expect(submitWorkflow(res.workflow_id!, { step_n: 1, signed_tx: Buffer.from(tx.serialize()).toString("base64") }, user)).rejects.toMatchObject({ code: "tx_mismatch" });
  }, T);

  it("insufficient funds is explained from the simulation", async () => {
    const res = await handleChat({ req: { message: "supply 10 USDC" }, user });
    expect(res.kind).toBe("error");
    expect(res.message).toMatch(/does not hold enough/);
  }, T);
});

// ── real signed round trips on the fork ─────────────────────────────────────

e2e("real on-chain round trips (fresh keypair, fork airdrop)", () => {
  const kp = Keypair.generate();
  const user = { wallet: kp.publicKey.toBase58(), subject: createHash("sha256").update(kp.publicKey.toBase58()).digest("hex"), expiresAt: Date.now() + 1e7 };
  const conn = new Connection("https://rpc-devnet.solana.vanna.finance", "confirmed");

  beforeAll(async () => {
    await conn.requestAirdrop(kp.publicKey, 5e9);
    for (let i = 0; i < 20 && (await conn.getBalance(kp.publicKey)) === 0; i++) await new Promise((r) => setTimeout(r, 1000));
  }, T.timeout);

  /** approve -> (advance -> sign -> submit -> confirm)* until the plan stops moving. */
  async function run(message: string, pick?: number) {
    let res = await handleChat({ req: { message }, user });
    if (res.kind === "clarification" && res.clarify_options && pick !== undefined) {
      res = await handleChat({ req: { message: "", conversation_id: res.conversation_id, clarify: { pending_id: res.pending_id as string, option_id: res.clarify_options[pick].id } }, user });
    }
    expect(["preview", "plan_preview"], `${message}: ${res.message}`).toContain(res.kind);
    await approveWorkflow(res.workflow_id!, res.plan!.digest, user);
    const log: string[] = [];
    let staleRetries = 0;
    for (let guard = 0; guard < 20; guard++) {
      const adv = await advanceWorkflow(res.workflow_id!, user);
      if (adv.plan.state === "completed") return { res, plan: adv.plan, log };
      // A cloned DEX pool on the fork can be stale for a moment (Jupiter error 6024): a fresh build usually passes.
      if (!adv.unsigned_tx && adv.plan.state === "paused" && /out of date|stale|route/i.test(adv.pause_reason ?? "") && staleRetries++ < 5) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      if (!adv.unsigned_tx) {
        log.push(`stopped: ${adv.plan.state} ${adv.pause_reason ?? adv.message}`);
        return { res, plan: adv.plan, log };
      }
      const tx = VersionedTransaction.deserialize(Buffer.from(adv.unsigned_tx.transaction, "base64"));
      tx.sign([kp]);
      const sub = await submitWorkflow(res.workflow_id!, { step_n: adv.step!.n, signed_tx: Buffer.from(tx.serialize()).toString("base64") }, user);
      log.push(`step ${adv.step!.n} ${adv.step!.op}: ${sub.status}`);
      let conf = await confirmWorkflow(res.workflow_id!, { step_n: adv.step!.n }, user);
      for (let i = 0; i < 40 && conf.status === "submitted"; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        conf = await confirmWorkflow(res.workflow_id!, { step_n: adv.step!.n }, user);
      }
      log.push(`step ${adv.step!.n} -> ${conf.status}`);
      if (conf.status !== "confirmed") return { res, plan: conf.plan, log };
    }
    return { res, plan: (await advanceWorkflow(res.workflow_id!, user)).plan, log };
  }

  it("open account, deposit, read health, borrow within the floor, all confirmed on chain", async () => {
    const open = await run("open a margin account");
    expect(open.plan.state, open.log.join("\n")).toBe("completed");

    const dep = await run("deposit 1 SOL as collateral");
    expect(dep.plan.state, dep.log.join("\n")).toBe("completed");

    const health = await handleChat({ req: { message: "what's my health factor" }, user });
    expect(health.answer!.headline).toMatch(/no debt/);
    expect(health.answer!.facts.find((f) => f.label === "collateral")!.value).toMatch(/^\$/);

    const cap = await handleChat({ req: { message: "how much USDC can I borrow" }, user });
    expect(cap.answer!.facts.find((f) => f.label.startsWith("safe borrow"))).toBeTruthy();

    const borrow = await run("borrow 20 USDC");
    expect(borrow.plan.state, borrow.log.join("\n")).toBe("completed");

    const after = await handleChat({ req: { message: "what's my health factor" }, user });
    const hf = Number(after.answer!.facts.find((f) => f.label === "health factor")!.value);
    expect(hf).toBeGreaterThanOrEqual(1.15);
    expect(after.answer!.facts.find((f) => f.label === "debt")!.value).toMatch(/^\$(19\.9|20\.0)/);

    // borrowed funds count as collateral, so this needs ~$800 to drop HF below 1.15; the gate refuses it and nothing is built
    const tooMuch = await handleChat({ req: { message: "borrow 800 USDC" }, user });
    expect(tooMuch.kind).toBe("blocked");
  }, 600_000);

  it("earn supply and redeem-all, a wallet swap, and Kamino farm deposit/redeem settle on chain", async () => {
    // self-contained: a margin account with collateral (the plan opens the account when there is none)
    expect((await run("deposit 1 SOL as collateral")).plan.state).toBe("completed");
    const supply = await run("supply 0.5 SOL");
    expect(supply.plan.state, supply.log.join(" | ")).toBe("completed");
    const earn = await handleChat({ req: { message: "how much have I supplied to earn" }, user });
    expect(JSON.stringify(earn.answer)).toMatch(/0\.4|0\.5/);
    const redeem = await run("redeem all my SOL from earn");
    expect(redeem.plan.state, redeem.log.join(" | ")).toBe("completed");

    const swap = await run("swap 0.1 SOL to USDC");
    expect(swap.plan.state, swap.log.join(" | ")).toBe("completed");

    const farm = await run("farm 0.1 SOL on kamino");
    expect(farm.plan.state, farm.log.join(" | ")).toBe("completed");
    const pos = await handleChat({ req: { message: "show my kamino positions" }, user });
    expect(JSON.stringify(pos.answer)).toContain("kSOL");
    const out = await run("redeem my kSOL");
    expect(out.plan.state, out.log.join(" | ")).toBe("completed");
  }, 600_000);

  it("repays from margin, then a leveraged plan runs borrow -> margin swap -> report within the floor", async () => {
    expect((await run("deposit 1 SOL as collateral")).plan.state).toBe("completed");
    expect((await run("borrow 20 USDC")).plan.state).toBe("completed");
    const repay = await run("repay 10 USDC from my margin balance");
    expect(repay.plan.state, repay.log.join(" | ")).toBe("completed");

    const lever = await run("lever 0.5 SOL 2x borrowing USDC");
    expect(lever.plan.state, lever.log.join(" | ")).toBe("completed");
    const after = await handleChat({ req: { message: "what's my health factor" }, user });
    const hf = Number(after.answer!.facts.find((f) => f.label === "health factor")!.value);
    expect(hf).toBeGreaterThanOrEqual(1.15);
  }, 600_000);
});
