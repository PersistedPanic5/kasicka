import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useAuth } from '@/lib/auth-context';
import { useLanguage } from '@/lib/language-context';
import { supabase } from '@/lib/supabase';
import { currentBudgetMonth, formatBudgetMonthLabel, shiftBudgetMonth } from '@/lib/budget-month';
import {
  accrualProgress,
  confirmFinalPayment,
  confirmReserveTransfer,
  currentCycle,
  finalPaymentQrPayload,
  monthlyReserveAmount,
  reserveTransferQrPayload,
  type LongTermTx,
} from '@/lib/long-term';
import type { Account, Category, LongTermItem } from '@/types/database';

/**
 * Payments — a month-scoped, paid/unpaid view of every long-term & reserve
 * item, with the same QR-view/confirm actions the monthly wizard's step 4
 * offers, but reachable any time rather than only mid-review (Pavel's
 * request: "I need somewhere to see the overview... elsewhere" — the
 * wizard's own step 3/4 stay as they are for the guided monthly ritual;
 * this is the drop-in-any-time counterpart).
 *
 * The month switcher walks whole budget-month cycles like Overview's
 * (lib/budget-month.ts), and can go both directions — past months to see
 * what happened, future months to see what's coming. But *confirming* a
 * transfer/payment always posts as a real transaction dated today
 * (lib/long-term.ts's confirmReserveTransfer/confirmFinalPayment hard-code
 * `new Date()`), so the confirm button only appears when the selected
 * month is the real current cycle — for any other month this is read-only
 * status, which is exactly what "already paid and not paid for selected
 * month" asked for.
 *
 * Each active item is placed into the selected month by comparing it
 * against that item's *real* current cycle (lib/long-term.ts's
 * currentCycle, which already handles a repeat_yearly item's window
 * rolling forward past a completed cycle): the cycle's payment month is a
 * PAYMENT row, every month from firstReserveMonth up to (not including)
 * the payment month is a RESERVE row, and a month outside that window
 * isn't shown for that item at all — nothing's due from it then.
 */

interface MonthRow {
  item: LongTermItem;
  kind: 'RESERVE' | 'PAYMENT';
  amount: number;
  paid: boolean;
  pct: number;
}

export default function Payments() {
  const { tokens } = useTheme();
  const { user } = useAuth();
  const { language, t } = useLanguage();

  const [monthOffset, setMonthOffset] = useState(0);
  const [monthStartDay, setMonthStartDay] = useState<number | null>(null);
  const [defaultAccountId, setDefaultAccountId] = useState<string | null>(null);

  const [longTermItems, setLongTermItems] = useState<LongTermItem[]>([]);
  const [longTermTx, setLongTermTx] = useState<LongTermTx[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  const [openQrItemId, setOpenQrItemId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    supabase
      .from('profile')
      .select('month_start_day, default_account_id')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) {
          setMonthStartDay(data?.month_start_day ?? 1);
          setDefaultAccountId(data?.default_account_id ?? null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const todayMonth = useMemo(() => (monthStartDay !== null ? currentBudgetMonth(monthStartDay) : null), [monthStartDay]);
  const selectedMonth = useMemo(() => (todayMonth ? shiftBudgetMonth(todayMonth, monthOffset) : null), [todayMonth, monthOffset]);
  const monthLabel = useMemo(
    () => (selectedMonth && monthStartDay !== null ? formatBudgetMonthLabel(selectedMonth, monthStartDay, language) : ''),
    [selectedMonth, monthStartDay, language]
  );
  const isCurrentMonth = selectedMonth !== null && selectedMonth === todayMonth;

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [longTermRes, longTermTxRes, accountsRes, categoriesRes] = await Promise.all([
      supabase.from('long_term_items').select('*').eq('owner_id', user.id).eq('active', true).order('name'),
      // No date filter — a repeat_yearly item's window can cross a
      // calendar-year boundary (see planning.tsx / wizard.tsx's identical
      // comment).
      supabase
        .from('transactions')
        .select('long_term_item_id, type, amount, transaction_date')
        .eq('owner_id', user.id)
        .not('long_term_item_id', 'is', null),
      supabase.from('accounts').select('*').eq('owner_id', user.id).eq('active', true).order('sort_order'),
      supabase.from('categories').select('*').eq('owner_id', user.id).order('sort_order'),
    ]);
    setLongTermItems(longTermRes.data ?? []);
    setLongTermTx((longTermTxRes.data ?? []) as LongTermTx[]);
    setAccounts(accountsRes.data ?? []);
    setCategories(categoriesRes.data ?? []);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const categoryNameById = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

  const rows: MonthRow[] = useMemo(() => {
    if (!selectedMonth) return [];
    return longTermItems
      .map((item): MonthRow | null => {
        const cycle = currentCycle(item, monthStartDay ?? 1);
        let kind: 'RESERVE' | 'PAYMENT' | null = null;
        if (selectedMonth === cycle.paymentMonth) kind = 'PAYMENT';
        else if (selectedMonth >= cycle.firstReserveMonth && selectedMonth < cycle.paymentMonth) kind = 'RESERVE';
        if (!kind) return null;

        const monthTx = longTermTx.filter(
          (tx) => tx.long_term_item_id === item.id && tx.transaction_date.slice(0, 7) === selectedMonth.slice(0, 7)
        );
        const paidTx = monthTx.find((tx) => tx.type === (kind === 'PAYMENT' ? 'PAYMENT_FROM_RESERVE' : 'RESERVE_TRANSFER'));
        const paid = !!paidTx;

        const amount = paid
          ? Number(paidTx!.amount)
          : kind === 'PAYMENT'
          ? item.full_payment_amount
          : monthlyReserveAmount(item, cycle, longTermTx, monthStartDay ?? 1);

        const { pct } = accrualProgress(item, cycle, longTermTx);

        return { item, kind, amount, paid, pct };
      })
      .filter((r): r is MonthRow => r !== null)
      .sort((a, b) => Number(a.paid) - Number(b.paid));
  }, [longTermItems, longTermTx, selectedMonth, monthStartDay]);

  async function handleConfirm(row: MonthRow) {
    if (!user) return;
    const accountId = row.item.reserve_account_id ?? defaultAccountId;
    if (!accountId) return;
    setConfirmingId(row.item.id);
    const { error } =
      row.kind === 'PAYMENT'
        ? await confirmFinalPayment(user.id, row.item, row.item.full_payment_amount, accountId, monthStartDay ?? 1)
        : await confirmReserveTransfer(user.id, row.item, row.amount, accountId, monthStartDay ?? 1);
    setConfirmingId(null);
    if (!error) {
      setOpenQrItemId(null);
      load();
    }
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 60 }}>
      <View style={styles.headerRow}>
        <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 24 }}>{t('payments.title')}</Text>
        <View style={styles.monthSwitcher}>
          <Pressable
            onPress={() => setMonthOffset((v) => v - 1)}
            style={[styles.monthBtn, { backgroundColor: tokens.card }]}
          >
            <Text style={{ color: tokens.text, fontFamily: fontFamily.bold }}>−</Text>
          </Pressable>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14, width: 190, textAlign: 'center' }}>
            {monthLabel}
          </Text>
          <Pressable
            onPress={() => setMonthOffset((v) => v + 1)}
            style={[styles.monthBtn, { backgroundColor: tokens.card }]}
          >
            <Text style={{ color: tokens.text, fontFamily: fontFamily.bold }}>+</Text>
          </Pressable>
        </View>
      </View>
      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, marginBottom: 22 }}>
        {t('payments.hint')}
      </Text>

      {loading ? (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium }}>{t('common.loading')}</Text>
      ) : rows.length === 0 ? (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13 }}>
          {t('payments.noneThisMonth')}
        </Text>
      ) : (
        rows.map((row) => {
          const { item, kind, amount, paid, pct } = row;
          const open = openQrItemId === item.id;
          const reserveAccount = item.reserve_account_id ? accountById.get(item.reserve_account_id) ?? null : null;
          const qrPayload =
            kind === 'PAYMENT' ? finalPaymentQrPayload(item) : reserveTransferQrPayload(item, reserveAccount, amount);
          const canAct = isCurrentMonth && !paid;

          return (
            <View key={item.id} style={[styles.ltCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>{item.name}</Text>
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 2 }}>
                    {categoryNameById.get(item.category_id) ?? '—'}
                  </Text>
                  <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 12, marginTop: 4 }}>
                    {kind === 'PAYMENT' ? t('wizard.finalPaymentLabel') : t('wizard.reserveTransferLabel')} · {amount}{' '}
                    {t('common.czk')}
                  </Text>
                </View>
                <View style={[styles.statusPill, { backgroundColor: paid ? tokens.greenBg : tokens.cardAlt }]}>
                  <Text
                    style={{
                      color: paid ? tokens.greenFg : tokens.textMuted,
                      fontFamily: fontFamily.semibold,
                      fontSize: 11.5,
                    }}
                  >
                    {paid ? t('payments.statusPaid') : t('payments.statusUnpaid')}
                  </Text>
                </View>
              </View>

              {kind === 'RESERVE' && (
                <View style={[styles.barTrack, { backgroundColor: tokens.cardAlt, marginTop: 10 }]}>
                  <View style={[styles.barFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: tokens.accent }]} />
                </View>
              )}

              {!open ? (
                <Pressable
                  onPress={() => setOpenQrItemId(item.id)}
                  style={[styles.smallBtn, { backgroundColor: tokens.cardAlt, marginTop: 10, alignSelf: 'flex-start' }]}
                >
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                    {t('payments.viewQr')}
                  </Text>
                </Pressable>
              ) : (
                <View style={{ marginTop: 12, alignItems: 'flex-start' }}>
                  {qrPayload ? (
                    <View style={[styles.qrWhite, { marginBottom: 10 }]}>
                      <QRCode value={qrPayload} size={140} />
                    </View>
                  ) : (
                    <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5, marginBottom: 10 }}>
                      {t('wizard.noQrAvailable')}
                    </Text>
                  )}
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {canAct && (
                      <Pressable
                        onPress={() => handleConfirm(row)}
                        disabled={confirmingId === item.id}
                        style={[styles.smallBtn, { backgroundColor: tokens.accent, opacity: confirmingId === item.id ? 0.6 : 1 }]}
                      >
                        <Text style={{ color: tokens.accentText, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                          {t('wizard.markDone')}
                        </Text>
                      </Pressable>
                    )}
                    <Pressable onPress={() => setOpenQrItemId(null)} style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}>
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                        {t('common.cancel')}
                      </Text>
                    </Pressable>
                  </View>
                  {!isCurrentMonth && !paid && (
                    <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11, marginTop: 8 }}>
                      {t('payments.confirmOnlyThisMonth')}
                    </Text>
                  )}
                </View>
              )}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    flexWrap: 'wrap',
    gap: 12,
  },
  monthSwitcher: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  monthBtn: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  ltCard: { borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 10 },
  statusPill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  barTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  smallBtn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 9 },
  qrWhite: { backgroundColor: '#ffffff', padding: 10, borderRadius: 10, alignSelf: 'flex-start' },
});
