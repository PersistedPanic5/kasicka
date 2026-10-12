import { createElement, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { useLanguage } from '@/lib/language-context';
import { supabase } from '@/lib/supabase';
import { syncBank } from '@/lib/bank';
import type { Account } from '@/types/database';

type Rule = { id: string; match_key: string; uses: number; categories: { name: string } | null };
const MINUTES: (10 | 15 | 60)[] = [10, 15, 60];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Per-account "How do you use this account?" block (Design: "Settings:
 * account mode") for a Fio-linked account: Manual entry vs Bank inbox, the
 * first day to import, how often to check, notifications, and the
 * remembered merchants. Every change saves immediately.
 */
export function BankModeSettings({ account, onChanged }: { account: Account; onChanged: () => void }) {
  const { tokens } = useTheme();
  const { t } = useLanguage();
  const inbox = account.entry_mode === 'BANK_INBOX';
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [ruleCount, setRuleCount] = useState(0);
  const [showRules, setShowRules] = useState(false);

  useEffect(() => {
    supabase
      .from('bank_rules')
      .select('id', { count: 'exact', head: true })
      .then(({ count }) => setRuleCount(count ?? 0));
  }, [showRules]);

  async function save(patch: Partial<Account>) {
    setError(null);
    const { error: err } = await supabase.from('accounts').update(patch).eq('id', account.id);
    if (err) setError(t('more.modeSaveFailed'));
    onChanged();
    return !err;
  }

  async function setMode(mode: 'MANUAL' | 'BANK_INBOX') {
    if (mode === account.entry_mode) return;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());
    const ok = await save(
      mode === 'BANK_INBOX'
        ? { entry_mode: mode, fio_sync_from: account.fio_sync_from ?? `${today.slice(0, 8)}01`, fio_synced_through: null }
        : { entry_mode: mode },
    );
    if (ok && mode === 'BANK_INBOX') syncBank().then(onChanged); // fill the inbox right away
  }

  async function toggleRules() {
    if (!showRules) {
      const { data } = await supabase.from('bank_rules').select('id, match_key, uses, categories(name)').order('uses', { ascending: false });
      setRules((data ?? []) as unknown as Rule[]);
    }
    setShowRules(!showRules);
  }

  const Option = ({ mode, title, body }: { mode: 'MANUAL' | 'BANK_INBOX'; title: string; body: string }) => {
    const on = account.entry_mode === mode;
    return (
      <Pressable
        onPress={() => setMode(mode)}
        accessibilityRole="radio"
        accessibilityState={{ checked: on }}
        style={[s.option, { borderColor: on ? tokens.accent : tokens.border, backgroundColor: on ? tokens.greenBg : tokens.cardAlt }]}
      >
        <View style={[s.radio, { borderColor: on ? tokens.accent : tokens.border }]}>{on && <View style={[s.radioDot, { backgroundColor: tokens.accent }]} />}</View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 14 }}>{title}</Text>
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12.5, lineHeight: 18, marginTop: 2 }}>{body}</Text>
        </View>
      </Pressable>
    );
  };
  const Toggle = ({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) => (
    <Pressable onPress={onPress} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={s.toggleRow}>
      <View style={[s.box, { borderColor: on ? tokens.accent : tokens.border, backgroundColor: on ? tokens.accent : tokens.cardAlt }]}>
        {on && <Text style={{ color: tokens.accentText, fontFamily: fontFamily.extrabold, fontSize: 13, lineHeight: 15 }}>✓</Text>}
      </View>
      <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 14, flex: 1 }}>{label}</Text>
    </Pressable>
  );
  const lab = { color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: 13.5 } as const;
  const hint = { color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 12, lineHeight: 17 } as const;

  return (
    <View style={[s.wrap, { borderTopColor: tokens.border }]}>
      <Text style={lab}>{t('more.modeTitle')}</Text>
      <View style={s.options}>
        <Option mode="MANUAL" title={t('more.modeManual')} body={t('more.modeManualDesc')} />
        <Option mode="BANK_INBOX" title={t('more.modeInbox')} body={t('more.modeInboxDesc')} />
      </View>

      {inbox && (
        <>
          <View style={s.pair}>
            <View style={{ flex: 1, minWidth: 220, gap: 6 }}>
              <Text style={lab}>{t('more.syncFrom')}</Text>
              {createElement('input', {
                type: 'date',
                'aria-label': t('more.syncFrom'),
                value: account.fio_sync_from ?? '',
                // deno-lint-ignore no-explicit-any
                onChange: (e: any) => {
                  const v = String(e.target.value);
                  // moving the cut-off resets the "synced through" mark so older payments are fetched on the next check
                  if (DATE_RE.test(v)) save({ fio_sync_from: v, fio_synced_through: null });
                },
                style: {
                  height: 44,
                  borderRadius: 12,
                  border: `1px solid ${tokens.border}`,
                  background: tokens.bg,
                  color: tokens.text,
                  fontFamily: fontFamily.semibold,
                  fontSize: 14,
                  padding: '0 12px',
                },
              })}
              <Text style={hint}>{t('more.syncFromHint')}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 220, gap: 6 }}>
              <Text style={lab}>{t('more.syncEvery')}</Text>
              <View style={s.chips}>
                {MINUTES.map((m) => {
                  const on = account.bank_sync_minutes === m;
                  return (
                    <Pressable
                      key={m}
                      onPress={() => save({ bank_sync_minutes: m })}
                      style={[s.chip, { borderColor: on ? tokens.accent : tokens.border, backgroundColor: on ? tokens.accent : tokens.cardAlt }]}
                    >
                      <Text style={{ color: on ? tokens.accentText : tokens.text, fontFamily: fontFamily.semibold, fontSize: 13 }}>
                        {t(m === 10 ? 'more.every10' : m === 15 ? 'more.every15' : 'more.every60')}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={hint}>{t('more.syncEveryHint')}</Text>
            </View>
          </View>

          <Text style={lab}>{t('more.notifyTitle')}</Text>
          <Toggle on={account.bank_notify_push} label={t('more.notifyPush')} onPress={() => save({ bank_notify_push: !account.bank_notify_push })} />
          <Text style={hint}>{t('more.notifyPushHint')}</Text>
          <Toggle on={account.bank_notify_daily} label={t('more.notifyDaily')} onPress={() => save({ bank_notify_daily: !account.bank_notify_daily })} />

          <Pressable onPress={toggleRules} style={[s.rulesBtn, { borderColor: tokens.border }]}>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 13 }}>{t('more.rulesBtn').replace('{n}', String(ruleCount))}</Text>
          </Pressable>
          {showRules && (
            <View style={{ gap: 6 }}>
              <Text style={hint}>{t('more.rulesHint')}</Text>
              {rules?.length === 0 && <Text style={hint}>{t('more.rulesEmpty')}</Text>}
              {rules?.map((r) => (
                <View key={r.id} style={[s.ruleRow, { borderColor: tokens.border, backgroundColor: tokens.cardAlt }]}>
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.semibold, fontSize: 13, flex: 1 }}>
                    {r.match_key} → {r.categories?.name ?? '—'} ({r.uses}×)
                  </Text>
                  <Pressable
                    onPress={async () => {
                      await supabase.from('bank_rules').delete().eq('id', r.id);
                      setRules((p) => (p ?? []).filter((x) => x.id !== r.id));
                      setRuleCount((n) => Math.max(0, n - 1));
                    }}
                    style={s.forget}
                  >
                    <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.bold, fontSize: 12 }}>{t('more.rulesForget')}</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}
        </>
      )}
      {error && <Text style={{ color: tokens.coral, fontFamily: fontFamily.semibold, fontSize: 12.5 }}>{error}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { width: '100%', marginTop: 14, paddingTop: 14, borderTopWidth: 1, gap: 10 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  option: { flexGrow: 1, flexBasis: 240, flexDirection: 'row', gap: 12, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, marginTop: 1, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  pair: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { height: 44, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  rulesBtn: { alignSelf: 'flex-start', height: 44, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  ruleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 10, paddingLeft: 12, paddingRight: 4, minHeight: 44 },
  forget: { minWidth: 44, height: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
});
