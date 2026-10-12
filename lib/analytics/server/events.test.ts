import { beforeEach, describe, expect, it } from "vitest";
import { VANNA_IDL } from "@/lib/solana/program";
import { eventCounts, listEvents, recordEvents, resetEventsForTests } from "./events";

const disc = (name: string) => Buffer.from((VANNA_IDL as unknown as { events: Array<{ name: string; discriminator: number[] }> }).events.find((e) => e.name === name)!.discriminator);
const line = (bytes: Buffer) => `Program data: ${bytes.toString("base64")}`;

describe("event decoding is size-checked", () => {
  beforeEach(() => resetEventsForTests());

  it("decodes an event whose bytes match the current layout exactly", () => {
    // MarginCreated = margin_account(32) + authority(32) + timestamp(8)
    recordEvents("sig-ok", 100, [line(Buffer.concat([disc("MarginCreated"), Buffer.alloc(72)]))]);
    expect(eventCounts()).toEqual({ MarginCreated: 1 });
    expect(listEvents()[0].time).toBe(100);
  });

  it("skips an older-layout event that shares the discriminator but has a different length", () => {
    // An older program version emitted a shorter/longer payload under the same name. It must not reach the decoder.
    recordEvents("sig-old", 1, [line(Buffer.concat([disc("Borrowed"), Buffer.alloc(40)])), line(Buffer.concat([disc("Borrowed"), Buffer.alloc(500)]))]);
    expect(eventCounts()).toEqual({});
  });

  it("ignores unknown data, oversized lines and variable-length events", () => {
    recordEvents("sig-x", 1, [line(Buffer.alloc(16, 7)), `Program data: ${"A".repeat(5000)}`, line(Buffer.concat([disc("MarginExecuted"), Buffer.alloc(200)])), "Program log: hello"]);
    expect(eventCounts()).toEqual({});
  });
});
