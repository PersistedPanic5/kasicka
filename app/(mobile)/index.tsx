import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { ThemeToggle } from '@/components/ThemeToggle';
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
      <View style={styles.header}>
        <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 12, letterSpacing: 1 }}>
          KASIČKA
        </Text>
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

      <View style={styles.formWrap}>
        <ExpenseEntryForm variant="mobile" />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 24, paddingTop: 22 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 30 },
  headerIcons: { flexDirection: 'row', gap: 8 },
  iconBtn: { width: 34, height: 34, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  formWrap: { flex: 1, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 20 },
});
