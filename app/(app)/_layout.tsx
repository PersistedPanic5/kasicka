import { useEffect, useState } from 'react';
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

// Below this width the nav switches from the desktop horizontal link row to
// a hamburger + dropdown menu. A horizontal-scrolling link row was the
// first fix here, but scrolling sideways to reach a nav item on a phone
// reads as unpolished rather than "modern app" — a collapsible menu is the
// pattern this is actually going for.
const NARROW_BREAKPOINT = 720;

/**
 * The desktop/web "administration" shell — matches the top nav bar in
 * Overview.dc.html / Debts.dc.html / Transactions.dc.html / More.dc.html.
 * A custom top bar rather than native tab-bar chrome, since that's what the
 * approved mockups actually show.
 *
 * Two different nav presentations depending on viewport width: at desktop
 * width the 7 items are a plain horizontal row (all 7 comfortably fit); on
 * a narrow/phone viewport they collapse behind a hamburger button that
 * opens a dropdown panel of full-width rows — closes itself on navigation
 * (the pathname effect below) or on tapping the backdrop. There's also a
 * quick-entry icon (next to the theme toggle, both widths) straight back
 * to the minimal mobile screen — the reverse of that screen's own "open
 * full app" icon.
 */
export default function AppLayout() {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const narrow = width < NARROW_BREAKPOINT;

  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!narrow) setMenuOpen(false);
  }, [narrow]);

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <View
        style={[
          styles.nav,
          { borderBottomColor: tokens.border, paddingHorizontal: narrow ? 14 : 32 },
        ]}
      >
        <View style={[styles.navLeft, { gap: narrow ? 12 : 36 }]}>
          {narrow && (
            <Pressable
              onPress={() => setMenuOpen((v) => !v)}
              style={StyleSheet.flatten([
                styles.iconBtn,
                { backgroundColor: menuOpen ? tokens.accent : tokens.card, borderColor: tokens.border },
              ])}
              accessibilityLabel={t('common.menu')}
            >
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={menuOpen ? tokens.accentText : tokens.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <Path d={menuOpen ? 'M18 6 6 18M6 6l12 12' : 'M3 6h18M3 12h18M3 18h18'} />
              </Svg>
            </Pressable>
          )}

          <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 14, letterSpacing: 1 }}>
            KASIČKA
          </Text>

          {!narrow && (
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
          )}
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

      {narrow && menuOpen && (
        <>
          <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)} />
          <View style={[styles.menuPanel, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.href;
              return (
                <Link key={item.href} href={item.href} asChild>
                  <Pressable
                    style={StyleSheet.flatten([
                      styles.menuItem,
                      { backgroundColor: active ? tokens.accent : 'transparent' },
                    ])}
                  >
                    <Text
                      style={{
                        color: active ? tokens.accentText : tokens.text,
                        fontFamily: active ? fontFamily.bold : fontFamily.semibold,
                        fontSize: 14.5,
                      }}
                    >
                      {t(item.labelKey)}
                    </Text>
                  </Pressable>
                </Link>
              );
            })}
          </View>
        </>
      )}

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
  menuBackdrop: {
    position: 'absolute',
    top: 64,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
    zIndex: 20,
  },
  menuPanel: {
    position: 'absolute',
    top: 64,
    left: 0,
    minWidth: 220,
    maxWidth: '82%',
    borderWidth: 1,
    borderTopWidth: 0,
    borderBottomRightRadius: 16,
    paddingVertical: 8,
    zIndex: 21,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
  },
  menuItem: { paddingHorizontal: 20, paddingVertical: 14, borderRadius: 10, marginHorizontal: 6 },
  content: { flex: 1, padding: 32 },
});
