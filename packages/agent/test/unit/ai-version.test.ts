import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSupportedAiVersion,
  resetAiVersionCheckForTests,
  unsupportedAiVersionMessage,
} from "../../src/ai-version.js";
import { CoderAgentError } from "../../src/errors.js";

afterEach(() => {
  resetAiVersionCheckForTests();
});

describe("unsupportedAiVersionMessage", () => {
  it("accepts ai v6 releases", () => {
    expect(unsupportedAiVersionMessage("6.0.208")).toBeUndefined();
    expect(unsupportedAiVersionMessage("6.12.3")).toBeUndefined();
    expect(unsupportedAiVersionMessage("6")).toBeUndefined();
  });

  it("accepts v6 prereleases and build metadata", () => {
    expect(unsupportedAiVersionMessage("6.0.0-beta.3")).toBeUndefined();
    expect(unsupportedAiVersionMessage("6.0.0+build.5")).toBeUndefined();
  });

  it("rejects other majors with an actionable message", () => {
    const msg = unsupportedAiVersionMessage("7.0.0");
    expect(msg).toContain("ai@7.0.0");
    expect(msg).toContain("ai@^6");
    expect(unsupportedAiVersionMessage("5.0.51")).toContain("ai@^6");
    // No prefix confusion: 60.x must not pass as 6.x.
    expect(unsupportedAiVersionMessage("60.0.0")).toContain("ai@^6");
  });

  it("rejects prereleases of other majors", () => {
    expect(unsupportedAiVersionMessage("7.0.0-canary.12")).toContain("ai@7.0.0-canary.12");
  });

  it("fails open on unparseable versions", () => {
    expect(unsupportedAiVersionMessage("")).toBeUndefined();
    expect(unsupportedAiVersionMessage("garbage")).toBeUndefined();
    expect(unsupportedAiVersionMessage("next")).toBeUndefined();
    expect(unsupportedAiVersionMessage(".1.2")).toBeUndefined();
    expect(unsupportedAiVersionMessage("x7.0.0")).toBeUndefined();
  });
});

describe("assertSupportedAiVersion", () => {
  it("passes against the actually installed ai (v6, resolved for real)", () => {
    expect(() => assertSupportedAiVersion()).not.toThrow();
  });

  it("memoizes the resolution (one resolve across many asserts)", () => {
    const resolve = vi.fn(() => "6.0.208");
    assertSupportedAiVersion(resolve);
    assertSupportedAiVersion(resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("throws a CoderAgentError on every call for an unsupported major", () => {
    const resolve = vi.fn(() => "7.2.0");
    expect(() => assertSupportedAiVersion(resolve)).toThrow(CoderAgentError);
    // The memoized verdict keeps throwing without re-resolving.
    expect(() => assertSupportedAiVersion(resolve)).toThrow(/ai@\^6/);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("fails open when no version can be resolved", () => {
    expect(() => assertSupportedAiVersion(() => undefined)).not.toThrow();
  });
});
