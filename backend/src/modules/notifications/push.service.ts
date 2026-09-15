/**
 * Mobile push notifications.
 *
 * Sends through Expo's push service, which fans out to APNs and FCM. The
 * design constraints come from what is being notified about:
 *
 *  - **Never put money detail in a notification.** A push payload is rendered
 *    on a lock screen, in front of whoever is holding the phone. "Your escrow
 *    was released" is fine; the amount and the counterparty are not. The body
 *    says what happened and the app shows the detail behind the device lock.
 *  - **A failed send is never allowed to fail the operation.** This is called
 *    from inside domain flows that have already moved money. A push service
 *    being down must not roll back a settlement.
 *  - **Dead tokens are retired, not retried.** Expo reports
 *    `DeviceNotRegistered` for an uninstalled app; a token kept after that
 *    errors on every future send forever.
 */
import type { Pool } from "pg";
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Expo accepts at most 100 messages per request. */
const BATCH_SIZE = 100;

export interface PushMessage {
  title: string;
  body: string;
  /** Deep-link target, e.g. `{ screen: "OrderDetail", orderId }`. */
  data?: Record<string, string>;
}

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

export class PushService {
  constructor(private readonly pool: Pool | undefined) {}

  /** Records a device's token, or refreshes one already on file. */
  async register(
    userId: string,
    token: string,
    platform: "ios" | "android",
  ): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `insert into device_push_tokens (user_id, token, platform)
       values ($1, $2, $3)
       on conflict (token) do update
         set user_id      = excluded.user_id,
             platform     = excluded.platform,
             revoked_at   = null,
             last_seen_at = now()`,
      [userId, token, platform],
    );
  }

  /** Retires a token the user has asked to stop receiving on. */
  async unregister(token: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `update device_push_tokens set revoked_at = now() where token = $1`,
      [token],
    );
  }

  /**
   * Notify one user on every live device they have.
   *
   * Never throws. Callers are domain flows that have already committed;
   * a notification failure is logged and dropped, not propagated.
   */
  async notify(userId: string, message: PushMessage): Promise<void> {
    try {
      const tokens = await this.liveTokens(userId);
      if (tokens.length === 0) return;
      await this.send(tokens, message);
    } catch (err) {
      logger.warn(
        { userId, errorType: (err as Error).name },
        "push: notification failed",
      );
    }
  }

  private async liveTokens(userId: string): Promise<string[]> {
    if (!this.pool) return [];
    const { rows } = await this.pool.query<{ token: string }>(
      `select token from device_push_tokens
       where user_id = $1 and revoked_at is null`,
      [userId],
    );
    return rows.map((row) => row.token);
  }

  private async send(tokens: string[], message: PushMessage): Promise<void> {
    for (let index = 0; index < tokens.length; index += BATCH_SIZE) {
      const batch = tokens.slice(index, index + BATCH_SIZE);
      const payload = batch.map((token) => ({
        to: token,
        title: message.title,
        body: message.body,
        data: message.data ?? {},
        sound: "default",
        // Escrow and settlement events are time-sensitive; the platform is
        // told so rather than batching them into a quiet-hours digest.
        priority: "high",
      }));

      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(config.EXPO_ACCESS_TOKEN
            ? { authorization: `Bearer ${config.EXPO_ACCESS_TOKEN}` }
            : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, "push: expo rejected batch");
        continue;
      }

      const result = (await response.json()) as { data?: ExpoTicket[] };
      await this.retireDeadTokens(batch, result.data ?? []);
    }
  }

  /**
   * Retires tokens Expo reports as no longer deliverable.
   *
   * Tickets come back positionally, so a ticket's index is its token's index.
   */
  private async retireDeadTokens(
    tokens: string[],
    tickets: ExpoTicket[],
  ): Promise<void> {
    const dead = tickets
      .map((ticket, index) =>
        ticket.status === "error" &&
        ticket.details?.error === "DeviceNotRegistered"
          ? tokens[index]
          : undefined,
      )
      .filter((token): token is string => token !== undefined);

    if (dead.length === 0 || !this.pool) return;

    await this.pool.query(
      `update device_push_tokens set revoked_at = now() where token = any($1)`,
      [dead],
    );
    logger.info({ count: dead.length }, "push: retired unregistered devices");
  }
}
