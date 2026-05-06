import crypto from "crypto";
import type Database from "better-sqlite3";
import {
  emitWebhookEvent as dbEmit,
  getDb,
  insertWebhookDelivery,
  listDueWebhookDeliveries,
  listPendingWebhookEvents,
  listWebhookSubscriptionsByWallet,
  markWebhookEventProcessed,
  updateWebhookDelivery,
} from "../db/database";
import { logger } from "../utils/logger";

const MAX_ATTEMPTS = 3;
// Exponential backoff after a failure: 30s · 2^(attempt-1).
//   attempt 1 → 30s, attempt 2 → 60s, attempt 3 (last) → 120s.
const BACKOFF_BASE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
// Coarse on purpose. A 30s notification window is acceptable for the events
// we emit, and a faster tick would only add SQLite write contention.
export const WORKER_TICK_MS = 30_000;

export type WebhookEventName =
  | "policy_purchased"
  | "policy_triggered"
  | "bond_minted"
  | "bond_redeemed"
  | "listing_created"
  | "listing_purchased";

/**
 * Public surface for routes / services to fan out a domain event.
 * Inserts a row in webhook_events; the worker handles the rest.
 *
 * Failures here are swallowed and logged: webhooks must NEVER block the
 * primary write path. A missing webhook tick is recoverable; a failed
 * policy purchase because the webhook insert threw is not.
 */
export function emit(event: WebhookEventName, wallet: string, payload: unknown): void {
  try {
    dbEmit(event, wallet, payload);
  } catch (err) {
    logger.error({ err, event, wallet }, "webhook emit failed (swallowed)");
  }
}

/** hex(HMAC-SHA256(body, secret)) — receivers verify by recomputing. */
export function signBody(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/** Drain pending events into per-subscription delivery rows. */
export function fanoutPendingEvents(): number {
  const events = listPendingWebhookEvents(100);
  let scheduled = 0;
  const now = Date.now();
  for (const ev of events) {
    const subs = listWebhookSubscriptionsByWallet(ev.wallet);
    for (const sub of subs) {
      // Filter is always stored as a JSON array. The single-element ["*"]
      // is the wildcard form (the route layer normalizes the literal string
      // "*" to ["*"] before insert). Anything else is an explicit allowlist.
      const filter = JSON.parse(sub.events) as string[];
      const matches =
        Array.isArray(filter) && (filter.includes("*") || filter.includes(ev.event));
      if (!matches) continue;
      insertWebhookDelivery({
        event_id: ev.id,
        subscription_id: sub.id,
        url: sub.url,
        next_attempt_at: now,
      });
      scheduled++;
    }
    markWebhookEventProcessed(ev.id);
  }
  return scheduled;
}

/**
 * Process due deliveries.
 * - 2xx → status='delivered'
 * - 4xx → status='failed' (no retry; receiver said no)
 * - 5xx / network → exponential backoff, or fail after MAX_ATTEMPTS.
 */
export async function deliverDue(now = Date.now()): Promise<void> {
  const due = listDueWebhookDeliveries(now, 50);
  await Promise.all(due.map(deliverOne));
}

async function deliverOne(d: ReturnType<typeof listDueWebhookDeliveries>[number]): Promise<void> {
  const secret = lookupSecret(d.subscription_id);
  if (!secret) {
    updateWebhookDelivery(d.id, { status: "failed", response_body: "subscription_inactive" });
    return;
  }
  const event = lookupEventPayload(d.event_id);
  if (!event) {
    updateWebhookDelivery(d.id, { status: "failed", response_body: "event_missing" });
    return;
  }
  const body = JSON.stringify(event.body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Lumina-Signature": signBody(body, secret),
    "X-Lumina-Event": event.event,
    "X-Lumina-Delivery": String(d.id),
  };
  const attempt = d.attempts + 1;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(d.url, { method: "POST", headers, body, signal: ctrl.signal });
    clearTimeout(t);
    const respBody = (await res.text()).slice(0, 1000);
    if (res.status >= 200 && res.status < 300) {
      updateWebhookDelivery(d.id, {
        status: "delivered",
        attempts: attempt,
        response_code: res.status,
        response_body: respBody,
        delivered_at: Date.now(),
      });
    } else if (res.status >= 400 && res.status < 500) {
      updateWebhookDelivery(d.id, {
        status: "failed",
        attempts: attempt,
        response_code: res.status,
        response_body: respBody,
      });
    } else {
      scheduleRetryOrFail(d.id, attempt, res.status, respBody);
    }
  } catch (err) {
    scheduleRetryOrFail(d.id, attempt, null, (err as Error).message.slice(0, 1000));
  }
}

function scheduleRetryOrFail(id: number, attempt: number, code: number | null, body: string): void {
  if (attempt >= MAX_ATTEMPTS) {
    updateWebhookDelivery(id, {
      status: "failed",
      attempts: attempt,
      response_code: code,
      response_body: body,
    });
    return;
  }
  const next = Date.now() + BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
  updateWebhookDelivery(id, {
    status: "pending",
    attempts: attempt,
    response_code: code,
    response_body: body,
    next_attempt_at: next,
  });
}

function lookupSecret(subscriptionId: number): string | undefined {
  const d: Database.Database = getDb();
  const r = d
    .prepare("SELECT secret FROM webhook_subscriptions WHERE id = ? AND active = 1")
    .get(subscriptionId) as { secret: string } | undefined;
  return r?.secret;
}

function lookupEventPayload(eventId: number): { event: string; body: unknown } | undefined {
  const d: Database.Database = getDb();
  const r = d
    .prepare("SELECT event, payload_json FROM webhook_events WHERE id = ?")
    .get(eventId) as { event: string; payload_json: string } | undefined;
  if (!r) return undefined;
  return { event: r.event, body: JSON.parse(r.payload_json) };
}

// ─── Worker driver ───────────────────────────────────────────────────────

let timer: NodeJS.Timeout | undefined;

export function startWebhookWorker(tickMs = WORKER_TICK_MS): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    try {
      fanoutPendingEvents();
      await deliverDue();
    } catch (err) {
      logger.error({ err }, "webhook worker tick failed");
    }
  };
  void tick();
  timer = setInterval(tick, tickMs);
  timer.unref?.();
  logger.info({ tickMs }, "webhook worker started");
}

export function stopWebhookWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
