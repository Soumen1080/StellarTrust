/** SEP-10 challenge/verify and current-identity routes. */
import express, { Router } from "express";
import {
  avatarUploadInputSchema,
  sep10ChallengeRequestSchema,
  sep10VerifyRequestSchema,
  updateProfileInputSchema,
} from "@stellartrust/shared";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { storeAvatar } from "./avatar.service.js";
import {
  requireAuth,
  type AuthedRequest,
  type BearerVerifier,
} from "../../middleware/auth.js";
import type { IdentityRepository } from "../identity/identity.repository.js";
import type { Sep10Service } from "./sep10.service.js";

export function createAuthRouter(
  service: Sep10Service,
  identities: IdentityRepository,
  bearerVerifier: BearerVerifier,
): Router {
  const router = Router();

  router.post("/sep10/challenge", async (req, res, next) => {
    try {
      const parsed = sep10ChallengeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(
          "Invalid SEP-10 challenge request",
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      }
      res.status(201).json(await service.createChallenge(parsed.data.account));
    } catch (err) {
      next(err);
    }
  });

  router.post("/sep10/verify", async (req, res, next) => {
    try {
      const parsed = sep10VerifyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(
          "Invalid SEP-10 verification request",
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      }
      res.json(await service.verifyChallenge(parsed.data));
    } catch (err) {
      next(err);
    }
  });

  router.get("/me", requireAuth(bearerVerifier), async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).auth?.userId;
      if (!userId) throw new NotFoundError("Identity not found");
      const profile = await identities.getProfile(userId);
      if (!profile) throw new NotFoundError("Identity not found");
      res.json(profile);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Claims the caller's permanent username.
   *
   * Conflicts (taken, or already claimed) surface as ConflictError from the
   * repository, which owns the check because only it can make the test and the
   * write atomic.
   */
  router.patch("/me", requireAuth(bearerVerifier), async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).auth?.userId;
      if (!userId) throw new NotFoundError("Identity not found");
      const parsed = updateProfileInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(
          "Invalid profile update",
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      }
      await identities.setUsername(userId, parsed.data.username);
      const profile = await identities.getProfile(userId);
      if (!profile) throw new NotFoundError("Identity not found");
      res.json(profile);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/me/avatar",
    // The app-wide parser caps bodies at 1mb, but a 2 MB image is ~2.7 MB once
    // base64-encoded, so it would be rejected as a bare 413 before any of the
    // checks below could explain why. This raises the ceiling for this one
    // route — enough to admit a valid upload and let `storeAvatar` enforce the
    // real 2 MB limit with a message the user can act on. The global cap is
    // left alone: every other endpoint takes small JSON.
    express.json({ limit: "4mb" }),
    requireAuth(bearerVerifier),
    async (req, res, next) => {
      try {
        const userId = (req as AuthedRequest).auth?.userId;
        if (!userId) throw new NotFoundError("Identity not found");
        const parsed = avatarUploadInputSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new ValidationError(
            "Invalid avatar upload",
            parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          );
        }
        // storeAvatar verifies the bytes are a real image before they are
        // stored; the data URL's declared type is not trusted.
        const avatarUrl = await storeAvatar(userId, parsed.data.dataUrl);
        await identities.setAvatarUrl(userId, avatarUrl);
        const profile = await identities.getProfile(userId);
        if (!profile) throw new NotFoundError("Identity not found");
        res.json(profile);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
