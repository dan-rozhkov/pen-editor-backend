import type { ShowcaseStore } from "./store.js";

// Un-publishing for `npm run showcase:delete` — the counterpart to
// `showcase:generate`/`showcase:ingest`, for the runs that turn out not to be
// worth showing. Pure functions over injected deps, same shape as pin.ts, so
// the flag parsing and the store wiring are testable without Postgres.
//
// Rows only: the S3 objects stay. See `ShowcaseStore.deleteScreens`.

export interface DeleteDeps {
  store: Pick<ShowcaseStore, "deleteScreens" | "listScreenSources" | "getScreenSource">;
  log(message: string): void;
}

export type DeleteAction =
  // `id` is a run_id *or* any screen id belonging to the run — in practice
  // you spot the bad app in the gallery, where the id you can copy is a
  // screen's.
  | { kind: "app"; id: string; dryRun: boolean }
  | { kind: "screen"; id: string; dryRun: boolean };

export interface DeleteArgs {
  app?: string;
  screen?: string;
  dryRun: boolean;
}

/** Turns raw argv flags into exactly one action, or throws — validated before
 * any DB connection is opened so a typo can't half-delete anything. There is
 * deliberately no default action: with no target given, the only safe thing a
 * delete command can do is refuse. */
export function resolveDeleteAction(args: DeleteArgs): DeleteAction {
  if (args.app !== undefined && args.screen !== undefined) {
    throw new Error("--app and --screen are mutually exclusive");
  }
  if (args.app !== undefined) {
    if (!args.app) throw new Error("--app requires a run id or screen id");
    return { kind: "app", id: args.app, dryRun: args.dryRun };
  }
  if (args.screen !== undefined) {
    if (!args.screen) throw new Error("--screen requires a screen id");
    return { kind: "screen", id: args.screen, dryRun: args.dryRun };
  }
  throw new Error(
    "nothing to delete: pass --app <run-id|screen-id> (the whole run) or --screen <screen-id> (one screen)",
  );
}

export async function runDeleteAction(
  deps: DeleteDeps,
  action: DeleteAction,
): Promise<void> {
  if (action.dryRun) {
    // The dry run reads through the same id-resolution as the delete itself
    // (`listScreenSources({ appOf })` shares the COALESCE with
    // `deleteScreens({ appOf })`), so what it prints is what would go.
    const doomed =
      action.kind === "app"
        ? await deps.store.listScreenSources({ appOf: action.id })
        : [await deps.store.getScreenSource(action.id)].filter((s) => s !== null);
    if (doomed.length === 0) {
      throw new Error(noMatchMessage(action));
    }
    deps.log(`[delete] --dry-run: would delete ${doomed.length} screen(s):`);
    for (const screen of doomed) {
      deps.log(`  ${screen.id}  ${screen.title}`);
    }
    return;
  }

  const deleted = await deps.store.deleteScreens(
    action.kind === "app" ? { appOf: action.id } : { screen: action.id },
  );
  if (deleted.length === 0) {
    throw new Error(noMatchMessage(action));
  }
  for (const screen of deleted) {
    deps.log(`  ${screen.id}  ${screen.title}`);
  }
  const runIds = [...new Set(deleted.map((s) => s.runId))];
  deps.log(
    `[delete] deleted ${deleted.length} screen(s) from run ${runIds.join(", ")}` +
      " (S3 objects left in place)",
  );
}

function noMatchMessage(action: DeleteAction): string {
  return action.kind === "app"
    ? `no showcase screens for run or screen id ${action.id}`
    : `no showcase screen with id ${action.id}`;
}
