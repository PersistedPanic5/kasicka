import { Slot, usePathname, Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useLanguage } from '@/lib/language-context';

const NAV_ITEMS = [
  { href: '/(app)/home', labelKey: 'nav.home' },
  { href: '/(app)/overview', labelKey: 'nav.overview' },
  { href: '/(app)/debts', labelKey: 'nav.debts' },
  { href: '/(app)/transactions', labelKey: 'nav.transactions' },
  { href: '/(app)/planning', labelKey: 'nav.planning' },
  { href: '/(app)/settings', labelKey: 'nav.settings' },
] as const;

/**
 * The desktop/web "administration" shell — matches the top nav bar in
 * Overview.dc.html / Debts.dc.html / Transactions.dc.html / More.dc.html.
 * A custom top bar rather than native tab-bar chrome, since that's what the
 * approved mockups actually show.
 */
export default function AppLayout() {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  const pathname = usePathname();

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <View style={[styles.nav, { borderBottomColor: tokens.border }]}>
        <View style={styles.navLeft}>
          <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 14, letterSpacing: 1 }}>
            KASIČKA
          </Text>
          <View style={styles.navLinks}>
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.href;
              return (
                <Link key={item.href} href={item.href} asChild>
                  <Text
                    style={StyleSheet.flatten([
                      styles.navLink,
                      {
                        backgroundColor: active ? tokens.accent : 'transparent',
                        color: active ? tokens.accentText : tokens.textMuted,
                      },
                    ])}
                  >
                    {t(item.labelKey)}
                  </Text>
                </Link>
              );
            })}
          </View>
        </View>
        <ThemeToggle labels={{ toLight: t('common.switchToLight'), toDark: t('common.switchToDark') }} />
      </View>

      <View style={styles.content}>
        <Slot />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 32,
    height: 64,
    borderBottomWidth: 1,
  },
  navLeft: { flexDirection: 'row', alignItems: 'center', gap: 36 },
  navLinks: { flexDirection: 'row', gap: 6 },
  navLink: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 9,
    fontSize: 13,
    fontFamily: fontFamily.bold,
    overflow: 'hidden',
  },
  content: { flex: 1, padding: 32 },
});
