/**
 * Actions beyond the tab's own lifecycle: click an element on the page, and
 * tell a local program (webhook). See docs/rule-schema.md.
 */
import { z } from "../core/zod";
import type { ActionHandler } from "../registries/contracts";

/** Webhooks go to this computer only: localhost, 127.0.0.1 or [::1], any port. */
export const LOCAL_WEBHOOK_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/[^\s]*)?$/;
export const isLocalWebhookUrl = (url: string) => LOCAL_WEBHOOK_PATTERN.test(url);

export const clickSchema = z.strictObject({
  type: z.literal("click"),
  selector: z.string().check(z.minLength(1), z.maxLength(500), z.describe("CSS selector of the element to click (the first match)")),
});

export const webhookSchema = z.strictObject({
  type: z.literal("webhook"),
  url: z
    .string()
    .check(
      z.maxLength(500),
      z.regex(LOCAL_WEBHOOK_PATTERN, "Must be a local address: http://localhost…, http://127.0.0.1… or http://[::1]…"),
      z.describe("Local address to POST to, e.g. http://localhost:8080/hook"),
    ),
  message: z.optional(z.string().check(z.maxLength(300))),
  includePageUrl: z.optional(z.boolean()).check(z.describe("Send the page's address too (left out by default)")),
});

export const clickAction: ActionHandler<z.infer<typeof clickSchema>> = {
  type: "click",
  title: "Click an element",
  description: "Clicks the first element matching a selector. Never clicks something that submits a form. Waits while you type.",
  schema: clickSchema,
  permissions: ["host"],
  disruptive: true,
  execute: async (c, ctx) => {
    const r = await ctx.click(c.selector);
    return r.ok ? { ok: true, message: `Clicked ${c.selector}` } : { ok: false, message: r.error };
  },
};

export const webhookAction: ActionHandler<z.infer<typeof webhookSchema>> = {
  type: "webhook",
  title: "Call a local webhook",
  description: "POSTs a short JSON message to a program on this computer. Switch webhooks on in Settings first.",
  schema: webhookSchema,
  permissions: [],
  // Tells a program, like a notification: also runs after the rule stops.
  disruptive: false,
  execute: async (c, ctx) => {
    const payload = {
      source: "justrefresh",
      event: ctx.condition,
      rule: { id: ctx.ruleId, name: ctx.ruleName },
      tab: c.includePageUrl ? { id: ctx.tabId, url: ctx.url } : { id: ctx.tabId },
      ...(c.message ? { message: c.message } : {}),
      at: new Date(ctx.now).toISOString(),
    };
    const r = await ctx.webhook(c.url, payload);
    return r.ok ? { ok: true, message: `Sent to ${c.url}` } : { ok: false, message: r.error };
  },
};
