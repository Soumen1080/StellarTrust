/**
 * Payments' subscriptions to the event spine (plane.md §2.1, §2.3).
 *
 * One subscriber so far: a completed cross-border settlement drives the escrow
 * order it funded into `Deposit`. Before this, the two domains did not know
 * about each other at all — the buyer paid the corridor, the money arrived, and
 * the order still sat waiting for a deposit, so they paid a second time to fund
 * the escrow they had just funded.
 *
 * The direction matters: settlement publishes that it delivered, and payments
 * decides what that means for an order. Settlement never learns what an escrow
 * is.
 */
import { PaymentTransition } from "@stellartrust/shared";
import { logger } from "../../lib/logger.js";
import type { EventHandler } from "../events/event.bus.js";
import type { DomainEvent } from "../events/event.repository.js";
import { DomainEventType, HandlerName } from "../events/event.types.js";
import type { PaymentService } from "./payment.service.js";

/**
 * Drive an escrow order's deposit when its funding settlement completes.
 *
 * The actor is the order's buyer, not a system principal: this *is* the buyer's
 * deposit, made through a corridor rather than directly, and attributing it to
 * anyone else would make the escrow's own authorization checks meaningless.
 */
export function orderDepositOnSettlement(
  payments: PaymentService,
): EventHandler {
  return {
    name: HandlerName.OrderDepositOnSettlement,
    eventType: DomainEventType.SettlementCompleted,
    async handle(event: DomainEvent): Promise<void> {
      const orderId = String(event.payload.orderId ?? "");
      if (!orderId) return;

      // `actor` is `user:<id>` — the buyer who executed the settlement, whose
      // right to fund this order settlement already verified before moving any
      // money.
      const buyerId = event.actor.startsWith("user:")
        ? event.actor.slice("user:".length)
        : "";
      if (!buyerId) {
        throw new Error(
          `settlement.completed for order ${orderId} carried no user actor`,
        );
      }

      await payments.transition(orderId, PaymentTransition.Deposit, {
        userId: buyerId,
        roles: ["user"],
      });

      logger.info(
        { orderId, settlementId: event.entityId },
        "escrow order deposited from a completed settlement",
      );
    },
  };
}
