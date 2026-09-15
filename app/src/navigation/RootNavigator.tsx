/**
 * Authenticated navigation: five tabs, with detail screens pushed over them.
 *
 * Tabs rather than a drawer because every one of these is a place a user
 * returns to constantly, and a drawer costs a tap and hides the destinations.
 * Detail screens live in the root stack so they cover the tab bar — an escrow
 * release is a focused task, not something to wander off from mid-way.
 */
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StyleSheet } from "react-native";
import { Icon, type IconName } from "../components/Icon";
import { DisputeDetailScreen } from "../features/disputes/DisputeDetailScreen";
import { CreateOrderScreen } from "../features/escrow/CreateOrderScreen";
import { EscrowListScreen } from "../features/escrow/EscrowListScreen";
import { OrderDetailScreen } from "../features/escrow/OrderDetailScreen";
import { HomeScreen } from "../features/home/HomeScreen";
import { VerificationScreen } from "../features/kyc/VerificationScreen";
import { ProfileScreen } from "../features/profile/ProfileScreen";
import { MarketplaceScreen } from "../features/rwa/MarketplaceScreen";
import { PortfolioScreen } from "../features/rwa/PortfolioScreen";
import { TokenizationDetailScreen } from "../features/rwa/TokenizationDetailScreen";
import { SettlementDetailScreen } from "../features/settlement/SettlementDetailScreen";
import { SettlementListScreen } from "../features/settlement/SettlementListScreen";
import { SettlementQuoteScreen } from "../features/settlement/SettlementQuoteScreen";
import { DepositScreen } from "../features/treasury/DepositScreen";
import { WalletScreen } from "../features/treasury/WalletScreen";
import { WithdrawScreen } from "../features/treasury/WithdrawScreen";
import { color, font, space } from "../theme";
import type { RootStackParamList, TabParamList } from "./types";

const Tab = createBottomTabNavigator<TabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

const TAB_ICON: Record<keyof TabParamList, IconName> = {
  Home: "home",
  Escrow: "escrow",
  Send: "send",
  Invest: "invest",
  Profile: "profile",
};

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        sceneStyle: { backgroundColor: color.canvasDark },
        tabBarStyle: styles.tabBar,
        tabBarActiveTintColor: color.primary,
        tabBarInactiveTintColor: color.muted,
        tabBarLabelStyle: styles.tabLabel,
        tabBarIcon: ({ color: tint, size }) => (
          <Icon name={TAB_ICON[route.name]} color={tint} size={size} />
        ),
      })}
    >
      <Tab.Screen name="Home">
        {({ navigation }) => (
          <HomeScreen
            onOpenOrder={(orderId) => navigation.navigate("OrderDetail", { orderId })}
            onOpenSettlement={(settlementId) =>
              navigation.navigate("SettlementDetail", { settlementId })
            }
            onOpenDispute={(disputeId) =>
              navigation.navigate("DisputeDetail", { disputeId })
            }
            onNavigate={(tab) => {
              if (tab === "escrow") navigation.navigate("Escrow");
              else if (tab === "settlement") navigation.navigate("Send");
              else if (tab === "rwa") navigation.navigate("Invest");
              else if (tab === "verify") navigation.navigate("Verification");
              else navigation.navigate("Wallet");
            }}
          />
        )}
      </Tab.Screen>

      <Tab.Screen name="Escrow">
        {({ navigation }) => (
          <EscrowListScreen
            onOpenOrder={(orderId) => navigation.navigate("OrderDetail", { orderId })}
            onCreate={() => navigation.navigate("CreateOrder")}
          />
        )}
      </Tab.Screen>

      <Tab.Screen name="Send" options={{ title: "Send" }}>
        {({ navigation }) => (
          <SettlementListScreen
            onOpen={(settlementId) =>
              navigation.navigate("SettlementDetail", { settlementId })
            }
            onCreate={() => navigation.navigate("SettlementQuote")}
          />
        )}
      </Tab.Screen>

      <Tab.Screen name="Invest">
        {({ navigation }) => (
          <MarketplaceScreen
            onOpen={(tokenizationId) =>
              navigation.navigate("TokenizationDetail", { tokenizationId })
            }
            onOpenPortfolio={() => navigation.navigate("Portfolio")}
          />
        )}
      </Tab.Screen>

      <Tab.Screen name="Profile">
        {({ navigation }) => (
          <ProfileScreen onVerify={() => navigation.navigate("Verification")} />
        )}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

export function RootNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        contentStyle: { backgroundColor: color.canvasDark },
        headerStyle: { backgroundColor: color.canvasDark },
        headerTintColor: color.onDark,
        headerTitleStyle: { fontFamily: font.sansSemibold, fontSize: 17 },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />

      <Stack.Screen name="CreateOrder" options={{ title: "New escrow" }}>
        {({ navigation }) => (
          <CreateOrderScreen
            onCreated={(orderId) =>
              navigation.replace("OrderDetail", { orderId })
            }
            onCancel={() => navigation.goBack()}
          />
        )}
      </Stack.Screen>

      <Stack.Screen name="OrderDetail" options={{ title: "Escrow" }}>
        {({ route, navigation }) => (
          <OrderDetailScreen
            orderId={route.params.orderId}
            onOpenDispute={() => navigation.navigate("Tabs")}
          />
        )}
      </Stack.Screen>

      <Stack.Screen name="SettlementQuote" options={{ title: "Send money" }}>
        {({ navigation }) => (
          <SettlementQuoteScreen
            onExecuted={(settlementId) =>
              navigation.replace("SettlementDetail", { settlementId })
            }
            onCancel={() => navigation.goBack()}
          />
        )}
      </Stack.Screen>

      <Stack.Screen name="SettlementDetail" options={{ title: "Transfer" }}>
        {({ route }) => (
          <SettlementDetailScreen settlementId={route.params.settlementId} />
        )}
      </Stack.Screen>

      <Stack.Screen name="TokenizationDetail" options={{ title: "Asset" }}>
        {({ route }) => (
          <TokenizationDetailScreen
            tokenizationId={route.params.tokenizationId}
          />
        )}
      </Stack.Screen>

      <Stack.Screen name="Portfolio" options={{ title: "Portfolio" }}>
        {({ navigation }) => (
          <PortfolioScreen
            onOpen={(tokenizationId) =>
              navigation.navigate("TokenizationDetail", { tokenizationId })
            }
          />
        )}
      </Stack.Screen>

      <Stack.Screen name="DisputeDetail" options={{ title: "Dispute" }}>
        {({ route }) => <DisputeDetailScreen disputeId={route.params.disputeId} />}
      </Stack.Screen>

      <Stack.Screen name="Wallet" options={{ title: "Wallet" }}>
        {({ navigation }) => (
          <WalletScreen
            onDeposit={() => navigation.navigate("Deposit")}
            onWithdraw={() => navigation.navigate("Withdraw")}
          />
        )}
      </Stack.Screen>

      <Stack.Screen name="Deposit" options={{ title: "Deposit" }}>
        {({ navigation }) => <DepositScreen onDone={() => navigation.goBack()} />}
      </Stack.Screen>

      <Stack.Screen name="Withdraw" options={{ title: "Withdraw" }}>
        {({ navigation }) => <WithdrawScreen onDone={() => navigation.goBack()} />}
      </Stack.Screen>

      <Stack.Screen name="Verification" options={{ title: "Verification" }}>
        {() => <VerificationScreen />}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: color.canvasDark,
    borderTopColor: color.hairlineDark,
    // The default hairline disappears against this canvas on some panels.
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space.xxs,
    height: 60,
  },
  tabLabel: { fontFamily: font.sansMedium, fontSize: 11 },
});
