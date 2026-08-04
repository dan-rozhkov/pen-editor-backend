import { describe, it, expect, vi, afterEach } from "vitest";
import {
  hasFlag,
  readFlag,
  parseCommonRepairFlags,
  parsePlatformFlag,
  parseDryRunDir,
} from "../src/showcase/cliFlags.js";

describe("readFlag", () => {
  it("reads the --name=value form, keeping spaces in the value", () => {
    expect(readFlag(["--theme=билеты в кино"], "theme")).toBe("билеты в кино");
  });

  it("reads the separated --name value form", () => {
    expect(readFlag(["--model", "moonshotai/kimi-k2.5"], "model")).toBe(
      "moonshotai/kimi-k2.5",
    );
  });

  it("returns undefined when the flag is absent", () => {
    expect(readFlag(["--model=x"], "theme")).toBeUndefined();
    expect(readFlag([], "theme")).toBeUndefined();
  });

  it("does not swallow the next flag as a value", () => {
    expect(readFlag(["--theme", "--model=x"], "theme")).toBeUndefined();
  });

  it("returns undefined for a trailing flag with no value", () => {
    expect(readFlag(["--theme"], "theme")).toBeUndefined();
  });

  it("prefers the inline form when both are present", () => {
    expect(readFlag(["--theme=a", "--theme", "b"], "theme")).toBe("a");
  });

  it("accepts an explicitly empty value", () => {
    expect(readFlag(["--theme="], "theme")).toBe("");
  });
});

describe("hasFlag", () => {
  it("is false when the flag is absent", () => {
    expect(hasFlag([], "cover")).toBe(false);
    expect(hasFlag(["--model=x"], "cover")).toBe(false);
  });

  it("is true for the bare form, even with no value following", () => {
    expect(hasFlag(["--cover"], "cover")).toBe(true);
  });

  it("is true when followed by another flag instead of a value", () => {
    expect(hasFlag(["--cover", "--dry-run"], "cover")).toBe(true);
  });

  it("is true for the inline form", () => {
    expect(hasFlag(["--cover=2"], "cover")).toBe(true);
  });

  it("is true for the separated value form", () => {
    expect(hasFlag(["--cover", "2"], "cover")).toBe(true);
  });
});

describe("parseCommonRepairFlags", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to force=false, dryRun=false, limit=undefined", () => {
    expect(parseCommonRepairFlags([], "reencode")).toEqual({
      force: false,
      dryRun: false,
      limit: undefined,
    });
  });

  it("reads --force, --dry-run and --limit together", () => {
    expect(
      parseCommonRepairFlags(["--force", "--dry-run", "--limit=5"], "reencode"),
    ).toEqual({ force: true, dryRun: true, limit: 5 });
  });

  it("accepts the separated --limit value form", () => {
    expect(parseCommonRepairFlags(["--limit", "3"], "reencode").limit).toBe(3);
  });

  it("exits with a tagged error when --limit is not a positive number", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => parseCommonRepairFlags(["--limit=0"], "rescreenshot")).toThrow("exit");

    expect(errorSpy).toHaveBeenCalledWith(
      "[rescreenshot] --limit must be a positive number",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when --limit is not a number at all", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => parseCommonRepairFlags(["--limit=nope"], "reencode")).toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("parsePlatformFlag", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to mobile when the flag is absent", () => {
    expect(parsePlatformFlag([], "showcase")).toBe("mobile");
  });

  it("reads an explicit --platform=mobile", () => {
    expect(parsePlatformFlag(["--platform=mobile"], "showcase")).toBe("mobile");
  });

  it("reads an explicit --platform=desktop", () => {
    expect(parsePlatformFlag(["--platform=desktop"], "showcase")).toBe("desktop");
  });

  it("reads the separated --platform value form", () => {
    expect(parsePlatformFlag(["--platform", "desktop"], "showcase")).toBe("desktop");
  });

  it("exits with a tagged error for an invalid platform", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => parsePlatformFlag(["--platform=tablet"], "showcase")).toThrow("exit");

    expect(errorSpy).toHaveBeenCalledWith(
      '[showcase] --platform must be "mobile" or "desktop" (got "tablet")',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("parseDryRunDir", () => {
  // The existing `afterEach(() => vi.restoreAllMocks())` in this file sits
  // inside the `parsePlatformFlag` describe block, so it does not cover this
  // one — the process.exit spy below must be torn down here.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when the flag is absent", () => {
    expect(parseDryRunDir(["--theme=x"], "showcase")).toBeUndefined();
  });

  it("reads the directory from the inline form", () => {
    expect(parseDryRunDir(["--dry-run=/tmp/probe-01"], "showcase")).toBe("/tmp/probe-01");
  });

  it("reads the directory from the separated form", () => {
    expect(parseDryRunDir(["--dry-run", "/tmp/probe-01"], "showcase")).toBe("/tmp/probe-01");
  });

  it("exits when the flag is given without a directory", () => {
    // A valueless --dry-run would otherwise read as "publish normally", which
    // is the one outcome a dry run must never produce.
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    parseDryRunDir(["--dry-run"], "showcase");

    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls[0][0]).toContain("--dry-run needs a directory");
  });
});
