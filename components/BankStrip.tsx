import { useEffect, useState } from 'react';
import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useLanguage } from '@/lib/language-context';
import { supabase } from '@/lib/supabase';
import { useBankPending } from '@/lib/bank';

/** "Bank 3" pill for the phone header — links straight to the inbox. */
export function BankBadge() {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  const { enabled, count } = useBankPending();
  if (!enabled) return null;
  return (
    <Link href="/(app)/bank" asChild>
      <Pressable
        accessibilityLabel={`${t('nav.bank')} ${count}`}
        // StyleSheet.flatten: an array style on a `Link asChild` Pressable crashes web ("Failed to set an indexed property") and blanks the whole app
        style={StyleSheet.flatten([s.pill, { backgroundColor: count ? tokens.accent : tokens.card, borderColor: count ? tokens.accentBorder : tokens.border }])}
      >
        <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={count ? tokens.accentText : tokens.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <Path d="M3 10l9-6 9 6M5 10v8M10 10v8M14 10v8M19 10v8M3 21h18" />
        </Svg>
        <Text style={{ color: count ? tokens.accentText : tokens.text, fontFamily: fontFamily.extrabold, fontSize: 13 }}>{t('nav.bank')}</Text>
        {count > 0 && (
          <View style={[s.count, { backgroundColor: tokens.accentText }]}>
            <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 12 }}>{count}</Text>
          </View>
        )}
      </Pressable>
    </Link>
  );
}

/** "3 card payments are waiting" strip above the entry form (phone and desktop Home). */
export function BankStrip({ withHint = false }: { withHint?: boolean }) {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  const { enabled, count } = useBankPending();
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled || !count) return;
    supabase
      .from('bank_transactions')
      .select('merchant')
      .eq('status', 'NEW')
      .lt('amount', 0)
      .order('booked_date', { ascending: false })
      .limit(2)
      .then(({ data }) => setNames((data ?? []).map((r: { merchant: string }) => r.merchant)));
  }, [enabled, count]);

  if (!enabled) return null;
  return (
    <View style={{ width: '100%', gap: 10, marginBottom: 14 }}>
      {count > 0 && (
        <View style={[s.strip, { backgroundColor: tokens.card }]}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 15 }}>
              {count === 1 ? t('bank.fastWaitingOne') : t('bank.fastWaiting').replace('{n}', String(count))}
            </Text>
            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13 }}>
              {names.join(', ')}
              {count > names.length ? ` ${t('bank.fastMore').replace('{n}', String(count - names.length))}` : ''}
            </Text>
          </View>
          <Link href="/(app)/bank" asChild>
            <Pressable style={StyleSheet.flatten([s.review, { borderColor: tokens.accentBorder, backgroundColor: tokens.cardAlt }])}>
              <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 14 }}>{t('bank.fastReview')}</Text>
            </Pressable>
          </Link>
        </View>
      )}
      {withHint && (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 13, textAlign: 'center' }}>{t('bank.fastHint')}</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  pill: { height: 34, borderRadius: 17, borderWidth: 1, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
  count: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  strip: { borderRadius: 18, paddingHorizontal: 18, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 14 },
  review: { height: 44, borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
});
