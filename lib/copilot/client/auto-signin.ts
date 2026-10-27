import type { SessionResponse } from "@/lib/copilot/types";
import { getSession } from "./api";
import { isWalletRejection, signInWithWallet, SignInCancelledError, type MessageSigner } from "./siws";

/**
 * Proves a connected wallet to the Copilot without the user pressing anything, from whichever part of the page notices first.
 *
 * Two places ask: the site-wide component that fires when a wallet connects, and the Copilot page when it finds itself
 * signed out with a wallet already connected (a session that expired or was cleared while the wallet stayed connected). They share
 * this function so that:
 *  - one wallet never gets two signature prompts at once (an attempt in flight is joined, not repeated);
 *  - a wallet that said no is left alone for the rest of the page load, and the sign-in card remains the way in;
 *  - any other failure (server restarting, network) does not count as "no", so the next trigger tries again.
 */
const inflight = new Map<string, Promise<SessionResponse | null>>();
const declined = new Set<string>();

export function autoSignIn(signer: MessageSigner): Promise<SessionResponse | null> {
  const { wallet } = signer;
  if (declined.has(wallet)) return Promise.resolve(null);
  const running = inflight.get(wallet);
  if (running) return running;
  const attempt = (async (): Promise<SessionResponse | null> => {
    try {
      const current = await getSession();
      if (current.authenticated && current.wallet === wallet) return current;
      const signedIn = await signInWithWallet(signer);
      return signedIn.authenticated && signedIn.wallet === wallet ? signedIn : null;
    } catch (error) {
      if (error instanceof SignInCancelledError || isWalletRejection(error)) declined.add(wallet);
      return null;
    } finally {
      inflight.delete(wallet);
    }
  })();
  inflight.set(wallet, attempt);
  return attempt;
}

/** Test seam. */
export function resetAutoSignIn(): void {
  inflight.clear();
  declined.clear();
}
