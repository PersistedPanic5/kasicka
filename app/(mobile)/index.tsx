import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LogoMark } from '@/components/Logo';
import { AppFooter } from '@/components/AppFooter';
import { ExpenseEntryForm } from '@/components/ExpenseEntryForm';
import { useLanguage } from '@/lib/language-context';

/**
 * The fast mobile capture screen — matches Main.dc.html in the Design
 * canvas. Opens straight into this, no nav chrome, one job: log an expense
 * in as few taps as possible.
 */
export default function MobileFastEntry() {
  const { tokens } = useTheme();
  const { t } = useLanguage();

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]}>
      {/* maxWidth + alignSelf: 'center' here (not just around the form
          below) so the header row's icons don't end up pinned to the far
          left/right edges of a wide desktop browser window when this route
          is opened directly, rather than through the (app) shell. */}
      <View style={styles.inner}>
        <View style={styles.header}>
          {/* ?stay=1 — see the matching comment in (app)/_layout.tsx */}
          <Link href="/?stay=1" asChild>
            <Pressable style={styles.brand}>
              <LogoMark size={16} color={tokens.accent} holeColor={tokens.bg} />
              <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 12, letterSpacing: 1 }}>
                KASIČKA
              </Text>
            </Pressable>
          </Link>
          <View style={styles.headerIcons}>
            <Link href="/(app)/home" asChild>
              <Pressable
                style={StyleSheet.flatten([
                  styles.iconBtn,
                  { backgroundColor: tokens.card, borderColor: tokens.border },
                ])}
              >
                <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={tokens.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M9 3H5a2 2 0 0 0-2 2v4m18 0V5a2 2 0 0 0-2-2h-4m0 18h4a2 2 0 0 0 2-2v-4M3 15v4a2 2 0 0 0 2 2h4" />
                </Svg>
              </Pressable>
            </Link>
            <ThemeToggle size={34} labels={{ toLight: t('common.switchToLight'), toDark: t('common.switchToDark') }} />
          </View>
        </View>

        {/* A ScrollView, not a plain View — the form has no scroll
            mechanism of its own, so with several split-with-someone rows
            added (Pavel: "adding multiple row debts in record expense")
            it can grow taller than the screen with no way to reach the
            Save button below the fold. showsVerticalScrollIndicator={false}
            (Pavel: no visible scrollbar on this screen) keeps this looking
            like a plain card rather than growing a scrollbar down one side
            of it — react-native-web still scrolls fine with it hidden. */}
        <ScrollView style={styles.formScroll} showsVerticalScrollIndicator={false} contentContainerStyle={styles.formWrap}>
          <ExpenseEntryForm variant="mobile" />
        </ScrollView>

        <AppFooter tokens={tokens} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 24, paddingTop: 22, alignItems: 'center' },
  inner: { flex: 1, width: '100%', maxWidth: 480 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 30 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerIcons: { flexDirection: 'row', gap: 8 },
  iconBtn: { width: 34, height: 34, borderRadius: 11, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  // flex: 1 + minHeight: 0 on the ScrollView itself — same fix as
  // (app)/_layout.tsx's contentInner — is what lets it actually clamp to
  // the available space and scroll instead of just growing with the form.
  formScroll: { flex: 1, width: '100%', minHeight: 0 },
  formWrap: { alignItems: 'center', justifyContent: 'flex-start', paddingTop: 20, paddingBottom: 20 },
});
