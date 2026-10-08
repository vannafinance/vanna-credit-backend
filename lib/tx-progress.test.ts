import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const state = { isOpen: false, message: "", phase: "signing", submittedAt: null as number | null, forceComplete: false, set(patch: object) { Object.assign(this, patch); } };
  return { state, success: vi.fn(), error: vi.fn(), loading: vi.fn() };
});
vi.mock("@/store/tx-progress-store", () => ({ useTxProgressStore: { getState: () => mocks.state } }));
vi.mock("react-hot-toast", () => ({ default: { success: mocks.success, error: mocks.error, loading: mocks.loading } }));
vi.mock("@/components/ui/tx-toast-progress-icon", () => ({ TxToastProgressIcon: () => null }));
import { markTxSubmitted, showTxError, showTxStep, showTxSuccess } from "./tx-progress";
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); showTxStep("first"); });
afterEach(() => vi.useRealTimers());
it("does not let an old completion timer close a new transaction", async () => {
  showTxSuccess("first done"); showTxStep("second");
  await vi.advanceTimersByTimeAsync(350);
  expect(mocks.state.isOpen).toBe(true); expect(mocks.state.message).toBe("second"); expect(mocks.state.forceComplete).toBe(false);
});
it("does not flash a success toast after an error closes the popup", async () => {
  showTxSuccess("done"); showTxError("failed");
  await vi.advanceTimersByTimeAsync(350);
  expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.state.forceComplete).toBe(false);
});
it("keeps the network timer when sending transitions to confirming", async () => {
  markTxSubmitted(); const submitted = mocks.state.submittedAt;
  await vi.advanceTimersByTimeAsync(500); markTxSubmitted();
  expect(mocks.state.submittedAt).toBe(submitted);
});
