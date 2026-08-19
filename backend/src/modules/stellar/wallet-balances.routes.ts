/**
 * Read-only wallet balance route. Resolves the caller's own Stellar address
 * through the same SEP-10-backed resolver escrow uses — never a
 * client-supplied address — then reads it back from Horizon.
 */
import { Router } from "express";
import { type AuthedRequest, type BearerVerifier, requireAuth } from "../../middleware/auth.js";
import { ValidationError } from "../../lib/errors.js";
import type { WalletAddressResolver } from "../identity/wallet.resolver.js";
import type { StellarClient } from "./stellar.client.js";
import { getWalletBalances } from "./wallet-balances.service.js";

export function createWalletBalancesRouter(
  client: StellarClient,
  addresses: WalletAddressResolver,
  verifier?: BearerVerifier,
): Router {
  const router = Router();

  router.get("/balances", requireAuth(verifier), async (req, res, next) => {
    try {
      const auth = (req as AuthedRequest).auth;
      if (!auth) throw new ValidationError("Authenticated actor is missing");
      const address = await addresses.resolve(auth.userId, "caller");
      res.json(await getWalletBalances(client, address));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
