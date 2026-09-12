import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
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
import { confirmManualPayment, findOrCreatePayee, manualPaymentQrPayload } from '@/lib/manual-payments';
import type { Account, Category, LongTermItem, ManualPayment, Payee } from '@/types/database';

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

  // ── One-off payments (Pavel: "I got only the account number and value
  // in text" — see lib/manual-payments.ts) ────────────────────────────
  const [payees, setPayees] = useState<Payee[]>([]);
  const [manualPayments, setManualPayments] = useState<ManualPayment[]>([]);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [payeeName, setPayeeName] = useState('');
  const [payeePrefix, setPayeePrefix] = useState('');
  const [payeeAccountNumber, setPayeeAccountNumber] = useState('');
  const [payeeBankCode, setPayeeBankCode] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMessage, setPaymentMessage] = useState('');
  const [paymentVariableSymbol, setPaymentVariableSymbol] = useState('');
  const [paymentCategoryId, setPaymentCategoryId] = useState<string | null>(null);
  const [paymentAccountId, setPaymentAccountId] = useState<string | null>(null);
  const [savingPayment, setSavingPayment] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [openManualQrId, setOpenManualQrId] = useState<string | null>(null);
  const [confirmingManualId, setConfirmingManualId] = useState<string | null>(null);

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
    const [longTermRes, longTermTxRes, accountsRes, categoriesRes, payeesRes, manualPaymentsRes] = await Promise.all([
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
      supabase.from('payees').select('*').eq('owner_id', user.id),
      supabase.from('manual_payments').select('*').eq('owner_id', user.id).order('created_at', { ascending: false }),
    ]);
    setLongTermItems(longTermRes.data ?? []);
    setLongTermTx((longTermTxRes.data ?? []) as LongTermTx[]);
    setAccounts(accountsRes.data ?? []);
    setCategories(categoriesRes.data ?? []);
    setPayees(payeesRes.data ?? []);
    setManualPayments(manualPaymentsRes.data ?? []);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const categoryNameById = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  // A one-off payment is always money going out, same as any other
  // expense — INCOME categories (this screen's `categories` fetch isn't
  // type-filtered, unlike lib/use-app-data.ts's) don't belong as options.
  const expenseCategories = useMemo(() => categories.filter((c) => c.category_type === 'EXPENSE'), [categories]);

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

  const payeeById = useMemo(() => new Map(payees.map((p) => [p.id, p])), [payees]);
  // Most-recently-paid first; a payee who's never actually been confirmed
  // paid yet (last_paid_at still null) sorts to the end rather than the
  // top, same as an empty string sorting before any real ISO date.
  const sortedPayees = useMemo(
    () => [...payees].sort((a, b) => (b.last_paid_at ?? '').localeCompare(a.last_paid_at ?? '')),
    [payees]
  );

  function openNewPaymentForm(payee?: Payee) {
    setPayeeName(payee?.name ?? '');
    setPayeePrefix(payee?.target_account_prefix ?? '');
    setPayeeAccountNumber(payee?.target_account_number ?? '');
    setPayeeBankCode(payee?.target_bank_code ?? '');
    setPaymentAmount('');
    setPaymentMessage('');
    setPaymentVariableSymbol('');
    setPaymentCategoryId(expenseCategories[0]?.id ?? null);
    setPaymentAccountId(defaultAccountId);
    setPaymentError(null);
    setShowPaymentForm(true);
  }

  async function submitNewPayment() {
    if (!user) return;
    const amount = Number(paymentAmount);
    if (
      !payeeName.trim() ||
      !payeeAccountNumber.trim() ||
      !payeeBankCode.trim() ||
      !amount ||
      amount <= 0 ||
      !paymentCategoryId ||
      !paymentAccountId
    ) {
      setPaymentError(t('payments.manualFormError'));
      return;
    }
    setSavingPayment(true);
    setPaymentError(null);
    const { id: payeeId, error: payeeError } = await findOrCreatePayee(
      user.id,
      payeeName.trim(),
      payeeBankCode.trim(),
      payeeAccountNumber.trim(),
      payeePrefix.trim() || null
    );
    if (payeeError || !payeeId) {
      setPaymentError(payeeError ?? t('common.savingError'));
      setSavingPayment(false);
      return;
    }
    const { error } = await supabase.from('manual_payments').insert({
      owner_id: user.id,
      payee_id: payeeId,
      category_id: paymentCategoryId,
      account_id: paymentAccountId,
      amount,
      message: paymentMessage.trim() || null,
      variable_symbol: paymentVariableSymbol.trim() || null,
    });
    setSavingPayment(false);
    if (error) {
      setPaymentError(error.message);
      return;
    }
    setShowPaymentForm(false);
    load();
  }

  async function handleConfirmManual(payment: ManualPayment) {
    if (!user) return;
    const name = payeeById.get(payment.payee_id)?.name ?? '';
    setConfirmingManualId(payment.id);
    const { error } = await confirmManualPayment(user.id, payment, name, monthStartDay ?? 1);
    setConfirmingManualId(null);
    if (!error) {
      setOpenManualQrId(null);
      load();
    }
  }

  async function removeManualPayment(id: string) {
    await supabase.from('manual_payments').delete().eq('id', id);
    setOpenManualQrId(null);
    load();
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

      {/* One-off payments — deliberately outside the month switcher above:
          a bare account number Pavel just needs to pay has no month of its
          own, unlike the long-term reserve/payment cycle rows. */}
      <View style={styles.manualHeaderRow}>
        <View style={{ flex: 1, minWidth: 200 }}>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 18 }}>
            {t('payments.manualSectionTitle')}
          </Text>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 4 }}>
            {t('payments.manualSectionHint')}
          </Text>
        </View>
        {!showPaymentForm && (
          <Pressable onPress={() => openNewPaymentForm()} style={[styles.smallBtn, { backgroundColor: tokens.accent }]}>
            <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 12.5 }}>
              {t('payments.newPaymentBtn')}
            </Text>
          </Pressable>
        )}
      </View>

      {showPaymentForm && (
        <View style={[styles.ltCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
          <TextInput
            value={payeeName}
            onChangeText={setPayeeName}
            placeholder={t('payments.payeeNamePlaceholder')}
            placeholderTextColor={tokens.textMuted}
            style={[styles.formInput, { color: tokens.text, borderColor: tokens.border }]}
          />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput
              value={payeePrefix}
              onChangeText={setPayeePrefix}
              placeholder={t('payments.accountPrefixPlaceholder')}
              placeholderTextColor={tokens.textMuted}
              style={[styles.formInput, { color: tokens.text, borderColor: tokens.border, flex: 1 }]}
            />
            <TextInput
              value={payeeAccountNumber}
              onChangeText={setPayeeAccountNumber}
              placeholder={t('payments.accountNumberPlaceholder')}
              placeholderTextColor={tokens.textMuted}
              style={[styles.formInput, { color: tokens.text, borderColor: tokens.border, flex: 2 }]}
            />
            <TextInput
              value={payeeBankCode}
              onChangeText={setPayeeBankCode}
              placeholder={t('payments.bankCodePlaceholder')}
              placeholderTextColor={tokens.textMuted}
              style={[styles.formInput, { color: tokens.text, borderColor: tokens.border, flex: 1 }]}
            />
          </View>
          <TextInput
            value={paymentAmount}
            onChangeText={setPaymentAmount}
            keyboardType="numeric"
            placeholder={t('payments.amountPlaceholder')}
            placeholderTextColor={tokens.textMuted}
            style={[styles.formInput, { color: tokens.text, borderColor: tokens.border }]}
          />
          <TextInput
            value={paymentMessage}
            onChangeText={setPaymentMessage}
            placeholder={t('payments.messagePlaceholder')}
            placeholderTextColor={tokens.textMuted}
            style={[styles.formInput, { color: tokens.text, borderColor: tokens.border }]}
          />
          <TextInput
            value={paymentVariableSymbol}
            onChangeText={setPaymentVariableSymbol}
            keyboardType="numeric"
            placeholder={t('payments.variableSymbolPlaceholder')}
            placeholderTextColor={tokens.textMuted}
            style={[styles.formInput, { color: tokens.text, borderColor: tokens.border }]}
          />

          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 2 }}>
            {t('transactions.categoryLabel')}
          </Text>
          <View style={styles.chipRow}>
            {expenseCategories.map((cat) => (
              <Pressable
                key={cat.id}
                onPress={() => setPaymentCategoryId(cat.id)}
                style={[styles.chip, { backgroundColor: paymentCategoryId === cat.id ? tokens.accent : tokens.cardAlt }]}
              >
                <Text
                  style={{
                    color: paymentCategoryId === cat.id ? tokens.accentText : tokens.text,
                    fontFamily: fontFamily.semibold,
                    fontSize: 12.5,
                  }}
                >
                  {cat.name}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 8 }}>
            {t('home.accountLabel')}
          </Text>
          <View style={styles.chipRow}>
            {accounts.map((acc) => (
              <Pressable
                key={acc.id}
                onPress={() => setPaymentAccountId(acc.id)}
                style={[styles.chip, { backgroundColor: paymentAccountId === acc.id ? tokens.accent : tokens.cardAlt }]}
              >
                <Text
                  style={{
                    color: paymentAccountId === acc.id ? tokens.accentText : tokens.text,
                    fontFamily: fontFamily.semibold,
                    fontSize: 12.5,
                  }}
                >
                  {acc.name}
                </Text>
              </Pressable>
            ))}
          </View>

          {paymentError && (
            <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 8 }}>
              {paymentError}
            </Text>
          )}

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <Pressable
              onPress={submitNewPayment}
              disabled={savingPayment}
              style={[styles.smallBtn, { backgroundColor: tokens.accent, opacity: savingPayment ? 0.6 : 1 }]}
            >
              <Text style={{ color: tokens.accentText, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                {t('payments.createPaymentBtn')}
              </Text>
            </Pressable>
            <Pressable onPress={() => setShowPaymentForm(false)} style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                {t('common.cancel')}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      {manualPayments.length === 0 ? (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13, marginBottom: 22 }}>
          {t('payments.manualNoneYet')}
        </Text>
      ) : (
        manualPayments.map((payment) => {
          const payee = payeeById.get(payment.payee_id);
          const open = openManualQrId === payment.id;
          const qrPayload = payee ? manualPaymentQrPayload(payee, payment.amount, payment.message, payment.variable_symbol) : null;
          return (
            <View key={payment.id} style={[styles.ltCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>
                    {payee?.name ?? '—'}
                  </Text>
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 2 }}>
                    {categoryNameById.get(payment.category_id) ?? '—'}
                  </Text>
                  <Text style={{ color: tokens.accent, fontFamily: fontFamily.semibold, fontSize: 12, marginTop: 4 }}>
                    {payment.amount} {t('common.czk')}
                  </Text>
                </View>
                <View style={[styles.statusPill, { backgroundColor: tokens.cardAlt }]}>
                  <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 11.5 }}>
                    {t('payments.statusUnpaid')}
                  </Text>
                </View>
              </View>

              {!open ? (
                <Pressable
                  onPress={() => setOpenManualQrId(payment.id)}
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
                    <Pressable
                      onPress={() => handleConfirmManual(payment)}
                      disabled={confirmingManualId === payment.id}
                      style={[styles.smallBtn, { backgroundColor: tokens.accent, opacity: confirmingManualId === payment.id ? 0.6 : 1 }]}
                    >
                      <Text style={{ color: tokens.accentText, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                        {t('wizard.markDone')}
                      </Text>
                    </Pressable>
                    <Pressable onPress={() => removeManualPayment(payment.id)} style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}>
                      <Text style={{ color: tokens.coral, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                        {t('payments.removeManual')}
                      </Text>
                    </Pressable>
                    <Pressable onPress={() => setOpenManualQrId(null)} style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}>
                      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                        {t('common.cancel')}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              )}
            </View>
          );
        })
      )}

      {/* "a database of people I sent money to this way" — browsing here
          and tapping one prefills a fresh payment with their saved account
          details (Pavel's choice: not an instant one-tap repeat, since the
          amount is normally different each time). */}
      <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 18, marginTop: 8 }}>
        {t('payments.payeesTitle')}
      </Text>
      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 4, marginBottom: 14 }}>
        {t('payments.payeesHint')}
      </Text>
      {sortedPayees.length === 0 ? (
        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13 }}>
          {t('payments.noPayeesYet')}
        </Text>
      ) : (
        sortedPayees.map((payee) => (
          <View key={payee.id} style={[styles.payeeRow, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14 }}>
                {payee.name}
              </Text>
              {payee.last_paid_at && (
                <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11, marginTop: 2 }}>
                  {t('payments.lastPaidPrefix')} {new Date(payee.last_paid_at).toLocaleDateString(language === 'cs' ? 'cs-CZ' : 'en-GB')}
                </Text>
              )}
            </View>
            <Pressable onPress={() => openNewPaymentForm(payee)} style={[styles.smallBtn, { backgroundColor: tokens.cardAlt }]}>
              <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>
                {t('payments.payAgainBtn')}
              </Text>
            </Pressable>
          </View>
        ))
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
  manualHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 28,
    marginBottom: 14,
  },
  formInput: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, marginBottom: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 14 },
  payeeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 8,
  },
});
