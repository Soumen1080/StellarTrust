/**
 * User id → Stellar address resolution.
 *
 * Domain records carry internal user ids; Soroban contracts take `Address`.
 * The only trustworthy mapping between them is the wallet a user proved control
 * of during SEP-10 — never a client-supplied address, which would let a caller
 * redirect custody or a payout to an account they chose.
 *
 * Lives in `identity` because that is what it resolves; escrow and RWA both
 * depend on it.
 */
import type { WalletRef } from "@stellartrust/shared";
import { ConflictError } from "../../lib/errors.js";
import { isAccountAddress } from "../stellar/address.js";

export interface WalletAddressResolver {
  /**
   * The Stellar account a user signs and settles with.
   *
   * @param role - how to name this user in an error the caller will see
   *   ("buyer", "seller", "issuer"). A missing wallet is a real, actionable
   *   state, not a bug: it means the person has not connected one yet.
   * @throws ConflictError when the user has no wallet on file, or the stored
   *   value is not a usable account address.
   */
  resolve(userId: string, role: string): Promise<string>;
}

/** Wallet lookup backed by the identity store. */
export class IdentityWalletAddressResolver implements WalletAddressResolver {
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
          "their wallet before this can move on-chain.",
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

/** Fixed mapping for tests and deterministic adapters. */
export class StaticWalletAddressResolver implements WalletAddressResolver {
  constructor(private readonly addresses: ReadonlyMap<string, string>) {}

  async resolve(userId: string, role: string): Promise<string> {
    const address = this.addresses.get(userId);
    if (!address) {
      throw new ConflictError(`No Stellar address is mapped for the ${role}`);
    }
    return address;
  }
}
