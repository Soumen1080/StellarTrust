/**
 * Top-level error boundary.
 *
 * A render error anywhere below this unmounts the tree, and React Native's
 * default for that in a production build is a blank white screen with no way
 * forward. In a financial app that is indistinguishable from having lost
 * someone's money. This catches it and offers a way back.
 *
 * Deliberately a class: `componentDidCatch` has no hook equivalent.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, radius, space } from "../theme";
import { Button } from "./Button";
import { Text } from "./Text";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Only the shape of the failure — a component stack can carry user data
    // from props, and this is the one place tempted to log everything.
    console.error("Unhandled render error", {
      name: error.name,
      message: error.message,
      componentStack: info.componentStack?.split("\n").slice(0, 5).join("\n"),
    });
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.root}>
        <View style={styles.badge}>
          <Text variant="titleLg" tone={color.statusRejected}>
            !
          </Text>
        </View>
        <Text variant="titleLg" tone={color.onDark} center>
          Something went wrong
        </Text>
        <Text variant="bodyMd" tone={color.muted} center style={styles.blurb}>
          The app hit an unexpected error. Your funds and your wallet key are
          unaffected — nothing here changes what is on the ledger or the chain.
        </Text>
        <Button
          label="Try again"
          onPress={this.reset}
          fullWidth={false}
          style={styles.action}
        />
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    padding: space.lg,
    backgroundColor: color.canvasDark,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${color.statusRejected}1a`,
  },
  blurb: { maxWidth: 320 },
  action: { marginTop: space.sm },
});
