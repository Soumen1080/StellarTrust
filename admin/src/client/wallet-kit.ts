/**
 * The Connect Wallet modal, bundled for this console.
 *
 * Bundled and self-hosted rather than loaded from a CDN: the console's CSP is
 * `default-src 'self'` with no external origins, which is deliberate — an
 * admin page that can approve KYC should not execute code fetched from a third
 * party at sign-in time. `npm run build:client` produces the single file this
 * compiles to.
 *
 * Uses the same kit and the same `authModal()` entry point as the main site,
 * so the operator sees the wallet picker they already know.
 *
 * Exposes a small surface on `window` rather than letting the login page
 * import a module: that page is a template string with an inline script and
 * has no module graph of its own.
 */
import { Networks, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";

interface AdminWalletApi {
  /** Opens the wallet picker, then signs the challenge with what was chosen. */
  connectAndSign(
    transactionXdr: string,
    networkPassphrase: string,
  ): Promise<{ signedTransactionXdr: string; address: string }>;
}

declare global {
  interface Window {
    adminWallet: AdminWalletApi;
  }
}

let initialized = false;

function ensureInit(networkPassphrase: string): void {
  if (initialized) return;
  StellarWalletsKit.init({
    modules: defaultModules(),
    // Matched to the challenge's network, so the wallet signs against the same
    // passphrase the server verifies with.
    network:
      networkPassphrase === Networks.PUBLIC ? Networks.PUBLIC : Networks.TESTNET,
    authModal: { showInstallLabel: true, hideUnsupportedWallets: false },
  });
  initialized = true;
}

window.adminWallet = {
  async connectAndSign(transactionXdr, networkPassphrase) {
    ensureInit(networkPassphrase);
    const { address } = await StellarWalletsKit.authModal();
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(
      transactionXdr,
      { address, networkPassphrase },
    );
    return { signedTransactionXdr: signedTxXdr, address };
  },
};
