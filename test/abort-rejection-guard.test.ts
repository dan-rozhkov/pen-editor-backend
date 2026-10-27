import { describe, expect, it, vi } from "vitest";
import { handleUnhandledRejection, isAbortRejection } from "../src/abortRejectionGuard.js";

describe("abort rejection guard", () => {
  it("absorbs an AbortError and logs it", () => {
    const warn = vi.fn();
    handleUnhandledRejection(new DOMException("This operation was aborted", "AbortError"), warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("This operation was aborted"));
  });

  it("rethrows any other rejection so the process still crashes", () => {
    const error = new TypeError("real bug");
    expect(() => handleUnhandledRejection(error, vi.fn())).toThrow(error);
  });

  it("matches AbortError by name only", () => {
    expect(isAbortRejection(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(isAbortRejection(new Error("aborted"))).toBe(false);
    expect(isAbortRejection("AbortError")).toBe(false);
    expect(isAbortRejection(null)).toBe(false);
  });
});
