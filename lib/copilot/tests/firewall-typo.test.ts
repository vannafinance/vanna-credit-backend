import { describe, expect, it } from "vitest";

import { evaluateFirewall } from "../domain-firewall";

describe("bug 7: typos in domain words are tolerated, off-topic is not", () => {
  it.each(["waht is my helth facter", "whats my helth factor", "how much can i borow", "show my colateral", "what is my balence", "liquidaton risk?"])("%s passes", (m) => {
    expect(evaluateFirewall(m).allow).toBe(true);
  });

  it.each([
    "how do I cook rice",
    "what is the weather in Delhi",
    "write me a poem about wealth",
    "tell me a joke about morning",
    "who won the cricket match",
    "explain quantum entanglement",
    "what is the capital of France",
  ])("%s is still blocked", (m) => {
    expect(evaluateFirewall(m).allow).toBe(false);
  });
});
