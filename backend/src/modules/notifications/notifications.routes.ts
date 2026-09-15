/** Device push-token registration for the mobile client. */
import { Router } from "express";
import { z } from "zod";
import { ValidationError } from "../../lib/errors.js";
import {
  requireAuth,
  type AuthedRequest,
  type BearerVerifier,
} from "../../middleware/auth.js";
import type { PushService } from "./push.service.js";

const registerInputSchema = z.object({
  // Expo issues tokens in these two shapes; anything else is not a token this
  // service can deliver to and is refused rather than stored to fail later.
  token: z
    .string()
    .min(1)
    .max(256)
    .regex(
      /^(ExponentPushToken\[[^\]]+\]|ExpoPushToken\[[^\]]+\])$/,
      "must be an Expo push token",
    ),
  platform: z.enum(["ios", "android"]),
});

const unregisterInputSchema = z.object({
  token: z.string().min(1).max(256),
});

export function createNotificationsRouter(
  push: PushService,
  bearerVerifier: BearerVerifier,
): Router {
  const router = Router();

  router.post("/devices", requireAuth(bearerVerifier), async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).auth?.userId;
      if (!userId) throw new ValidationError("Authenticated user is missing");

      const parsed = registerInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(
          "Invalid device registration",
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      }

      await push.register(userId, parsed.data.token, parsed.data.platform);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  /**
   * Stops delivery to one device.
   *
   * Authenticated, but not scoped to the caller's own tokens by design: a user
   * signing out on a shared handset must be able to silence it, and the token
   * itself is the only thing they hold. A token is not a secret worth guarding
   * here — the worst a guessed one achieves is silencing a device.
   */
  router.delete("/devices", requireAuth(bearerVerifier), async (req, res, next) => {
    try {
      const parsed = unregisterInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid device token");
      }
      await push.unregister(parsed.data.token);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
