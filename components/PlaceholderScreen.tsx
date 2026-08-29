import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';

/**
 * Structural stand-in for a tab whose real implementation is scheduled for
 * a later roadmap phase (build-roadmap-v1.md) — proves the route/nav/theme
 * shell works without pretending functionality exists that hasn't been
 * wired to a real backend yet. Each real screen replaces its call site,
 * porting the matching .dc.html mockup faithfully — this component is not
 * meant to be the final look of any of these tabs.
 */
export function PlaceholderScreen({ title, phaseNote }: { title: string; phaseNote: string }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.wrap}>
      <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 24, marginBottom: 10 }}>
        {title}
      </Text>
      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 14, maxWidth: 480 }}>
        {phaseNote}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'flex-start' },
});
