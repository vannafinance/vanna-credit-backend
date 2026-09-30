/**
 * Before the server broadcasts anything a browser hands it, prove it is the transaction the server
 * built: the same message (instructions, accounts, blockhash), the fee payer is the session wallet,
 * and the only difference is the signatures. The client's amounts are never consulted because the
 * client never supplies any.
 */

import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { WorkflowError } from "./types";

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 without pulling in an undeclared dependency. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

const MAX_TX_BASE64_CHARS = 4_000; // a v0 transaction is at most 1232 bytes (~1644 base64 chars)

function decode(b64: string, what: string): VersionedTransaction {
  if (typeof b64 !== "string" || !b64 || b64.length > MAX_TX_BASE64_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new WorkflowError("bad_request", `The ${what} transaction is malformed.`, 400);
  }
  try {
    return VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  } catch {
    throw new WorkflowError("bad_request", `The ${what} transaction could not be read.`, 400);
  }
}

export interface VerifiedTx {
  /** base58 signature of the fee payer = the transaction id. */
  signature: string;
  /** Wire bytes to broadcast. */
  raw: Uint8Array;
}

/**
 * Throws WorkflowError("tx_mismatch") unless `signedB64` is `unsignedB64` plus valid signatures from
 * exactly the required signers, with `wallet` as fee payer.
 */
export function verifySignedTx(args: { unsignedB64: string; signedB64: string; wallet: string }): VerifiedTx {
  const unsigned = decode(args.unsignedB64, "stored");
  const signed = decode(args.signedB64, "signed");

  const a = unsigned.message.serialize();
  const b = signed.message.serialize();
  if (a.length !== b.length || !a.every((byte, i) => byte === b[i])) {
    throw new WorkflowError("tx_mismatch", "The signed transaction does not match the one I prepared, so I did not send it.", 409);
  }

  const keys = signed.message.staticAccountKeys;
  const required = signed.message.header.numRequiredSignatures;
  let feePayer: PublicKey;
  try {
    feePayer = new PublicKey(args.wallet);
  } catch {
    throw new WorkflowError("bad_request", "The session wallet is not a valid address.", 400);
  }
  if (!keys[0] || !keys[0].equals(feePayer)) {
    throw new WorkflowError("tx_mismatch", "The transaction's fee payer is not your connected wallet.", 409);
  }
  if (signed.signatures.length !== required) {
    throw new WorkflowError("tx_mismatch", "The signed transaction has the wrong number of signatures.", 409);
  }
  for (let i = 0; i < required; i++) {
    const sig = signed.signatures[i];
    if (!sig || sig.length !== 64 || sig.every((x) => x === 0)) {
      throw new WorkflowError("tx_mismatch", "The transaction is not fully signed.", 409);
    }
    if (!nacl.sign.detached.verify(b, sig, keys[i].toBytes())) {
      throw new WorkflowError("tx_mismatch", "A signature on the transaction is not valid for its message.", 409);
    }
  }
  return { signature: base58Encode(signed.signatures[0]), raw: signed.serialize() };
}
