/**
 * Sign-In-With-Solana from the browser: nonce -> wallet `signMessage` -> verify -> session cookie.
 *
 * The message is signed byte-for-byte as the server issued it; this file never composes or
 * edits it, so a mismatch can only mean the server or the wallet changed it.
 */

import type { SessionResponse } from "@/lib/copilot/types";
import { getNonce, verifyLogin } from "./api";

export class SignInCancelledError extends Error {
  constructor() {
    super("Sign-in was cancelled in the wallet.");
    this.name = "SignInCancelledError";
  }
}

const REJECTED = /user rejected|rejected the request|user denied|denied by the user|user cancel|declined|4001/i;

export function isWalletRejection(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return REJECTED.test(text);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface MessageSigner {
  wallet: string;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}

export async function signInWithWallet({ wallet, signMessage }: MessageSigner): Promise<SessionResponse> {
  const nonce = await getNonce(wallet);
  let signature: Uint8Array;
  try {
    signature = await signMessage(new TextEncoder().encode(nonce.message));
  } catch (error) {
    if (isWalletRejection(error)) throw new SignInCancelledError();
    throw error;
  }
  return verifyLogin({ wallet, message: nonce.message, signature: bytesToBase64(signature) });
}
