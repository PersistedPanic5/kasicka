import { useEffect, useState, type ReactElement } from 'react';
import { Slot, usePathname, Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LogoMark } from '@/components/Logo';
import { useLanguage } from '@/lib/language-context';

const NAV_ITEMS = [
  { href: '/(app)/home', labelKey: 'nav.home' },
  { href: '/(app)/payments', labelKey: 'nav.payments' },
  { href: '/(app)/debts', labelKey: 'nav.debts' },
  { href: '/(app)/transactions', labelKey: 'nav.transactions' },
  { href: '/(app)/overview', labelKey: 'nav.overview' },
  { href: '/(app)/planning', labelKey: 'nav.planning' },
  { href: '/(app)/settings', labelKey: 'nav.settings' },
] as const;

/** Widest content is allowed to get under the nav — keeps every screen
 * readable and centered on a wide desktop window instead of stretching
 * edge-to-edge (Pavel: the entry form "loaded on computer screen on top
 * left side" on a wide screen — the real bug was no width cap at all, so
 * flex-start-aligned content just sat at its natural size in the corner). */
const CONTENT_MAX_WIDTH = 1040;

/** Small stroke icons for the nav, one per NAV_ITEMS href — design-refresh
 * addition (2026-09) so the nav reads at a glance instead of as a plain
 * text pill row. Same 24x24 viewBox / 1.9 stroke / round-cap vocabulary as
 * the icons already used elsewhere in this file and in transactions.tsx. */
const NAV_ICONS: Record<string, (color: string) => ReactElement> = {
  '/(app)/home': (color) => (
    <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M4 11.5 12 4l8 7.5" />
      <Path d="M6 10v9a1 1 0 0 0 1 1h4v-6h2v6h4a1 1 0 0 0 1-1v-9" />
    </Svg>
  ),
  '/(app)/payments': (color) => (
    <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 6h18v12H3z" />
      <Path d="M12 9.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z" />
      <Path d="M3 10h1.6M19.4 14H21" />
    </Svg>
  ),
  '/(app)/debts': (color) => (
    <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
      <Path d="M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
      <Path d="M21 21v-2a4 4 0 0 0-3-3.87" />
      <Path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  ),
  '/(app)/transactions': (color) => (
    <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M8 6h13M8 12h13M8 18h13" />
      <Circle cx="3.4" cy="6" r="1.1" fill={color} stroke="none" />
      <Circle cx="3.4" cy="12" r="1.1" fill={color} stroke="none" />
      <Circle cx="3.4" cy="18" r="1.1" fill={color} stroke="none" />
    </Svg>
  ),
  '/(app)/overview': (color) => (
    <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round">
      <Path d="M4 20V10M12 20V4M20 20v-7" />
    </Svg>
  ),
  '/(app)/planning': (color) => (
    <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
      <Path d="M3 10h18M8 3v4M16 3v4" />
    </Svg>
  ),
  '/(app)/settings': (color) => (
    <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round">
      <Path d="M4 6h9M17 6h3" />
      <Circle cx="13" cy="6" r="2" fill={color} stroke="none" />
      <Path d="M4 12h3M11 12h9" />
      <Circle cx="7" cy="12" r="2" fill={color} stroke="none" />
      <Path d="M4 18h11M19 18h1" />
      <Circle cx="15" cy="18" r="2" fill={color} stroke="none" />
    </Svg>
  ),
};

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

          <View style={styles.brand}>
            <LogoMark size={18} color={tokens.accent} holeColor={tokens.bg} />
            <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 14, letterSpacing: 1 }}>
              KASIČKA
            </Text>
          </View>

          {!narrow && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.navLinks}
              style={styles.navLinksScroll}
            >
              {NAV_ITEMS.map((item) => {
                const active = pathname === item.href;
                const color = active ? tokens.accentText : tokens.textMuted;
                return (
                  <Link key={item.href} href={item.href} asChild>
                    <Pressable
                      style={StyleSheet.flatten([
                        styles.navLink,
                        { backgroundColor: active ? tokens.accent : 'transparent' },
                      ])}
                    >
                      {NAV_ICONS[item.href]?.(color)}
                      <Text style={{ color, fontFamily: fontFamily.bold, fontSize: 13 }}>{t(item.labelKey)}</Text>
                    </Pressable>
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
              const color = active ? tokens.accentText : tokens.text;
              return (
                <Link key={item.href} href={item.href} asChild>
                  <Pressable
                    style={StyleSheet.flatten([
                      styles.menuItem,
                      { backgroundColor: active ? tokens.accent : 'transparent' },
                    ])}
                  >
                    {NAV_ICONS[item.href]?.(color)}
                    <Text
                      style={{
                        color,
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
        <View style={styles.contentInner}>
          <Slot />
        </View>
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
  brand: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  navLinksScroll: { flexShrink: 1 },
  navLinks: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  navLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 10,
    overflow: 'hidden',
  },
  navRight: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 0 },
  iconBtn: { width: 34, height: 34, borderRadius: 11, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
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
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 10,
    marginHorizontal: 6,
  },
  // alignItems: 'center' + a maxWidth on the inner wrapper is the centering
  // fix — every screen under (app)/ used to stretch to (or sit pinned to
  // the left of) the full remaining viewport width with no cap at all.
  content: { flex: 1, alignItems: 'center' },
  contentInner: { width: '100%', maxWidth: CONTENT_MAX_WIDTH },
});
