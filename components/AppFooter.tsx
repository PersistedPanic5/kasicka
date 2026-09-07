import { useMemo } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { LogoMark } from '@/components/Logo';

// Real link from the Buy Me a Coffee widget Pavel provided (data-slug on the
// button script in app/+html.tsx) — single source of truth, used here and
// by the landing page's own Support section.
export const BUY_ME_A_COFFEE_URL = 'https://buymeacoffee.com/pavelskuhrovec';

type Tokens = ReturnType<typeof useTheme>['tokens'];

/**
 * Slim, single-line footer reused on every real app screen (via
 * (app)/_layout.tsx and (mobile)/index.tsx) and on the marketing landing
 * page — Pavel: "some kind of footer should be on every page... ideally
 * with the buy me a coffee link". The floating Buy-Me-a-Coffee widget
 * script in app/+html.tsx already covers "everywhere" for that link on
 * web; this is the lightweight always-visible text version alongside it.
 */
export function AppFooter({ tokens }: { tokens: Tokens }) {
  const year = useMemo(() => new Date().getFullYear(), []);
  return (
    <View style={[styles.row, { borderTopColor: tokens.border }]}>
      <View style={styles.brand}>
        <LogoMark size={12} color={tokens.textMuted} holeColor={tokens.bg} />
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 11.5 }}>Kasička</Text>
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5 }}>© {year}</Text>
      </View>
      <Pressable onPress={() => Linking.openURL(BUY_ME_A_COFFEE_URL)}>
        <Text style={{ color: tokens.accent, fontFamily: fontFamily.bold, fontSize: 11.5 }}>☕ Buy me a coffee</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
