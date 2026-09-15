/**
 * Links into a Stellar block explorer.
 *
 * Network-aware: a public-network hash opened on the testnet explorer shows
 * "not found", which reads to a user as though their transaction never
 * happened. Stellar Expert is used because it renders Soroban contract calls,
 * which is most of what this platform submits.
 */
import { appConfig } from "./config";

const NETWORK_SEGMENT = {
  testnet: "testnet",
  public: "public",
} as const;

export function transactionUrl(hash: string): string {
  return `https://stellar.expert/explorer/${NETWORK_SEGMENT[appConfig.stellarNetwork]}/tx/${hash}`;
}

export function accountUrl(address: string): string {
  return `https://stellar.expert/explorer/${NETWORK_SEGMENT[appConfig.stellarNetwork]}/account/${address}`;
}

export function contractUrl(contractId: string): string {
  return `https://stellar.expert/explorer/${NETWORK_SEGMENT[appConfig.stellarNetwork]}/contract/${contractId}`;
}
