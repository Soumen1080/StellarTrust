/**
 * Prompt to verify identity.
 *
 * Every money surface is gated on verification, so an unverified user who
 * taps into escrow or settlement would otherwise hit a wall with no
 * explanation. Saying it once, up front, is kinder than four refusals.
 */
import { StyleSheet, View } from "react-native";
import { Card } from "../../components/Card";
import { Text } from "../../components/Text";
import { color, radius, space } from "../../theme";

export function VerificationBanner({ onPress }: { onPress: () => void }) {
  return (
    <Card
      onPress={onPress}
      accessibilityLabel="Verify your identity to unlock payments"
      style={styles.card}
    >
      <View style={styles.row}>
        <View style={styles.badge}>
          <Text variant="titleSm" tone={color.statusReview}>
            !
          </Text>
        </View>
        <View style={styles.body}>
          <Text variant="titleSm" tone={color.onDark}>
            Verify your identity
          </Text>
          <Text variant="bodySm" tone={color.muted}>
            Takes a few minutes. Needed before you can move money.
          </Text>
        </View>
        <Text variant="titleMd" tone={color.muted}>
          ›
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: space.md,
    borderColor: `${color.statusReview}4d`,
    backgroundColor: `${color.statusReview}14`,
  },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  badge: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${color.statusReview}26`,
  },
  body: { flex: 1, gap: 2 },
});
