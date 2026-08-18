/**
 * User id → Stellar address resolution for on-chain escrow.
 *
 * Orders carry internal user ids; the escrow contract takes `Address`. The only
 * trustworthy mapping between them is the wallet a user proved control of
 * during SEP-10 — never a client-supplied address, which would let a caller
 * redirect custody or a payout to an account they chose.
 */
import type { WalletRef } from "@stellartrust/shared";
import { ConflictError } from "../../lib/errors.js";
import { isAccountAddress } from "../stellar/address.js";

export interface EscrowAddressResolver {
  /**
   * The Stellar account an order party signs and settles with.
   *
   * @throws ConflictError when the user has no wallet on file, or the stored
   *   value is not a usable account address. Both mean the deal cannot go
   *   on-chain, and both need a human-readable reason at the API edge rather
   *   than a host error out of simulation.
   */
  resolve(userId: string, role: string): Promise<string>;
}

/** Wallet lookup backed by the identity store. */
export class IdentityEscrowAddressResolver implements EscrowAddressResolver {
  constructor(
    private readonly identity: {
      findPrimaryWallet(userId: string): Promise<WalletRef | undefined>;
    },
  ) {}

  async resolve(userId: string, role: string): Promise<string> {
    const wallet = await this.identity.findPrimaryWallet(userId);
    if (!wallet) {
      throw new ConflictError(
        `The ${role} has no connected Stellar wallet. They must sign in with ` +
          "their wallet before this order can move on-chain.",
      );
    }
    if (!isAccountAddress(wallet.stellarPublicKey)) {
      throw new ConflictError(
        `The ${role}'s stored wallet is not a valid Stellar account address.`,
      );
    }
    return wallet.stellarPublicKey;
  }
}

/** Fixed mapping for tests and the deterministic adapter. */
export class StaticEscrowAddressResolver implements EscrowAddressResolver {
  constructor(private readonly addresses: ReadonlyMap<string, string>) {}

  async resolve(userId: string, role: string): Promise<string> {
    const address = this.addresses.get(userId);
    if (!address) {
      throw new ConflictError(`No Stellar address is mapped for the ${role}`);
    }
    return address;
  }
}
