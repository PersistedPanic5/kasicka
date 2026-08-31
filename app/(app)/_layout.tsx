import { Slot, usePathname, Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
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
  { href: '/(app)/payments', labelKey: 'nav.payments' },
  { href: '/(app)/settings', labelKey: 'nav.settings' },
] as const;

// Below this width the nav switches to a tighter layout (less padding,
// smaller gaps) — the link row itself is *always* wrapped in a horizontal
// ScrollView (below), on every width, so it never depends on this
// threshold to stay reachable; this only tidies up spacing on a phone.
const NARROW_BREAKPOINT = 720;

/**
 * The desktop/web "administration" shell — matches the top nav bar in
 * Overview.dc.html / Debts.dc.html / Transactions.dc.html / More.dc.html.
 * A custom top bar rather than native tab-bar chrome, since that's what the
 * approved mockups actually show.
 *
 * The link row is a horizontal ScrollView rather than a plain row — with 7
 * items it doesn't reliably fit even on a small desktop window, and on a
 * phone viewport it very much doesn't (this is what was reported as "only
 * see up to Debts, not scrollable"). Scrolling sideways to reach a nav item
 * is still not great on a phone, so there's also a quick-entry icon (next
 * to the theme toggle) straight back to the minimal mobile screen — the
 * reverse of that screen's own "open full app" icon.
 */
export default function AppLayout() {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const narrow = width < NARROW_BREAKPOINT;

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <View
        style={[
          styles.nav,
          { borderBottomColor: tokens.border, paddingHorizontal: narrow ? 14 : 32 },
        ]}
      >
        <View style={[styles.navLeft, { gap: narrow ? 16 : 36 }]}>
          <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 14, letterSpacing: 1 }}>
            KASIČKA
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.navLinks}
            style={styles.navLinksScroll}
          >
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
          </ScrollView>
        </View>

        <View style={styles.navRight}>
          <Link href="/(mobile)" asChild>
            <Pressable
              style={StyleSheet.flatten([
                styles.iconBtn,
                { backgroundColor: tokens.card, borderColor: tokens.border },
              ])}
              accessibilityLabel={t('common.quickEntry')}
            >
              <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={tokens.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
              </Svg>
            </Pressable>
          </Link>
          <ThemeToggle labels={{ toLight: t('common.switchToLight'), toDark: t('common.switchToDark') }} />
        </View>
      </View>

      <View style={[styles.content, { padding: narrow ? 16 : 32 }]}>
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
    height: 64,
    borderBottomWidth: 1,
  },
  navLeft: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, minWidth: 0 },
  navLinksScroll: { flexShrink: 1 },
  navLinks: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  navLink: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 9,
    fontSize: 13,
    fontFamily: fontFamily.bold,
    overflow: 'hidden',
  },
  navRight: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 0 },
  iconBtn: { width: 34, height: 34, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  content: { flex: 1, padding: 32 },
});
