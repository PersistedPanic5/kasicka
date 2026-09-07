import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Link, Redirect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useAuth } from '@/lib/auth-context';
import { LogoMark } from '@/components/Logo';
import { categoryColor, identityColorFor, withAlpha } from '@/lib/identity';

/**
 * The public marketing home page — kasicka.eu itself. Previously `/` did
 * nothing but redirect (desktop vs. mobile) straight into the signed-in
 * app, and AuthGate bounced anyone without a session to the bare /sign-in
 * screen before they'd seen a single word about what Kasička is (Pavel:
 * "I need ... a main page for the tool that will describe it"). This is
 * that page. AuthGate (see components/AuthGate.tsx) now leaves `/` alone
 * for a signed-out visitor; a signed-in one is sent straight past this
 * pitch and into the app below, via the same device check /sign-in's
 * post-login redirect used to do implicitly through the old index.tsx.
 *
 * Deliberately built from the app's OWN real tokens/typeface/mark (see
 * lib/theme.ts, components/Logo.tsx) rather than a separate "marketing"
 * palette — the point is that this page reads as a preview of the actual
 * product, not a different-looking shell wrapped around it. The hero
 * treatment below (a big tabular-nums amount with the piggy watermark
 * behind it) is literally the same visual device as the real entry
 * screen's amount field (components/ExpenseEntryForm.tsx) — the most
 * characteristic thing in this app's world, not a stock illustration.
 *
 * Everything here is static/illustrative, not the real ExpenseEntryForm /
 * Overview / Debts components — those call useAppData(), which queries a
 * signed-in user's own Supabase rows and would simply error out for a
 * signed-out visitor. The preview panels below are small, honest
 * reproductions built from the same tokens, not live screenshots.
 */
const DESKTOP_BREAKPOINT = 900; // matches (app)/_layout.tsx's own nav breakpoint

// Pavel: "link to buymea coffee (i will provide that)" — swap this for the
// real URL once he sends it; everything downstream (the button below)
// already points at whatever's here.
const BUY_ME_A_COFFEE_URL = 'https://buymeacoffee.com/REPLACE_ME';

/**
 * This is the one route whose content is baked at static-export build
 * time (real markup, not a loading spinner — see the comment on the
 * return below), and `useWindowDimensions()` reports the REAL width
 * immediately on the client — which sounds fine, but isn't: it means the
 * very first client render already disagrees with the narrow layout the
 * static export baked, and reproducibly (confirmed with the dev/no-SSR
 * server as a control, where the identical layout code updates
 * correctly) that first-frame hydration mismatch leaves this subtree
 * unable to ever repaint on its own — `wide` genuinely flips to `true` in
 * React state (logged), yet the DOM keeps the server's narrow inline
 * styles no matter what re-renders afterward, including a `key`-forced
 * remount. The fix is to never let that mismatch happen: render narrow
 * (matching the static export) through the very first commit, and only
 * switch to the real width in an effect — i.e. strictly after hydration
 * has already succeeded once, so the switch is an ordinary post-mount
 * update rather than a hydration correction.
 */
function useHydratedWidth(): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const update = () => setWidth(window.innerWidth);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return width;
}

export default function Landing() {
  const { tokens } = useTheme();
  const { session, loading } = useAuth();
  const clientWidth = useHydratedWidth();
  const width = clientWidth ?? 0; // null (pre-mount) reads as narrow, matching the static export exactly
  const isDesktop = width >= DESKTOP_BREAKPOINT;
  const wide = width >= 720;

  // The marketing content below always renders — including at Expo
  // Router's static-export build time, when `loading` is unconditionally
  // true and no session exists yet, so this page has real crawlable text
  // rather than an empty shell that only fills in after client JS runs
  // (confirmed by inspecting a build: returning null here at the top
  // instead produced a genuinely blank dist/index.html). A visitor who
  // turns out to already be signed in gets redirected on top of it, once
  // the client has actually checked — the same device split /sign-in's
  // post-login redirect used to do via the old index.tsx.
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: tokens.bg }]} edges={['top', 'bottom']}>
      {!loading && session && <Redirect href={isDesktop ? '/(app)/home' : '/(mobile)'} />}
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.page}>
          <Header tokens={tokens} />
          <Hero tokens={tokens} wide={wide} />
          <PreviewSection tokens={tokens} wide={wide} />
          <FeaturesSection tokens={tokens} wide={wide} />
          <AboutSupportSection tokens={tokens} wide={wide} />
          <LegalSection tokens={tokens} />
          <Footer tokens={tokens} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

type Tokens = ReturnType<typeof useTheme>['tokens'];

function Header({ tokens }: { tokens: Tokens }) {
  return (
    <View style={styles.header}>
      <View style={styles.brand}>
        <LogoMark size={18} color={tokens.accent} holeColor={tokens.bg} />
        <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 13, letterSpacing: 1 }}>
          KASIČKA
        </Text>
      </View>
      {/* StyleSheet.flatten, not a raw style array — expo-router's `asChild`
          clones this Pressable to attach its own press handling, and an
          unflattened array style here crashes at runtime on web ("Failed
          to set an indexed property... CSSStyleDeclaration"), confirmed by
          bisection. (mobile)/index.tsx hit the same thing and already
          works around it the same way. */}
      <Link href="/sign-in" asChild>
        <Pressable style={StyleSheet.flatten([styles.headerSignIn, { borderColor: tokens.border }])}>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13 }}>Sign in</Text>
        </Pressable>
      </Link>
    </View>
  );
}

function Hero({ tokens, wide }: { tokens: Tokens; wide: boolean }) {
  return (
    <View style={styles.hero}>
      <Text
        role="heading"
        aria-level={1}
        style={[
          styles.heroTitle,
          { color: tokens.text, fontSize: wide ? 52 : 34, lineHeight: wide ? 58 : 40 },
        ]}
      >
        Track spending. Split debts. Stay on budget.
      </Text>
      <Text style={[styles.heroSubtitle, { color: tokens.textMuted, fontSize: wide ? 17 : 15 }]}>
        Kasička is a small personal-finance tool for logging expenses, planning a monthly budget, and
        settling who-owes-who with friends — with a real Czech QR payment code, not another spreadsheet.
      </Text>

      {/* The hero graphic: the same big-number-behind-a-watermark motif as
          the real entry screen, at a larger size — an honest demo figure,
          not a claim about anyone's real balance. */}
      <View style={styles.heroAmountWrap}>
        <View style={styles.heroWatermark} pointerEvents="none">
          <LogoMark size={230} color={tokens.text} holeColor={tokens.text} />
        </View>
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, marginBottom: 4 }}>
          Amount
        </Text>
        <Text
          style={{
            color: tokens.text,
            fontFamily: fontFamily.regular,
            fontSize: wide ? 64 : 48,
            fontVariant: ['tabular-nums'],
          }}
        >
          1 284
          <Text
            style={{
              fontSize: wide ? 22 : 18,
              color: tokens.textMuted,
              fontFamily: fontFamily.semibold,
              backgroundColor: tokens.card,
              borderRadius: 8,
            }}
          >
            {'  '}CZK{'  '}
          </Text>
        </Text>
      </View>

      <Link href="/sign-in" asChild>
        <Pressable style={StyleSheet.flatten([styles.heroCta, { backgroundColor: tokens.accent }])}>
          <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 16 }}>
            Continue with Google
          </Text>
        </Pressable>
      </Link>
      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 10 }}>
        Free to use — no credit card, ever.
      </Text>
    </View>
  );
}

function SectionLabel({ tokens, children }: { tokens: Tokens; children: string }) {
  return (
    <Text style={{ color: tokens.accent, fontFamily: fontFamily.bold, fontSize: 13, marginBottom: 10 }}>
      {children}
    </Text>
  );
}

function PreviewSection({ tokens, wide }: { tokens: Tokens; wide: boolean }) {
  const rows: { title: string; body: string; panel: ReactElement }[] = [
    {
      title: 'Log an expense in two taps',
      body: 'Type an amount, pick a category, and save. Quick-amount buttons and a ± day shifter cover the rest of what usually slows this down.',
      panel: <EntryPreviewPanel tokens={tokens} />,
    },
    {
      title: 'See the month at a glance',
      body: 'Income, spending, and net for the month, plus a budget-vs-actual bar per category — no exporting anything to a spreadsheet first.',
      panel: <OverviewPreviewPanel tokens={tokens} />,
    },
    {
      title: 'Split it, without the group chat math',
      body: "Flag part of any expense as owed by someone else. They get a real payment QR code and can mark it paid — no account, no app install.",
      panel: <DebtsPreviewPanel tokens={tokens} />,
    },
  ];

  return (
    <View style={styles.section}>
      {rows.map((row, i) => (
        // key includes `wide`: confirmed by direct DOM inspection that
        // react-native-web sometimes never repaints this row's inline
        // style in place even after `wide` state demonstrably changes
        // (logged, correct) — the row keeps the layout it first mounted
        // with. Forcing a remount on the `wide` flip (rather than an
        // in-place update) is what actually gets the new layout on
        // screen; verified with Playwright at 390/1440px.
        <View
          key={`${row.title}-${wide}`}
          style={{
            flexDirection: !wide ? 'column' : i % 2 === 1 ? 'row-reverse' : 'row',
            alignItems: wide ? 'center' : 'stretch',
            gap: wide ? 48 : 18,
            marginBottom: wide ? 56 : 32,
          }}
        >
          <View style={{ flex: wide ? 1 : undefined }}>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: wide ? 24 : 20, marginBottom: 8 }}>
              {row.title}
            </Text>
            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 14.5, lineHeight: 21 }}>
              {row.body}
            </Text>
          </View>
          <View style={{ flex: wide ? 1 : undefined, alignItems: 'center' }}>{row.panel}</View>
        </View>
      ))}
    </View>
  );
}

// Small, honest reproductions of the real screens — built from the same
// tokens/helpers as the actual app (lib/identity.ts, lib/theme.ts), not
// live screenshots (the real components need a signed-in user's data).

function EntryPreviewPanel({ tokens }: { tokens: Tokens }) {
  const cats = ['Food', 'Fun', 'Transport', 'Rent', 'Insurance', 'Other'];
  return (
    <View style={[styles.panel, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
      <View style={[styles.previewTypeToggle, { backgroundColor: tokens.cardAlt }]}>
        <View style={[styles.previewTypeToggleBtn, { backgroundColor: tokens.accent }]}>
          <Text style={{ color: tokens.accentText, fontFamily: fontFamily.semibold, fontSize: 11 }}>Expense</Text>
        </View>
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 11, paddingHorizontal: 10 }}>
          Income
        </Text>
      </View>
      <View style={{ alignItems: 'center', marginVertical: 14 }}>
        <View style={styles.previewMiniWatermark} pointerEvents="none">
          <LogoMark size={64} color={tokens.text} holeColor={tokens.text} />
        </View>
        <Text style={{ color: tokens.text, fontFamily: fontFamily.regular, fontSize: 30, fontVariant: ['tabular-nums'] }}>
          320
        </Text>
      </View>
      <View style={styles.previewCategoryGrid}>
        {cats.map((name, i) => (
          <View
            key={name}
            style={[styles.previewCategoryChip, { backgroundColor: i === 0 ? tokens.accent : tokens.cardAlt }]}
          >
            {i !== 0 && <View style={[styles.previewDot, { backgroundColor: categoryColor(i, tokens) }]} />}
            <Text
              numberOfLines={1}
              style={{ color: i === 0 ? tokens.accentText : tokens.text, fontFamily: fontFamily.semibold, fontSize: 10.5 }}
            >
              {name}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function OverviewPreviewPanel({ tokens }: { tokens: Tokens }) {
  const rows = [
    { name: 'Food', spent: 4200, budget: 6000, over: false },
    { name: 'Fun', spent: 2300, budget: 2000, over: true },
    { name: 'Transport', spent: 900, budget: 1500, over: false },
  ];
  return (
    <View style={[styles.panel, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
        <View style={[styles.previewStat, { backgroundColor: tokens.cardAlt }]}>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 10 }}>Income</Text>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 14, fontVariant: ['tabular-nums'] }}>
            48 000
          </Text>
        </View>
        <View style={[styles.previewStat, { backgroundColor: tokens.cardAlt, borderColor: tokens.accentBorder, borderWidth: 1 }]}>
          <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 10 }}>Net</Text>
          <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 14, fontVariant: ['tabular-nums'] }}>
            26 900
          </Text>
        </View>
      </View>
      {rows.map((r, i) => (
        <View key={r.name} style={[styles.previewBudgetRow, { backgroundColor: tokens.cardAlt }]}>
          <View style={[styles.previewSwatch, { backgroundColor: categoryColor(i, tokens) }]} />
          <Text numberOfLines={1} style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 11, width: 56 }}>
            {r.name}
          </Text>
          <View style={[styles.previewBarTrack, { backgroundColor: tokens.card }]}>
            <View
              style={[
                styles.previewBarFill,
                {
                  width: `${Math.min((r.spent / r.budget) * 100, 100)}%`,
                  backgroundColor: r.over ? tokens.coral : tokens.accent,
                },
              ]}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

function DebtsPreviewPanel({ tokens }: { tokens: Tokens }) {
  const name = 'Kačka';
  const identity = identityColorFor(name, tokens);
  return (
    <View style={[styles.panel, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
      <View style={[styles.previewDebtCard, { backgroundColor: tokens.cardAlt }]}>
        <View style={[styles.previewAvatar, { backgroundColor: withAlpha(identity, 0.16) }]}>
          <Text style={{ color: identity, fontFamily: fontFamily.extrabold, fontSize: 13 }}>K</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 13 }}>{name}</Text>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11, marginTop: 1 }}>
            Movie tickets
          </Text>
        </View>
        <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 13, fontVariant: ['tabular-nums'] }}>
          400 CZK
        </Text>
      </View>
      <View style={[styles.previewShareRow, { borderColor: tokens.accentBorder, backgroundColor: tokens.cardAlt }]}>
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 10 }}>
          Shareable link — no login needed
        </Text>
        <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 11.5 }}>kasicka.eu/d/xk29fa</Text>
      </View>
    </View>
  );
}

function FeaturesSection({ tokens, wide }: { tokens: Tokens; wide: boolean }) {
  const features = [
    { title: 'Fast entry', body: 'Quick-amount buttons and category chips — most expenses are one tap plus a number.' },
    { title: 'Monthly budgets', body: 'Budget-vs-actual by category, so you know where the month stands before it ends.' },
    { title: 'Recurring & long-term', body: 'Bills that repeat and savings goals that build up over time, tracked automatically.' },
    { title: 'Split with friends', body: 'A real Czech QR payment code per debt, and a link that works for anyone, no account needed.' },
    { title: 'Works like an app', body: 'Add it to your home screen and use it like a native app — no app store, no install.' },
    { title: 'Yours, privately', body: 'Signed in with Google, your data is tied to your account alone — nothing shared, nothing sold.' },
  ];
  return (
    <View style={styles.section}>
      <SectionLabel tokens={tokens}>What it does</SectionLabel>
      {/* key={wide} forces a remount on the narrow/wide flip — see the
          comment in PreviewSection for why an in-place style update alone
          doesn't repaint reliably here. */}
      <View key={String(wide)} style={{ flexDirection: wide ? 'row' : 'column', flexWrap: wide ? 'wrap' : 'nowrap', gap: 22 }}>
        {features.map((f, i) => (
          <View
            key={f.title}
            style={{ flexDirection: 'row', gap: 12, flexBasis: wide ? '47%' : undefined, flexGrow: 0 }}
          >
            <View style={[styles.featureDot, { backgroundColor: categoryColor(i, tokens) }]} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 15, marginBottom: 3 }}>
                {f.title}
              </Text>
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13.5, lineHeight: 19 }}>
                {f.body}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function AboutSupportSection({ tokens, wide }: { tokens: Tokens; wide: boolean }) {
  return (
    <View style={styles.section}>
      <View key={String(wide)} style={{ flexDirection: wide ? 'row' : 'column', gap: wide ? 56 : 32 }}>
        <View style={{ flex: 1 }}>
          <SectionLabel tokens={tokens}>About</SectionLabel>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.medium, fontSize: 14.5, lineHeight: 22 }}>
            Kasička (Czech for "piggy bank") started as a way to track my own spending and the money
            friends and I owe each other. It's built and maintained by one person — me, Pavel — in my
            spare time.
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <SectionLabel tokens={tokens}>Support</SectionLabel>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.medium, fontSize: 14.5, lineHeight: 22, marginBottom: 14 }}>
            If Kasička is useful to you, you're welcome to help keep it running.
          </Text>
          <Pressable
            onPress={() => Linking.openURL(BUY_ME_A_COFFEE_URL)}
            style={[styles.coffeeBtn, { backgroundColor: tokens.cardAlt, borderColor: tokens.border }]}
          >
            <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 14 }}>Buy me a coffee</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function LegalSection({ tokens }: { tokens: Tokens }) {
  const paragraphs = [
    'Kasička is provided as-is, free of charge, with no warranty of any kind. I can’t guarantee it will always be available, error-free, or fit for any particular purpose, and I’m not liable for any loss, damage, or missed payment arising from its use — including anything to do with the amounts, budgets, or debts you track here. This isn’t legal advice; if you need something more formal, talk to a professional.',
    'Your data is stored in a private Supabase project and tied to your own Google-signed-in account — I don’t sell it, share it, or look at it beyond what’s needed to keep the app running and fix bugs. A public debt-share link reveals only what you choose to share (an amount, a note, a payment QR code) — never your account.',
    'This runs on free hosting and database tiers. If that ever needs to change, I’ll say so clearly here rather than let it be a surprise.',
    'This is a personal project, not a company — there’s no support team, and features come and go as I have time for them. Please don’t treat it as your only financial record.',
  ];
  return (
    <View style={styles.section}>
      <SectionLabel tokens={tokens}>Privacy & terms</SectionLabel>
      {paragraphs.map((p, i) => (
        <Text
          key={i}
          style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, lineHeight: 20, marginBottom: 10 }}
        >
          {p}
        </Text>
      ))}
    </View>
  );
}

function Footer({ tokens }: { tokens: Tokens }) {
  const year = useMemo(() => new Date().getFullYear(), []);
  return (
    <View style={[styles.footer, { borderTopColor: tokens.border }]}>
      <View style={styles.brand}>
        <LogoMark size={13} color={tokens.textMuted} holeColor={tokens.bg} />
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 12 }}>Kasička</Text>
      </View>
      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12 }}>© {year}</Text>
    </View>
  );
}

const CONTENT_MAX_WIDTH = 1040;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scrollContent: { alignItems: 'center' },
  page: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, paddingHorizontal: 22 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 18, paddingBottom: 8 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerSignIn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, borderWidth: 1 },

  hero: { alignItems: 'center', textAlign: 'center', paddingTop: 48, paddingBottom: 40 },
  heroTitle: { fontFamily: fontFamily.extrabold, textAlign: 'center', maxWidth: 720, letterSpacing: -0.5 },
  heroSubtitle: { fontFamily: fontFamily.medium, textAlign: 'center', maxWidth: 520, marginTop: 16, lineHeight: 22 },
  heroAmountWrap: { alignItems: 'center', marginTop: 40, marginBottom: 36, position: 'relative' },
  heroWatermark: {
    position: 'absolute',
    top: -30,
    left: 0,
    right: 0,
    alignItems: 'center',
    opacity: 0.07,
  },
  heroCta: { paddingHorizontal: 30, paddingVertical: 16, borderRadius: 14 },

  section: { paddingVertical: 36, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'transparent' },

  panel: { width: '100%', maxWidth: 360, borderWidth: 1, borderRadius: 20, padding: 16 },
  previewTypeToggle: { flexDirection: 'row', borderRadius: 10, padding: 3, alignSelf: 'flex-start' },
  previewTypeToggleBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  previewMiniWatermark: { position: 'absolute', top: -14, opacity: 0.08 },
  previewCategoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  previewCategoryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 9,
    borderRadius: 12,
    flexBasis: '31%',
    flexGrow: 0,
  },
  previewDot: { width: 6, height: 6, borderRadius: 3 },

  previewStat: { flex: 1, borderRadius: 12, padding: 10 },
  previewBudgetRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, padding: 8, marginBottom: 6 },
  previewSwatch: { width: 20, height: 20, borderRadius: 7, flexShrink: 0 },
  previewBarTrack: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden' },
  previewBarFill: { height: 6, borderRadius: 3 },

  previewDebtCard: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 14, padding: 10, marginBottom: 10 },
  previewAvatar: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  previewShareRow: { borderWidth: 1, borderRadius: 12, borderStyle: 'dashed', padding: 10, gap: 4 },

  featureDot: { width: 10, height: 10, borderRadius: 5, marginTop: 5, flexShrink: 0 },

  coffeeBtn: { alignSelf: 'flex-start', paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, borderWidth: 1 },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 20,
    borderTopWidth: 1,
    marginBottom: 20,
  },
});
