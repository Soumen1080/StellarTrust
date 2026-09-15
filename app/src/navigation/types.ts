/**
 * Navigation type map.
 *
 * Typed rather than string-keyed so a screen cannot be pushed with the wrong
 * params — an order id passed where a settlement id is expected is a runtime
 * 404 that the compiler can catch instead.
 */
export type RootStackParamList = {
  Tabs: undefined;

  // Escrow
  CreateOrder: undefined;
  OrderDetail: { orderId: string };

  // Settlement
  SettlementQuote: undefined;
  SettlementDetail: { settlementId: string };

  // RWA
  TokenizationDetail: { tokenizationId: string };
  Portfolio: undefined;

  // Disputes
  DisputeDetail: { disputeId: string };

  // Treasury
  Wallet: undefined;
  Deposit: undefined;
  Withdraw: undefined;

  // Identity
  Verification: undefined;
};

export type TabParamList = {
  Home: undefined;
  Escrow: undefined;
  Send: undefined;
  Invest: undefined;
  Profile: undefined;
};

export type AuthStackParamList = {
  SignIn: undefined;
  CreateWallet: undefined;
  ImportWallet: undefined;
  ConnectWallet: undefined;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
