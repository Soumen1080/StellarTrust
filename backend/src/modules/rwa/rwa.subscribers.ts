/**
 * RWA's subscriptions to the event spine (plane.md §2.2, §2.3).
 *
 * These are the other half of removing `PaymentService.triggerRwaPayout`.
 * Payments now publishes `order.released`; this decides what that means for a
 * tokenization. The dependency that used to point payments → RWA now points
 * RWA → the spine, which is the direction that composes: a fifth domain can
 * subscribe to the same fact without payments learning anything about it.
 *
 * Each handler is registered under a stable name and claimed before it runs
 * (see {@link EventBus}), so a redelivered event distributes a payout exactly
 * once. That guarantee is load-bearing here in a way it is not for a logging
 * subscriber — these move money.
 */
import { TokenizationStatus } from "@stellartrust/shared";
import { logger } from "../../lib/logger.js";
import type { EventHandler } from "../events/event.bus.js";
import type { DomainEvent } from "../events/event.repository.js";
import { DomainEventType, HandlerName } from "../events/event.types.js";
import type { DisputeReader } from "./rwa.service.js";
import type { RwaRepository } from "./rwa.repository.js";
import type { RwaService } from "./rwa.service.js";

/** The system actor for platform-initiated payouts. */
const SYSTEM_ACTOR = { userId: "system", roles: ["system"] };

/**
 * Distribute an RWA payout when a linked escrow order is released.
 *
 * The release is the *collection*: the debtor has paid, and the money is now
 * the tokenization's to split down the waterfall (§1.3). An order with no
 * tokenization behind it is the common case and is skipped silently.
 */
export function rwaPayoutOnRelease(
  rwa: RwaService,
  repository: RwaRepository,
  disputes?: DisputeReader,
): EventHandler {
  return {
    name: HandlerName.RwaPayoutOnRelease,
    eventType: DomainEventType.OrderReleased,
    async handle(event: DomainEvent): Promise<void> {
      const orderId = event.entityId;
      const tokenizations = await repository.listTokenizations({
        linkedOrderId: orderId,
      });
      if (tokenizations.length === 0) return;
      if (tokenizations.length > 1) {
        logger.warn(
          { orderId, count: tokenizations.length },
          "order has multiple tokenizations; distributing for the first only",
        );
      }

      const tokenization = tokenizations[0];
      if (!tokenization) return;

      // An open dispute outranks a release (§2.2). The escrow may have been
      // released by one path while the dispute is still live; paying investors
      // now would hand out money that may have to be clawed back from people
      // who have no obligation to return it.
      if (disputes && (await disputes.hasOpenDispute(orderId))) {
        logger.warn(
          { orderId, tokenizationId: tokenization.id },
          "refusing RWA payout: dispute open on the linked order",
        );
        return;
      }

      const amount = String(event.payload.amount ?? "");
      const currency = String(event.payload.currency ?? "");
      if (!/^\d+$/.test(amount) || currency.length === 0) {
        throw new Error(
          `order.released for ${orderId} carried no usable amount/currency`,
        );
      }

      await rwa.distributePayout(
        tokenization.id,
        orderId,
        "release",
        BigInt(amount),
        currency,
        SYSTEM_ACTOR,
      );
    },
  };
}

/**
 * Hold a tokenization's payout while a dispute is open on its linked order.
 *
 * `PayoutHeld` is a real state, not a flag: it is what a holder sees, and it is
 * what {@link RwaService.distributePayout} refuses to pay out of. Holding is
 * the investor protection — a disputed invoice may be refunded to the buyer,
 * in which case there was never anything to distribute.
 */
export function rwaHoldOnDispute(repository: RwaRepository): EventHandler {
  return {
    name: HandlerName.RwaHoldOnDispute,
    eventType: DomainEventType.DisputeOpened,
    async handle(event: DomainEvent): Promise<void> {
      const orderId = String(event.payload.orderId ?? "");
      if (!orderId) return;

      const tokenizations = await repository.listTokenizations({
        linkedOrderId: orderId,
      });
      for (const tokenization of tokenizations) {
        // Only a position that could still pay out needs holding. One already
        // repaid, defaulted, or written off is past the point where a dispute
        // can change where the money goes.
        if (
          tokenization.status !== TokenizationStatus.Active &&
          tokenization.status !== TokenizationStatus.Funded
        ) {
          continue;
        }
        await repository.updateTokenization({
          ...tokenization,
          status: TokenizationStatus.PayoutHeld,
          updatedAt: new Date().toISOString(),
        });
        logger.info(
          { tokenizationId: tokenization.id, orderId },
          "RWA payout held pending dispute",
        );
      }
    },
  };
}

/**
 * Resume or default a held position once its dispute resolves.
 *
 * Two outcomes, two very different meanings:
 *
 *   seller's favour — the trade stands. The hold lifts and the position returns
 *     to `Funded`, where a release can pay it out normally.
 *
 *   buyer's favour — the money goes back to the buyer, so the receivable behind
 *     the tokenization will never be collected. That is a `Defaulted` position
 *     (plane.md §2.2), which routes it into the §1.4 write-off path where
 *     whatever is recovered is distributed pro-rata rather than paid as a
 *     normal waterfall.
 */
export function rwaResumeOnDisputeResolved(
  repository: RwaRepository,
): EventHandler {
  return {
    name: HandlerName.RwaResumeOnDisputeResolved,
    eventType: DomainEventType.DisputeResolved,
    async handle(event: DomainEvent): Promise<void> {
      const orderId = String(event.payload.orderId ?? "");
      const outcome = String(event.payload.outcome ?? "");
      if (!orderId) return;

      const tokenizations = await repository.listTokenizations({
        linkedOrderId: orderId,
      });
      for (const tokenization of tokenizations) {
        if (tokenization.status !== TokenizationStatus.PayoutHeld) continue;

        // A refund means the buyer's money went back; there is no collection
        // coming. Anything else leaves the trade standing.
        const refunded = outcome === "refund" || outcome === "buyer";
        const next = refunded
          ? TokenizationStatus.Defaulted
          : TokenizationStatus.Funded;

        await repository.updateTokenization({
          ...tokenization,
          status: next,
          updatedAt: new Date().toISOString(),
        });
        logger.info(
          { tokenizationId: tokenization.id, orderId, outcome, next },
          "RWA position released from dispute hold",
        );
      }
    },
  };
}
