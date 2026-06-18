import { describe, expect, it } from "vitest";
import { renderEditorial } from "../../src/generate.js";

const ctx = { owner: "coder", repository: "ai-sdk" };

describe("renderEditorial", () => {
  it("renders the summary plus a Highlights list with PR links", () => {
    const md = renderEditorial(
      { summary: "A solid release.", highlights: [{ text: "Streaming works.", prNumber: 10 }] },
      ctx,
    );
    expect(md).toContain("A solid release.");
    expect(md).toContain("### Highlights");
    expect(md).toContain("- Streaming works. ([#10](https://github.com/coder/ai-sdk/pull/10))");
  });

  it("omits the Highlights section when there are none", () => {
    const md = renderEditorial({ summary: "Just a summary.", highlights: [] }, ctx);
    expect(md).toBe("Just a summary.");
  });

  it("returns an empty string when there is nothing notable (signals no injection)", () => {
    expect(renderEditorial({ summary: "   ", highlights: [] }, ctx)).toBe("");
  });

  it("omits the link when the PR number is null", () => {
    const md = renderEditorial(
      { summary: "s", highlights: [{ text: "Did a thing.", prNumber: null }] },
      ctx,
    );
    expect(md).toContain("- Did a thing.");
    expect(md).not.toContain("](http");
  });
});
