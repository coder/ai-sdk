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

  it("keeps a summary that starts with a heading marker from becoming a version header", () => {
    const md = renderEditorial({ summary: "## [9.9.9] not a release", highlights: [] }, ctx);
    // release-please finds the previous entry with this pattern (DEFAULT_VERSION_HEADER_REGEX).
    expect(`\n${md}`).not.toMatch(/\n###? v?[0-9[]/);
    expect(md).not.toMatch(/^#{1,6} /m);
    expect(md).toContain("[9.9.9] not a release");
  });

  it("keeps a highlight that starts with a heading marker from rendering as a heading", () => {
    const md = renderEditorial(
      { summary: "s", highlights: [{ text: "## [1.2.3] not a heading", prNumber: null }] },
      ctx,
    );
    expect(md).toContain("- \\## [1.2.3] not a heading");
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
