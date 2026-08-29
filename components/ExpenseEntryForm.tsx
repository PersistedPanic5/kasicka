import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily, CATEGORY_NAMES } from '@/lib/theme';
import { supabase } from '@/lib/supabase';

/**
 * The fast expense-capture form — the single most important screen in the
 * app (see screens-and-flows.md "Core UX principle"). Used both by the
 * mobile fast-entry screen (compact) and the desktop Home tab (roomier),
 * via the `variant` prop, so the core action never has two implementations
 * to keep in sync.
 *
 * Phase 0 scope: amount, quick-add chips, category chips, ±1 day shift,
 * save. Deliberately NOT yet built here (arriving with real backend wiring
 * in Phase 1, see build-roadmap-v1.md): the collapsed "more options" panel
 * (account/note/photo) and the "split part of this with someone" debt
 * panel. Save currently inserts a minimal row and will need a real
 * account_id/category_id once accounts/categories exist per-user.
 */
export function ExpenseEntryForm({ variant = 'mobile' }: { variant?: 'mobile' | 'desktop' }) {
  const { tokens } = useTheme();
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<string>(CATEGORY_NAMES[0]);
  const [dayOffset, setDayOffset] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const quickAmounts = [20, 50, 100, 200]; // TODO: profile.amount_buttons (More → Profile)

  const dateLabel = useMemo(() => {
    if (dayOffset === 0) return 'Today';
    if (dayOffset === 1) return 'Tomorrow';
    if (dayOffset === -1) return 'Yesterday';
    return dayOffset > 0 ? `+${dayOffset} days` : `${dayOffset} days`;
  }, [dayOffset]);

  async function handleSave() {
    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount <= 0) return;
    setSaving(true);
    try {
      // NOTE: account_id/category_id are placeholders until Phase 1 wires
      // real profile/category lookups — this proves the write path exists,
      // it isn't the finished insert.
      await supabase.from('transactions').insert({
        transaction_date: new Date().toISOString().slice(0, 10),
        type: 'EXPENSE',
        account_id: '00000000-0000-0000-0000-000000000000',
        amount: numericAmount,
        note: category,
      } as never);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1200);
      setAmount('');
    } catch {
      // Expected to fail until a real Supabase project + auth exist.
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={[styles.container, variant === 'desktop' && styles.containerDesktop]}>
      <View style={styles.dateRow}>
        <Pressable
          onPress={() => setDayOffset((d) => d - 1)}
          style={[styles.dateShiftBtn, { backgroundColor: tokens.card }]}
        >
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold }}>−</Text>
        </Pressable>
        <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, width: 90, textAlign: 'center' }}>
          {dateLabel}
        </Text>
        <Pressable
          onPress={() => setDayOffset((d) => d + 1)}
          style={[styles.dateShiftBtn, { backgroundColor: tokens.card }]}
        >
          <Text style={{ color: tokens.text, fontFamily: fontFamily.bold }}>+</Text>
        </Pressable>
      </View>

      <TextInput
        value={amount}
        onChangeText={setAmount}
        keyboardType="numeric"
        placeholder="0"
        placeholderTextColor={tokens.textMuted}
        style={[styles.amountInput, { color: tokens.text }]}
      />

      <View style={styles.chipRow}>
        {quickAmounts.map((v) => (
          <Pressable
            key={v}
            onPress={() => setAmount((prev) => String((Number(prev) || 0) + v))}
            style={[styles.chip, { backgroundColor: tokens.card }]}
          >
            <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13 }}>+{v}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.chipRow}>
        {CATEGORY_NAMES.map((name) => {
          const active = category === name;
          return (
            <Pressable
              key={name}
              onPress={() => setCategory(name)}
              style={[
                styles.chip,
                { backgroundColor: active ? tokens.accent : tokens.card },
              ]}
            >
              <Text
                style={{
                  color: active ? tokens.accentText : tokens.text,
                  fontFamily: fontFamily.semibold,
                  fontSize: 13,
                }}
              >
                {name}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Pressable
        onPress={handleSave}
        disabled={saving}
        style={[styles.saveBtn, { backgroundColor: tokens.accent }]}
      >
        <Text style={{ color: tokens.accentText, fontFamily: fontFamily.bold, fontSize: 15 }}>
          {savedFlash ? 'Saved' : 'Save'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', maxWidth: 390, gap: 16 },
  containerDesktop: { maxWidth: 460 },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'center' },
  dateShiftBtn: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  amountInput: { fontSize: 48, fontFamily: fontFamily.regular, textAlign: 'center' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12 },
  saveBtn: { paddingVertical: 16, borderRadius: 14, alignItems: 'center' },
});
