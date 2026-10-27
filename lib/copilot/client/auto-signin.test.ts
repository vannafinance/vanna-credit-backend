import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ getSession: vi.fn(), signIn: vi.fn() }));
vi.mock("./api", () => ({ getSession: m.getSession }));
vi.mock("./siws", async (importOriginal) => ({ ...(await importOriginal<typeof import("./siws")>()), signInWithWallet: m.signIn }));

import { autoSignIn, resetAutoSignIn } from "./auto-signin";
import { SignInCancelledError } from "./siws";

const signer = (wallet = "WALLET") => ({ wallet, signMessage: vi.fn() as never });
const good = (wallet = "WALLET") => ({ authenticated: true, wallet });

beforeEach(() => { resetAutoSignIn(); m.getSession.mockReset(); m.signIn.mockReset(); });

describe("automatic sign-in of a connected wallet", () => {
  it("asks the wallet to sign when there is no session", async () => {
    m.getSession.mockResolvedValue({ authenticated: false });
    m.signIn.mockResolvedValue(good());
    expect(await autoSignIn(signer())).toEqual(good());
    expect(m.signIn).toHaveBeenCalledTimes(1);
  });

  it("does not ask again when the session is already this wallet's", async () => {
    m.getSession.mockResolvedValue(good());
    expect(await autoSignIn(signer())).toEqual(good());
    expect(m.signIn).not.toHaveBeenCalled();
  });

  it("two callers at once share one prompt", async () => {
    m.getSession.mockResolvedValue({ authenticated: false });
    let release!: (v: unknown) => void;
    m.signIn.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const a = autoSignIn(signer());
    const b = autoSignIn(signer());
    release(good());
    expect(await a).toEqual(good());
    expect(await b).toEqual(good());
    expect(m.signIn).toHaveBeenCalledTimes(1);
  });

  it("a wallet that said no is left alone for the rest of the page load", async () => {
    m.getSession.mockResolvedValue({ authenticated: false });
    m.signIn.mockRejectedValue(new SignInCancelledError());
    expect(await autoSignIn(signer())).toBeNull();
    expect(await autoSignIn(signer())).toBeNull();
    expect(m.signIn).toHaveBeenCalledTimes(1);
  });

  it("a server that was unreachable is tried again next time", async () => {
    m.getSession.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ authenticated: false });
    m.signIn.mockResolvedValue(good());
    expect(await autoSignIn(signer())).toBeNull();
    expect(await autoSignIn(signer())).toEqual(good());
  });

  it("a session for a different wallet is not taken as this wallet's", async () => {
    m.getSession.mockResolvedValue(good("OTHER"));
    m.signIn.mockResolvedValue(good());
    expect(await autoSignIn(signer())).toEqual(good());
    expect(m.signIn).toHaveBeenCalledTimes(1);
  });

  it("keeps wallets apart", async () => {
    m.getSession.mockResolvedValue({ authenticated: false });
    m.signIn.mockRejectedValueOnce(new SignInCancelledError()).mockResolvedValueOnce(good("B"));
    expect(await autoSignIn(signer("A"))).toBeNull();
    expect(await autoSignIn(signer("B"))).toEqual(good("B"));
  });
});
