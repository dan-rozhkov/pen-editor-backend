import { tool } from "ai";
import { z } from "zod";

/**
 * Client-executed tools of agentMode "browser" (Sideform Light): create and list
 * scheduled chats. NO `execute`: the client runs them. Deliberately NOT part of
 * `penTools`: pen-editor never sees them, and its cross-repo tool-contract test
 * checks `penTools`. prepareChatTurn adds them only when
 * `clientCapabilities.schedules` is true in a browser-mode turn.
 */
const CRON_MESSAGE = "Use 5 fields: minute hour day-of-month month day-of-week, e.g. 0 9 * * 1-5";
// Exactly 5 whitespace-separated fields of cron characters (digits, month/day
// names, * , - /). The client does the real parsing; this rejects @daily,
// 6-field and free text early.
function isFiveFieldCron(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => /^[0-9A-Za-z*,\-/]+$/.test(f));
}

export const scheduleCreateInputSchema = z.object({
  name: z.string().min(1).max(100).describe("Short name of the schedule, for example \"Morning price check\"."),
  prompt: z
    .string()
    .min(1)
    .max(20000)
    .describe(
      "The complete task that each run does. Each run starts a new chat that does not see this conversation, so include the sites and URLs, every constraint, and what to report.",
    ),
  cron: z
    .string()
    .min(1)
    .max(100)
    .refine(isFiveFieldCron, { message: CRON_MESSAGE })
    .describe("Cron expression with 5 fields: minute hour day-of-month month day-of-week. Local time of the person. Example: \"0 9 * * 1-5\"."),
});

export const scheduleTools = {
  schedule_create: tool({
    description:
      "Create a scheduled chat: a task that the app runs again and again at set times. " +
      "Use it only when the person asks for a task that repeats or runs at set times (for example every morning, every Monday, every hour). " +
      "Schedules repeat. There is no one-off run. " +
      "Call schedule_list first, so you do not create a duplicate. " +
      "`prompt` must be a complete, self-contained task. Each run starts a new chat that does not see this conversation. " +
      "Put in `prompt`: the sites and URLs, every constraint (names, dates, prices, filters), and what to report. " +
      "`cron` has 5 fields: minute hour day-of-month month day-of-week. Use the local time of the person. " +
      "Examples: \"0 9 * * *\" is every day at 09:00. \"30 8 * * 1-5\" is Monday to Friday at 08:30. \"0 */6 * * *\" is every 6 hours. " +
      "The person must confirm in the chat. The tool waits until the person decides. " +
      "Returns {\"status\":\"created\",\"schedule\":{id,name,cron,description,enabled,nextRun?,lastRun?}}, " +
      "{\"status\":\"declined\"} when the person said no, or {\"status\":\"error\",\"error\"} (for example an invalid cron: fix it and try again). " +
      "This tool runs in the user's browser (client side) and has no server-side execute.",
    inputSchema: scheduleCreateInputSchema,
  }),

  schedule_list: tool({
    description:
      "List the existing scheduled chats. " +
      "Call it before schedule_create, and when the person asks what is scheduled. " +
      "Returns {\"schedules\":[{id,name,cron,description,enabled,nextRun?,lastRun?}]}, or {\"status\":\"error\",\"error\"}. " +
      "nextRun and lastRun.at are readable local times. " +
      "This tool runs in the user's browser (client side) and has no server-side execute.",
    inputSchema: z.object({}),
  }),
};

export const SCHEDULE_TOOL_NAMES = Object.keys(scheduleTools) as Array<keyof typeof scheduleTools>;
