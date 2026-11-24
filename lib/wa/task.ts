import OpenAI from "openai";
import { costUsd } from "@/lib/v2/track";
import type { ChatMessage } from "./ai";

/**
 * Phase 2 of the WhatsApp assistant (tiktok-hq/docs/plans/wa-assistant-plan.html):
 * "תזכיר לי מחר בעשר להתקשר לדני" → a draft task, a summary with the weekday and the date spelled out,
 * [לשמור] / [ביטול], and Bubble wa_create_task on save. A correction ("לא, ב-11") updates the draft.
 */

/** Bubble option set Task_Type (Display values, 24/11/2026). */
export const TASK_TYPES = ["משימה", "פגישה", "שיחת טלפון", "משימה אישית", "צריך לקנות", "עבודה", "הצעת מחיר"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface TaskDraft {
  title: string;
  description?: string;
  task_type: TaskType;
  /** YYYY-MM-DD in Israel, or null = no date. */
  date: string | null;
  /** HH:MM in Israel, or null = the date only (saved at DEFAULT_TIME). */
  time: string | null;
}

export const DEFAULT_TIME = "09:00";
const TZ = "Asia/Jerusalem";
const MODEL = "gpt-4o-mini";
const DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

/** Today in Israel: { date: "YYYY-MM-DD", time: "HH:MM", weekday: 0-6 }. */
export function israelNow(now = new Date()): { date: string; time: string; weekday: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday };
}

const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Israel local date + time → ISO in UTC (handles summer/winter time). */
export function toIso(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // The offset of Israel at that moment: what the wall clock shows for `guess` minus `guess`.
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(guess))
      .map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess - (wall - guess)).toISOString();
}

const ICON: Record<TaskType, string> = { "משימה": "📝", "פגישה": "🤝", "שיחת טלפון": "📞", "משימה אישית": "🙋", "צריך לקנות": "🛒", "עבודה": "🔧", "הצעת מחיר": "📄" };

/** The draft as a WhatsApp message. The weekday is computed here, never by the AI. */
export function formatTask(t: TaskDraft, buttons: boolean): string {
  const lines = [`${ICON[t.task_type]} *${t.task_type}*`, t.title];
  if (t.description) lines.push(`_${t.description}_`);
  if (t.date) {
    const [y, m, d] = t.date.split("-");
    const when = `🗓 יום ${DAYS[weekdayOf(t.date)]}, ${+d}/${+m}${y !== israelNow().date.slice(0, 4) ? `/${y}` : ""}`;
    lines.push(t.time ? `${when} בשעה ${t.time}` : `${when} (בלי שעה, נרשם ל-${DEFAULT_TIME})`);
  } else {
    lines.push("🗓 בלי תאריך");
  }
  lines.push("");
  lines.push(buttons ? "לשמור? צריך לשנות משהו? כתבו או הקליטו 👇" : "לשמור? כתבו \"שמור\". צריך לשנות משהו? כתבו או הקליטו.");
  return lines.join("\n");
}

const SYSTEM = (now: ReturnType<typeof israelNow>) => `You turn WhatsApp messages of an Israeli business owner (Hebrew, sometimes a voice transcript) into one task or calendar entry for the Tiktok (תיקתוק) app.
Now in Israel: ${now.date} ${now.time}, יום ${DAYS[now.weekday]}.
The conversation may hold a first request and then corrections ("לא, ב-11", "תשנה לפגישה"): return the task after all of them.
Return only JSON:
{"title": short Hebrew title in the user's words (who + what, no date or time), "description": extra details or "", "task_type": one of ${JSON.stringify(TASK_TYPES)}, "date": "YYYY-MM-DD" or null, "time": "HH:MM" (24h) or null}
Rules:
- task_type: "פגישה" a meeting with someone, "שיחת טלפון" a call to make, "צריך לקנות" something to buy, "עבודה" a job to do at a client, "הצעת מחיר" a quote to prepare or send, "משימה אישית" a private matter, otherwise "משימה".
- Dates are relative to now: "מחר" = tomorrow, "ביום שלישי" = the next Tuesday after today, "בעוד שבוע" = 7 days from today. A time without a date = today if it is still ahead, else tomorrow.
- Hours: "בעשר" without בלילה/בערב = 10:00, "בארבע" in a work context = 16:00, "בצהריים" = 12:00, "בבוקר" alone = null time.
- No date or time mentioned: null. Never invent one.`;

export async function extractTask(openai: OpenAI, messages: ChatMessage[]): Promise<{ task: TaskDraft; cost: number }> {
  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: 200,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM(israelNow()) },
      { role: "user", content: messages.filter((m) => m.role === "user").map((m, i) => `${i ? "תיקון" : "בקשה"}: ${m.content}`).join("\n").slice(0, 3000) },
    ],
  });
  const cost = costUsd(MODEL, res.usage) ?? 0;
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(res.choices[0]?.message?.content ?? "{}"); } catch { /* defaults below */ }
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(str(j.date)) && !Number.isNaN(Date.parse(str(j.date))) ? str(j.date) : null;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(str(j.time)) ? str(j.time) : null;
  const type = str(j.task_type);
  return {
    task: {
      title: str(j.title).slice(0, 200) || "משימה",
      description: str(j.description).slice(0, 1000) || undefined,
      task_type: (TASK_TYPES as readonly string[]).includes(type) ? (type as TaskType) : "משימה",
      date,
      time: date ? time : null,
    },
    cost,
  };
}
