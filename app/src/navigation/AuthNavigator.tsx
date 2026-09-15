/** Pre-authentication flow: sign in, or set a wallet up. */
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { ConnectWalletScreen } from "../features/auth/ConnectWalletScreen";
import { CreateWalletScreen } from "../features/auth/CreateWalletScreen";
import { ImportWalletScreen } from "../features/auth/ImportWalletScreen";
import { SignInScreen } from "../features/auth/SignInScreen";
import { color } from "../theme";
import type { AuthStackParamList } from "./types";

const Stack = createNativeStackNavigator<AuthStackParamList>();

export function AuthNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: color.canvasDark },
        // Sliding a wallet-setup screen back to sign-in mid-creation would
        // strand a generated key; each step exposes its own explicit Back.
        gestureEnabled: false,
        animation: "slide_from_right",
      }}
    >
      <Stack.Screen name="SignIn">
        {({ navigation }) => (
          <SignInScreen
            onNavigate={(route) => {
              if (route === "create-wallet") navigation.navigate("CreateWallet");
              else if (route === "import-wallet") navigation.navigate("ImportWallet");
              else navigation.navigate("ConnectWallet");
            }}
          />
        )}
      </Stack.Screen>

      <Stack.Screen name="CreateWallet">
        {({ navigation }) => (
          <CreateWalletScreen onCancel={() => navigation.goBack()} />
        )}
      </Stack.Screen>

      <Stack.Screen name="ImportWallet">
        {({ navigation }) => (
          <ImportWalletScreen onCancel={() => navigation.goBack()} />
        )}
      </Stack.Screen>

      <Stack.Screen name="ConnectWallet">
        {({ navigation }) => (
          <ConnectWalletScreen onCancel={() => navigation.goBack()} />
        )}
      </Stack.Screen>
    </Stack.Navigator>
  );
}
