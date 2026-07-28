import type { ShowcaseStore } from "./store.js";

// Post-hoc pin management for `npm run showcase:pin` — separate from
// `--cover` at publish time because a run that's already live sometimes turns
// out to deserve the front slot (or stops deserving it) without re-running
// the whole pipeline. Kept as a pure function over injected deps, same shape
// as rescreenshot.ts, so the CLI parsing and the store wiring can be tested
// independently.

export interface PinDeps {
  store: Pick<ShowcaseStore, "listScreens" | "pinScreen" | "clearPin">;
  log(message: string): void;
}

export type PinAction =
  | { kind: "pin"; screenId: string }
  | { kind: "clear"; runId?: string }
  | { kind: "list"; limit: number };

export interface PinArgs {
  screen?: string;
  clear: boolean;
  list: boolean;
  limit?: number;
  run?: string;
}

/** Turns raw argv flags into exactly one action, or throws on an ambiguous or
 * malformed combination — validating this before opening any DB connection
 * keeps `pinRun.ts` from half-doing something on a typo. */
export function resolvePinAction(args: PinArgs): PinAction {
  const modesRequested = [
    args.screen !== undefined,
    args.clear,
    args.list,
  ].filter(Boolean).length;

  if (modesRequested > 1) {
    throw new Error("--screen, --clear and --list are mutually exclusive");
  }

  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }

  // `--run` narrows what `--clear` clears; it has no meaning against `--screen`
  // (a screen's own run_id already determines what gets pinned) or `--list`
  // (listing is unfiltered by design — it's how you find run ids in the
  // first place), so a typo there fails loudly instead of being ignored.
  if (args.run !== undefined && !args.clear) {
    throw new Error("--run is only valid together with --clear");
  }

  if (args.screen !== undefined) {
    if (!args.screen) throw new Error("--screen requires a screen id");
    return { kind: "pin", screenId: args.screen };
  }
  if (args.clear) {
    if (args.run !== undefined && !args.run) throw new Error("--run requires a run id");
    return { kind: "clear", runId: args.run };
  }
  // Listing is the default: with nothing specified there is nothing to act
  // on, and showing what's there (and where the uuids are) is the whole
  // reason to run this command in the first place.
  return { kind: "list", limit: args.limit ?? DEFAULT_PIN_LIST_LIMIT };
}

export const DEFAULT_PIN_LIST_LIMIT = 24;

export async function runPinAction(deps: PinDeps, action: PinAction): Promise<void> {
  switch (action.kind) {
    case "pin": {
      const ok = await deps.store.pinScreen(action.screenId);
      if (!ok) {
        throw new Error(`no showcase screen with id ${action.screenId}`);
      }
      deps.log(`[pin] pinned ${action.screenId} as its app's cover screen`);
      return;
    }
    case "clear": {
      await deps.store.clearPin(action.runId);
      if (action.runId) {
        deps.log(`[pin] cleared the pinned screen for run ${action.runId}`);
      } else {
        deps.log(
          "[pin] cleared every pinned screen (each app falls back to created_at order)",
        );
      }
      return;
    }
    case "list": {
      const { screens } = await deps.store.listScreens({ limit: action.limit });
      if (screens.length === 0) {
        deps.log("[pin] no published screens");
        return;
      }
      // Screens of one run are guaranteed contiguous in feed order (the store
      // sorts apps by recency, then screens within an app), so a single pass
      // that prints a header whenever run_id changes is enough to group —
      // no need to bucket screens by run_id first.
      let lastRunId: string | undefined;
      for (const screen of screens) {
        if (screen.runId !== lastRunId) {
          deps.log(`${screen.theme} (run ${screen.runId})`);
          lastRunId = screen.runId;
        }
        const mark = screen.pinned ? "[pinned] " : "";
        deps.log(`  ${mark}${screen.id}  ${screen.createdAt}  ${screen.title}`);
      }
      return;
    }
  }
}
