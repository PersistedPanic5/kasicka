import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { fontFamily } from '@/lib/theme';
import type { useTheme } from '@/lib/theme-context';
import type { Account, Category, ReserveAmountMode } from '@/types/database';

/**
 * The long-term/reserve item form — used for both "add" and "edit" on
 * Planning (app/(app)/planning.tsx), and for the same "edit" from Payments
 * (app/(app)/payments.tsx: Pavel's "add edit button... for standard
 * payments... instead of deleting and/or recreating"). Pulled out to its
 * own file rather than kept local to planning.tsx (which is where it
 * originally lived) specifically so Payments can reuse the exact same
 * fields/validation instead of growing a second, partial copy of this
 * form — a "quick edit" that's missing whatever field turns out to be the
 * one that was actually wrong would just move the annoyance rather than
 * fix it.
 */
export function LongTermForm(props: {
  mode: 'add' | 'edit';
  embedded?: boolean;
  tokens: ReturnType<typeof useTheme>['tokens'];
  t: (key: string) => string;
  categories: Category[];
  accounts: Account[];
  ltName: string;
  setLtName: (v: string) => void;
  ltCategoryId: string | null;
  setLtCategoryId: (v: string) => void;
  ltFullAmount: string;
  setLtFullAmount: (v: string) => void;
  ltPaymentMonth: string;
  setLtPaymentMonth: (v: string) => void;
  ltFirstReserveMonth: string;
  setLtFirstReserveMonth: (v: string) => void;
  ltMode: ReserveAmountMode;
  setLtMode: (v: ReserveAmountMode) => void;
  ltManualReserve: string;
  setLtManualReserve: (v: string) => void;
  ltOpeningBalance: string;
  setLtOpeningBalance: (v: string) => void;
  ltRepeatYearly: boolean;
  setLtRepeatYearly: (v: boolean) => void;
  ltReserveAccountId: string | null;
  setLtReserveAccountId: (v: string) => void;
  ltTargetPrefix: string;
  setLtTargetPrefix: (v: string) => void;
  ltTargetNumber: string;
  setLtTargetNumber: (v: string) => void;
  ltTargetBankCode: string;
  setLtTargetBankCode: (v: string) => void;
  ltVariableSymbol: string;
  setLtVariableSymbol: (v: string) => void;
  ltPaymentMessage: string;
  setLtPaymentMessage: (v: string) => void;
  error: string | null;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const { tokens, t } = props;
  return (
    <View
      style={
        props.embedded
          ? undefined
          : [styles.newAccountCard, { backgroundColor: tokens.card, borderColor: tokens.border }]
      }
    >
      <TextInput
        value={props.ltName}
        onChangeText={props.setLtName}
        placeholder={t('more.longTermNamePlaceholder')}
        placeholderTextColor={tokens.textMuted}
        style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, marginBottom: 8 }]}
      />
      <TextInput
        value={props.ltFullAmount}
        onChangeText={props.setLtFullAmount}
        keyboardType="numeric"
        placeholder={t('more.longTermFullAmountPlaceholder')}
        placeholderTextColor={tokens.textMuted}
        style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, marginBottom: 10 }]}
      />

      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginBottom: 6 }}>
        {t('transactions.categoryLabel')}
      </Text>
      <View style={styles.chipRow}>
        {props.categories
          .filter((c) => c.active)
          .map((cat) => (
            <Pressable
              key={cat.id}
              onPress={() => props.setLtCategoryId(cat.id)}
              style={[styles.chip, { backgroundColor: props.ltCategoryId === cat.id ? tokens.accent : tokens.cardAlt }]}
            >
              <Text
                style={{
                  color: props.ltCategoryId === cat.id ? tokens.accentText : tokens.text,
                  fontFamily: fontFamily.semibold,
                  fontSize: 12,
                }}
              >
                {cat.name}
              </Text>
            </Pressable>
          ))}
      </View>

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginBottom: 6 }}>
            {t('more.longTermFirstReserveMonth')}
          </Text>
          <TextInput
            value={props.ltFirstReserveMonth}
            onChangeText={props.setLtFirstReserveMonth}
            placeholder="2026-02"
            placeholderTextColor={tokens.textMuted}
            style={[styles.addInput, { color: tokens.text, borderColor: tokens.border }]}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginBottom: 6 }}>
            {t('more.longTermPaymentMonth')}
          </Text>
          <TextInput
            value={props.ltPaymentMonth}
            onChangeText={props.setLtPaymentMonth}
            placeholder="2027-01"
            placeholderTextColor={tokens.textMuted}
            style={[styles.addInput, { color: tokens.text, borderColor: tokens.border }]}
          />
        </View>
      </View>

      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 10, marginBottom: 6 }}>
        {t('more.longTermMode')}
      </Text>
      <View style={styles.chipRow}>
        {(['AUTO', 'MANUAL'] as ReserveAmountMode[]).map((mode) => (
          <Pressable
            key={mode}
            onPress={() => props.setLtMode(mode)}
            style={[styles.chip, { backgroundColor: props.ltMode === mode ? tokens.accent : tokens.cardAlt }]}
          >
            <Text
              style={{
                color: props.ltMode === mode ? tokens.accentText : tokens.text,
                fontFamily: fontFamily.semibold,
                fontSize: 12,
              }}
            >
              {mode === 'AUTO' ? t('more.longTermModeAuto') : t('more.longTermModeManual')}
            </Text>
          </Pressable>
        ))}
      </View>

      {props.ltMode === 'MANUAL' && (
        <TextInput
          value={props.ltManualReserve}
          onChangeText={props.setLtManualReserve}
          keyboardType="numeric"
          placeholder={t('more.longTermManualReservePlaceholder')}
          placeholderTextColor={tokens.textMuted}
          style={[styles.addInput, { color: tokens.text, borderColor: tokens.border, marginTop: 8 }]}
        />
      )}

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginBottom: 6 }}>
            {t('more.longTermOpeningBalance')}
          </Text>
          <TextInput
            value={props.ltOpeningBalance}
            onChangeText={props.setLtOpeningBalance}
            keyboardType="numeric"
            style={[styles.addInput, { color: tokens.text, borderColor: tokens.border }]}
          />
        </View>
        <Pressable
          onPress={() => props.setLtRepeatYearly(!props.ltRepeatYearly)}
          style={[
            styles.chip,
            { backgroundColor: props.ltRepeatYearly ? tokens.accent : tokens.cardAlt, alignSelf: 'flex-end', marginBottom: 2 },
          ]}
        >
          <Text
            style={{
              color: props.ltRepeatYearly ? tokens.accentText : tokens.text,
              fontFamily: fontFamily.semibold,
              fontSize: 12,
            }}
          >
            {t('more.longTermRepeatsYearly')}
          </Text>
        </Pressable>
      </View>

      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 10, marginBottom: 6 }}>
        {t('more.longTermReserveAccount')}
      </Text>
      <View style={styles.chipRow}>
        {props.accounts
          .filter((a) => a.active)
          .map((acc) => (
            <Pressable
              key={acc.id}
              onPress={() => props.setLtReserveAccountId(acc.id)}
              style={[
                styles.chip,
                { backgroundColor: props.ltReserveAccountId === acc.id ? tokens.accent : tokens.cardAlt },
              ]}
            >
              <Text
                style={{
                  color: props.ltReserveAccountId === acc.id ? tokens.accentText : tokens.text,
                  fontFamily: fontFamily.semibold,
                  fontSize: 12,
                }}
              >
                {acc.name}
              </Text>
            </Pressable>
          ))}
      </View>

      <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 11.5, marginTop: 12, marginBottom: 6 }}>
        {t('more.longTermExternalPayeeHint')}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <TextInput
          value={props.ltTargetPrefix}
          onChangeText={props.setLtTargetPrefix}
          placeholder={t('more.accountPrefixPlaceholder')}
          placeholderTextColor={tokens.textMuted}
          style={[styles.wrapInput, { color: tokens.text, borderColor: tokens.border, flexGrow: 1, flexBasis: 80 }]}
        />
        <TextInput
          value={props.ltTargetNumber}
          onChangeText={props.setLtTargetNumber}
          placeholder={t('more.accountNumberPlaceholder')}
          placeholderTextColor={tokens.textMuted}
          style={[styles.wrapInput, { color: tokens.text, borderColor: tokens.border, flexGrow: 2, flexBasis: 130 }]}
        />
        <TextInput
          value={props.ltTargetBankCode}
          onChangeText={props.setLtTargetBankCode}
          placeholder={t('more.bankCodePlaceholder')}
          placeholderTextColor={tokens.textMuted}
          style={[styles.wrapInput, { color: tokens.text, borderColor: tokens.border, flexGrow: 1, flexBasis: 80 }]}
        />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        <TextInput
          value={props.ltVariableSymbol}
          onChangeText={props.setLtVariableSymbol}
          placeholder={t('more.longTermVariableSymbolPlaceholder')}
          placeholderTextColor={tokens.textMuted}
          style={[styles.wrapInput, { color: tokens.text, borderColor: tokens.border, flexGrow: 1, flexBasis: 120 }]}
        />
        <TextInput
          value={props.ltPaymentMessage}
          onChangeText={props.setLtPaymentMessage}
          placeholder={t('more.longTermMessagePlaceholder')}
          placeholderTextColor={tokens.textMuted}
          style={[styles.wrapInput, { color: tokens.text, borderColor: tokens.border, flexGrow: 2, flexBasis: 160 }]}
        />
      </View>

      {props.error && (
        <Text style={{ color: tokens.coral, fontFamily: fontFamily.medium, fontSize: 12.5, marginTop: 10 }}>
          {props.error}
        </Text>
      )}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
        <Pressable onPress={props.onCancel} style={[styles.modalBtn, { backgroundColor: tokens.cardAlt }]}>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13 }}>{t('common.cancel')}</Text>
        </Pressable>
        <Pressable
          onPress={props.onSave}
          disabled={props.saving}
          style={[styles.modalBtn, { backgroundColor: tokens.accent, opacity: props.saving ? 0.6 : 1 }]}
        >
          <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 13 }}>
            {props.saving ? t('common.saving') : t('common.save')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  addInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  wrapInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  newAccountCard: { borderWidth: 1, borderRadius: 14, padding: 14, marginTop: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
  modalBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
});
