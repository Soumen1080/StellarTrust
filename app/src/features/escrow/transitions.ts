/**
 * Which escrow steps a given party may take right now.
 *
 * The contract and the API both enforce this; the UI encodes it so a user is
 * never offered a button that will be refused. Anything not listed for a
 * status is genuinely unavailable at that point, not merely hidden.
 */
import { OrderStatus, PaymentTransition } from "@stellartrust/shared";

export type Party = "buyer" | "seller";

export interface AvailableAction {
  transition: PaymentTransition;
  label: string;
  /** What the user is actually agreeing to. Shown before they commit. */
  blurb: string;
  /** Destructive or irreversible steps get the confirm sheet. */
  confirm: boolean;
  variant: "primary" | "secondary" | "danger";
}

const ACTIONS: Record<
  string,
  Partial<Record<Party, AvailableAction[]>>
> = {
  [OrderStatus.Created]: {
    seller: [
      {
        transition: PaymentTransition.Accept,
        label: "Accept order",
        blurb: "Agree to supply the goods or service at this price.",
        confirm: false,
        variant: "primary",
      },
    ],
  },
  [OrderStatus.Accepted]: {
    buyer: [
      {
        transition: PaymentTransition.Deposit,
        label: "Deposit funds",
        blurb:
          "Move the amount from your balance into this order, ready to be locked in the contract.",
        confirm: true,
        variant: "primary",
      },
    ],
  },
  [OrderStatus.Deposited]: {
    buyer: [
      {
        transition: PaymentTransition.Lock,
        label: "Lock in escrow",
        blurb:
          "Funds move into the contract. Neither side can take them until you confirm delivery or a dispute is settled.",
        confirm: true,
        variant: "primary",
      },
    ],
  },
  [OrderStatus.Locked]: {
    buyer: [
      {
        transition: PaymentTransition.Confirm,
        label: "Confirm delivery",
        blurb:
          "You have received what you paid for. This releases the funds to the seller.",
        confirm: true,
        variant: "primary",
      },
      {
        transition: PaymentTransition.Dispute,
        label: "Raise a dispute",
        blurb:
          "Something is wrong with the order. An arbiter will review the evidence and decide.",
        confirm: true,
        variant: "danger",
      },
    ],
    seller: [
      {
        transition: PaymentTransition.Dispute,
        label: "Raise a dispute",
        blurb:
          "The buyer is not confirming a delivery you have made. An arbiter will review the evidence.",
        confirm: true,
        variant: "danger",
      },
    ],
  },
  [OrderStatus.Confirmed]: {
    seller: [
      {
        transition: PaymentTransition.Release,
        label: "Release funds",
        blurb: "Take the funds the buyer has confirmed.",
        confirm: true,
        variant: "primary",
      },
    ],
  },
};

export function actionsFor(
  status: string,
  party: Party,
): AvailableAction[] {
  return ACTIONS[status]?.[party] ?? [];
}

/** Plain-language explanation of where an order stands. */
export function statusExplanation(status: string, party: Party): string {
  switch (status) {
    case OrderStatus.Created:
      return party === "seller"
        ? "The buyer has opened this order. Accept it to go ahead."
        : "Waiting for the seller to accept.";
    case OrderStatus.Accepted:
      return party === "buyer"
        ? "Deposit the funds to move forward."
        : "Waiting for the buyer to deposit.";
    case OrderStatus.Deposited:
      return party === "buyer"
        ? "Lock the funds in the contract to protect both sides."
        : "The buyer has deposited. Waiting for them to lock the funds.";
    case OrderStatus.Locked:
      return party === "buyer"
        ? "Funds are held in the contract. Confirm once you have received the goods."
        : "Funds are locked. They are released when the buyer confirms delivery.";
    case OrderStatus.Confirmed:
      return party === "seller"
        ? "The buyer has confirmed. Release the funds to yourself."
        : "You have confirmed. The seller can now take the funds.";
    case OrderStatus.Released:
      return "Complete. The funds went to the seller.";
    case OrderStatus.Refunded:
      return "Complete. The funds went back to the buyer.";
    case OrderStatus.Disputed:
      return "Under dispute. An arbiter is reviewing the evidence from both sides.";
    case OrderStatus.Cancelled:
      return "This order was cancelled. No funds moved.";
    default:
      return "";
  }
}
