/**
 * Which bot owns which account: FNV-1a of the margin address modulo the bot count. Stable across
 * restarts and identical in every process, so two bots never send for the same account (only one
 * would land; the other pays the fee for nothing).
 */
export function shardOf(address: string, shardCount: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < address.length; i++) h = Math.imul(h ^ address.charCodeAt(i), 0x01000193) >>> 0;
  return h % shardCount;
}
