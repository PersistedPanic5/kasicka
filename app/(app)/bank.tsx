import { createElement, useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/lib/theme-context';
import { fontFamily } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';
import { useAppData } from '@/lib/use-app-data';
import { useLanguage } from '@/lib/language-context';
import { BANK_COLUMNS, dayLabel, formatKc, isPlain, syncBank, useBankPending } from '@/lib/bank';
import { categoryColor } from '@/lib/identity';
import { MatchSheet, ReviewCard, type BankRow } from '@/components/BankReview';
import { TransactionEditor, type TransactionRow } from '@/components/TransactionEditor';

type Entry = { transaction_date: string; note: string | null; amount: number; category: string | null };
const SAVED = ['POSTED', 'LINKED', 'TRANSFER', 'IGNORED', 'DEBT'];

/**
 * The Bank inbox (claude/fio-everyday-mode-v1.md, Design: "Kasička Bank
 * Inbox Screens"). Movements the check-fio-payments function copied from
 * Fio wait here until Pavel confirms each one — nothing is auto-posted.
 *  - phone: list of cards; tap one to review it full-screen, one at a time
 *  - desktop: table with inline category/event pickers and bulk save
 * Own transfers and cash withdrawals are just marked (no transaction is
 * created), so they never touch a budget.
 */
export default function Bank() {
  const { tokens } = useTheme();
  const { t, language } = useLanguage();
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const { categories, accounts, activeEvents, monthStartDay } = useAppData();
  const pending = useBankPending();

  const [tab, setTab] = useState<'review' | 'saved'>('review');
  const [items, setItems] = useState<BankRow[]>([]);
  const [counts, setCounts] = useState({ review: 0, saved: 0 });
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [loading, setLoading] = useState(true);

  // per-row choices on the desktop table
  const [cat, setCat] = useState<Record<string, string | null>>({});
  const [ev, setEv] = useState<Record<string, string | null>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dismissedMatch, setDismissedMatch] = useState<Set<string>>(new Set());
  const [matchRow, setMatchRow] = useState<BankRow | null>(null);

  // phone review flow
  const [queue, setQueue] = useState<string[] | null>(null);
  const [pos, setPos] = useState(0);
  const [editor, setEditor] = useState<{ tx: TransactionRow; split: boolean } | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const accountName = useCallback((id: string | null) => accounts.find((a) => a.id === id)?.name ?? '', [accounts]);
  const inboxAccounts = accounts.filter((a) => a.entry_mode === 'BANK_INBOX');
  const lastChecked = inboxAccounts.map((a) => a.fio_last_success_at).filter(Boolean).sort().pop();

  const load = useCallback(async () => {
    if (!user) return;
    const statuses = tab === 'review' ? ['NEW'] : SAVED;
    const [list, nNew, nSaved] = await Promise.all([
      supabase
        .from('bank_transactions')
        .select(BANK_COLUMNS)
        .in('status', statuses)
        .order('booked_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(tab === 'review' ? 300 : 80),
      supabase.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('status', 'NEW'),
      supabase.from('bank_transactions').select('id', { count: 'exact', head: true }).in('status', SAVED),
    ]);
    const rows = (list.data ?? []) as unknown as BankRow[];
    setItems(rows);
    setCounts({ review: nNew.count ?? 0, saved: nSaved.count ?? 0 });

    const ids = rows.map((r) => r.match_transaction_id).filter((x): x is string => !!x);
    if (ids.length) {
      const { data } = await supabase.from('transactions').select('id, transaction_date, note, amount, categories(name)').in('id', ids);
      const map: Record<string, Entry> = {};
      for (const row of (data ?? []) as unknown as (Entry & { id: string; categories: { name: string } | null })[]) {
        map[row.id] = { transaction_date: row.transaction_date, note: row.note, amount: Number(row.amount), category: row.categories?.name ?? null };
      }
      setEntries(map);
    }
    if (tab === 'review') {
      setCat((prev) => {
        const next = { ...prev };
        for (const r of rows) if (!(r.id in next)) next[r.id] = r.suggested_category_id;
        return next;
      });
      setSelected((prev) => {
        // first load: pre-select what has a suggested category and no pending match question
        if (prev.size) return new Set([...prev].filter((id) => rows.some((r) => r.id === id)));
        return new Set(rows.filter((r) => r.amount < 0 && r.kind === 'EXPENSE' && r.suggested_category_id && !r.match_transaction_id).map((r) => r.id));
      });
    }
    setLoading(false);
  }, [user, tab]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const sync = useCallback(
    async (manual: boolean) => {
      setSyncing(true);
      const r = await syncBank();
      setSyncing(false);
      if (r.error) setMsg(t('bank.syncProblem').replace('{error}', r.error));
      else if (r.added) setMsg(t('bank.syncAdded').replace('{n}', String(r.added)));
      else if (manual) setMsg(r.throttled ? t('bank.syncThrottled') : t('bank.syncNothing'));
      else setMsg(null);
      if (r.added || manual) {
        load();
        pending.refresh();
      }
    },
    [load, pending, t],
  );

  // check the bank once when the screen opens (same idea as the Debts page)
  useEffect(() => {
    if (user) sync(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const refreshAll = () => {
    load();
    pending.refresh();
  };

  // ── actions (all go through the bank_* SQL functions) ───────────────────
  const post = async (r: BankRow, categoryId: string | null, eventId: string | null, note = '') => {
    const { data, error } = await supabase.rpc('bank_post', { p_id: r.id, p_category_id: categoryId, p_event_id: eventId, p_note: note.trim() || null });
    if (error) throw error;
    return data as string;
  };
  const decide = async (r: BankRow, status: 'IGNORED' | 'TRANSFER' | 'NEW', to: string | null = null) => {
    const { error } = await supabase.rpc('bank_decide', { p_id: r.id, p_status: status, p_to_account: to });
    if (error) throw error;
  };
  const link = async (r: BankRow) => {
    if (!r.match_transaction_id) return;
    const { error } = await supabase.rpc('bank_link', { p_id: r.id, p_transaction_id: r.match_transaction_id });
    if (error) throw error;
  };
  async function guarded(fn: () => Promise<void>) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch {
      setMsg(t('bank.saveFailed'));
    }
    setBusy(false);
    refreshAll();
  }

  // ── desktop bulk ────────────────────────────────────────────────────────
  const selRows = items.filter((r) => selected.has(r.id) && isPlain(r));
  const selNeed = selRows.filter((r) => r.amount < 0 && !cat[r.id]).length;
  const toggle = (id: string) =>
    setSelected((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const saveSelected = () =>
    guarded(async () => {
      for (const r of selRows) if (r.amount > 0 || cat[r.id]) await post(r, r.amount < 0 ? cat[r.id] : null, ev[r.id] ?? null);
      setSelected(new Set());
    });
  const ignoreSelected = () =>
    guarded(async () => {
      for (const r of items.filter((x) => selected.has(x.id))) await decide(r, 'IGNORED');
      setSelected(new Set());
    });

  // ── phone ───────────────────────────────────────────────────────────────
  const suggested = items.filter((r) => r.kind === 'EXPENSE' && r.amount < 0 && r.suggested_category_id && !r.match_transaction_id);
  const saveSuggested = () =>
    guarded(async () => {
      for (const r of suggested) await post(r, r.suggested_category_id, null);
    });

  const queued = queue ? queue.map((id) => items.find((r) => r.id === id)).filter((r): r is BankRow => !!r) : [];
  const current = queue ? queued[Math.min(pos, queued.length - 1)] : null;
  function leave(id: string) {
    setQueue((q) => {
      const rest = (q ?? []).filter((x) => x !== id);
      return rest.length ? rest : null;
    });
  }
  function startReview(id: string) {
    const ids = items.filter(isPlain).map((r) => r.id);
    setQueue(ids);
    setPos(Math.max(0, ids.indexOf(id)));
  }

  const when = (iso: string) => new Date(iso).toLocaleTimeString(language === 'cs' ? 'cs-CZ' : 'en-GB', { hour: '2-digit', minute: '2-digit' });

  // ───────────────────────────────────────────────────────────────────────
  if (queue && current) {
    const dismissed = dismissedMatch.has(current.id);
    const entry = current.match_transaction_id ? entries[current.match_transaction_id] ?? null : null;
    return (
      <>
        <ReviewCard
          key={current.id}
          row={current}
          index={Math.min(pos, queued.length - 1)}
          total={queued.length}
          categories={categories}
          events={activeEvents}
          onBack={() => {
            setQueue(null);
            refreshAll();
          }}
          onSave={async (c, e, n) => {
            await post(current, c, e, n);
            leave(current.id);
            refreshAll();
          }}
          onSaveAndEdit={async (c, e, n, split) => {
            const txId = await post(current, c, e, n);
            const { data } = await supabase
              .from('transactions')
              .select('id, transaction_date, type, amount, note, status, category_id, account_id, event_id, receipt_photo_url, categories(name)')
              .eq('id', txId)
              .maybeSingle();
            leave(current.id);
            refreshAll();
            if (data) setEditor({ tx: data as unknown as TransactionRow, split });
          }}
          onOwnTransfer={() => guarded(async () => {
            await decide(current, 'TRANSFER', current.suggested_account_id);
            leave(current.id);
          })}
          onIgnore={() => guarded(async () => {
            await decide(current, 'IGNORED');
            leave(current.id);
          })}
          onSkip={() => (pos + 1 >= queued.length ? setQueue(null) : setPos(pos + 1))}
        />
        {current.match_transaction_id && !dismissed && (
          <MatchSheet
            row={current}
            entry={entry}
            busy={busy}
            onYes={() => guarded(async () => {
              await link(current);
              leave(current.id);
            })}
            onNo={() => setDismissedMatch((p) => new Set(p).add(current.id))}
          />
        )}
        {editor && (
          <TransactionEditor
            transaction={editor.tx}
            categories={categories}
            accounts={accounts}
            events={activeEvents}
            monthStartDay={monthStartDay}
            expandSplit={editor.split}
            onClose={() => setEditor(null)}
            onChanged={() => {}}
          />
        )}
      </>
    );
  }

  const review = tab === 'review';
  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        {/* header */}
        <View style={s.headRow}>
          <View style={{ gap: 4, flexShrink: 1 }}>
            <Text style={{ color: tokens.text, fontFamily: fontFamily.extrabold, fontSize: wide ? 30 : 22, letterSpacing: -0.5 }}>{t('bank.title')}</Text>
            <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 14 }}>
              {inboxAccounts.map((a) => a.name).join(', ')}
              {inboxAccounts.length ? ' · ' : ''}
              {lastChecked ? t('bank.lastChecked').replace('{when}', when(lastChecked)) : t('bank.neverChecked')}
            </Text>
          </View>
          <Pressable onPress={() => sync(true)} disabled={syncing} style={[s.syncBtn, { borderColor: tokens.border, opacity: syncing ? 0.6 : 1 }]}>
            <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={tokens.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M20 11a8 8 0 00-14-4.5L4 9M4 4v5h5M4 13a8 8 0 0014 4.5L20 15M20 20v-5h-5" />
            </Svg>
            {wide && <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 14 }}>{syncing ? t('bank.syncing') : t('bank.syncNow')}</Text>}
          </Pressable>
        </View>

        <View style={[s.seg, { backgroundColor: tokens.card }]}>
          {(['review', 'saved'] as const).map((k) => (
            <Pressable key={k} onPress={() => setTab(k)} style={[s.segBtn, { backgroundColor: tab === k ? tokens.accent : 'transparent' }]}>
              <Text style={{ color: tab === k ? tokens.accentText : tokens.textMuted, fontFamily: tab === k ? fontFamily.extrabold : fontFamily.bold, fontSize: 14 }}>
                {k === 'review' ? t('bank.tabReview') : t('bank.tabSaved')} · {k === 'review' ? counts.review : counts.saved}
              </Text>
            </Pressable>
          ))}
        </View>
        {msg && <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 13 }}>{msg}</Text>}

        {!loading && !pending.enabled && (
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 14, lineHeight: 20 }}>{t('bank.noInboxAccount')}</Text>
        )}
        {!loading && pending.enabled && items.length === 0 && (
          <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.medium, fontSize: 14, lineHeight: 20 }}>
            {review ? t('bank.emptyReview') : t('bank.emptySaved')}
          </Text>
        )}

        {/* saved: same list on every width */}
        {!review && items.length > 0 && (
          <View style={[s.panel, { backgroundColor: tokens.cardAlt, borderColor: tokens.border }]}>
            {items.map((r, i) => (
              <View key={r.id} style={[s.savedRow, i < items.length - 1 && { borderBottomWidth: 1, borderBottomColor: tokens.border }]}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[s.name, { color: tokens.text }]}>{r.merchant}</Text>
                  <Text style={[s.sub, { color: tokens.textMuted }]}>
                    {dayLabel(r.booked_date, t)} · {statusText(r, t, accountName)}
                  </Text>
                </View>
                <Text style={[s.amt, { color: r.amount < 0 ? tokens.text : tokens.greenFg }]}>{formatKc(r.amount)}</Text>
                {(r.status === 'IGNORED' || r.status === 'TRANSFER') && (
                  <Pressable onPress={() => guarded(() => decide(r, 'NEW'))} style={[s.ghost, { borderColor: tokens.border }]}>
                    <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 13 }}>{t('bank.putBack')}</Text>
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        )}

        {/* review, desktop table */}
        {review && wide && items.length > 0 && (
          <View style={[s.panel, { backgroundColor: tokens.cardAlt, borderColor: tokens.border }]}>
            <View style={[s.tr, { backgroundColor: tokens.card }]}>
              <Check on={items.every((r) => selected.has(r.id))} onPress={() => setSelected(items.every((r) => selected.has(r.id)) ? new Set() : new Set(items.map((r) => r.id)))} label="all" tokens={tokens} />
              <Text style={[s.th, { color: tokens.textMuted, width: 96 }]}>{t('bank.colDate')}</Text>
              <Text style={[s.th, { color: tokens.textMuted, flex: 1 }]}>{t('bank.colPayment')}</Text>
              <Text style={[s.th, { color: tokens.textMuted, width: 180 }]}>{t('bank.colCategory')}</Text>
              <Text style={[s.th, { color: tokens.textMuted, width: 180 }]}>{t('bank.colEvent')}</Text>
              <Text style={[s.th, { color: tokens.textMuted, width: 100, textAlign: 'right' }]}>{t('bank.colAmount')}</Text>
              <View style={{ width: 150 }} />
            </View>
            {items.map((r, i) => {
              const special = r.kind === 'TRANSFER' || r.kind === 'CASH' || r.kind === 'INCOME';
              const hasMatch = !!r.match_transaction_id && !dismissedMatch.has(r.id);
              const bg = r.kind === 'INCOME' ? tokens.greenBg : r.kind === 'TRANSFER' || r.kind === 'CASH' || (r.amount < 0 && !cat[r.id]) ? tokens.amberBg : 'transparent';
              return (
                <View key={r.id} style={[s.tr, { backgroundColor: bg, borderTopWidth: i ? 1 : 0, borderTopColor: tokens.border }]}>
                  <Check on={selected.has(r.id)} onPress={() => toggle(r.id)} label={r.merchant} tokens={tokens} />
                  <Text style={[s.date, { color: tokens.text, width: 96 }]}>{dayLabel(r.booked_date, t)}</Text>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={[s.name, { color: tokens.text }]}>{r.merchant}</Text>
                    <Text style={[s.sub, { color: tokens.textMuted }]}>{subLine(r, t, accountName)}</Text>
                  </View>
                  <View style={{ width: 180 }}>
                    {r.amount < 0 && !special ? (
                      <Select
                        tokens={tokens}
                        label={t('bank.colCategory')}
                        value={cat[r.id] ?? ''}
                        warn={!cat[r.id]}
                        onChange={(v) => setCat((p) => ({ ...p, [r.id]: v || null }))}
                        options={[{ id: '', name: t('bank.chooseCategory') }, ...categories.map((c) => ({ id: c.id, name: c.name }))]}
                      />
                    ) : (
                      <Text style={[s.sub, { color: tokens.textMuted }]}>
                        {r.kind === 'INCOME' ? t('bank.income') : t('bank.notAnExpense')}
                      </Text>
                    )}
                  </View>
                  <View style={{ width: 180 }}>
                    {!special && activeEvents.length > 0 ? (
                      <Select
                        tokens={tokens}
                        label={t('bank.colEvent')}
                        value={ev[r.id] ?? ''}
                        onChange={(v) => setEv((p) => ({ ...p, [r.id]: v || null }))}
                        options={[{ id: '', name: t('bank.noEvent') }, ...activeEvents.map((e) => ({ id: e.id, name: e.name }))]}
                      />
                    ) : special ? (
                      <Pressable onPress={() => (r.kind === 'INCOME' ? guarded(() => decide(r, 'IGNORED')) : asExpense(r))}>
                        <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 13, textDecorationLine: 'underline' }}>{altLabel(r, t)}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <Text style={[s.amt, { color: r.amount < 0 ? tokens.text : tokens.greenFg, width: 100, textAlign: 'right' }]}>{formatKc(r.amount)}</Text>
                  <View style={{ width: 150 }}>
                    <Pressable
                      disabled={busy || (r.kind === 'EXPENSE' && !hasMatch && !cat[r.id])}
                      onPress={() => {
                        if (hasMatch) return setMatchRow(r);
                        guarded(async () => {
                          if (r.kind === 'TRANSFER' || r.kind === 'CASH') await decide(r, 'TRANSFER', r.suggested_account_id);
                          else await post(r, r.amount < 0 ? cat[r.id] : null, ev[r.id] ?? null);
                        });
                      }}
                      style={[s.go, { borderColor: tokens.accentBorder, backgroundColor: tokens.cardAlt, opacity: busy || (r.kind === 'EXPENSE' && !hasMatch && !cat[r.id]) ? 0.45 : 1 }]}
                    >
                      <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 14 }}>{primaryLabel(r, hasMatch, t)}</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
            <View style={[s.bulk, { backgroundColor: tokens.card, borderTopColor: tokens.border }]}>
              <Text style={{ color: tokens.textMuted, fontFamily: fontFamily.semibold, fontSize: 14, flexShrink: 1 }}>
                {selNeed
                  ? t('bank.selectedNeed').replace('{n}', String(selRows.length)).replace('{m}', String(selNeed))
                  : t('bank.selectedOk').replace('{n}', String(selRows.length))}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Pressable onPress={ignoreSelected} disabled={!selected.size || busy} style={[s.ghostBig, { borderColor: tokens.border, opacity: selected.size ? 1 : 0.45 }]}>
                  <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 14 }}>{t('bank.ignoreSelected')}</Text>
                </Pressable>
                <Pressable onPress={saveSelected} disabled={!selRows.length || busy} style={[s.solid, { backgroundColor: tokens.accent, opacity: selRows.length && !busy ? 1 : 0.45 }]}>
                  <Text style={{ color: tokens.accentText, fontFamily: fontFamily.extrabold, fontSize: 15 }}>
                    {t('bank.saveSelected').replace('{n}', String(selRows.length - selNeed))}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        )}

        {/* review, phone list */}
        {review && !wide && items.length > 0 && (
          <View style={[s.panel, { backgroundColor: tokens.cardAlt, borderColor: tokens.border }]}>
            {items.map((r, i) => {
              const plain = isPlain(r) && r.kind !== 'INCOME';
              const bg = r.kind === 'INCOME' ? tokens.greenBg : r.kind === 'TRANSFER' || r.kind === 'CASH' ? tokens.amberBg : 'transparent';
              const ci = categories.findIndex((c) => c.id === r.suggested_category_id);
              return (
                <Pressable
                  key={r.id}
                  disabled={!isPlain(r) || r.kind === 'INCOME'}
                  onPress={() => startReview(r.id)}
                  style={[s.row, { backgroundColor: bg }, i < items.length - 1 && { borderBottomWidth: 1, borderBottomColor: tokens.border }]}
                >
                  <View style={s.rowTop}>
                    {plain && r.suggested_category_id && !r.match_transaction_id ? (
                      <View style={[s.tick, { backgroundColor: tokens.accent }]}>
                        <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={tokens.accentText} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                          <Path d="M5 12l5 5 9-10" />
                        </Svg>
                      </View>
                    ) : null}
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={[s.name, { color: tokens.text }]}>{r.merchant}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        {plain && ci >= 0 && <View style={[s.dot, { backgroundColor: categoryColor(ci, tokens) }]} />}
                        <Text style={[s.sub, { color: tokens.textMuted, flexShrink: 1 }]}>{phoneSub(r, categories, t, accountName)}</Text>
                      </View>
                    </View>
                    <Text style={[s.amt, { color: r.amount < 0 ? tokens.text : tokens.greenFg }]}>{formatKc(r.amount)}</Text>
                  </View>
                  {(r.kind === 'TRANSFER' || r.kind === 'CASH' || r.kind === 'INCOME') && (
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <Pressable
                        disabled={busy}
                        onPress={() => guarded(async () => (r.kind === 'INCOME' ? void (await post(r, null, null)) : decide(r, 'TRANSFER', r.suggested_account_id)))}
                        style={[s.act, { borderColor: tokens.accentBorder, backgroundColor: tokens.cardAlt }]}
                      >
                        <Text style={{ color: tokens.accent, fontFamily: fontFamily.extrabold, fontSize: 14 }}>{primaryLabel(r, false, t)}</Text>
                      </Pressable>
                      <Pressable
                        disabled={busy}
                        onPress={() => (r.kind === 'INCOME' ? guarded(() => decide(r, 'IGNORED')) : startAsExpense(r))}
                        style={[s.act, { borderColor: tokens.border }]}
                      >
                        <Text style={{ color: tokens.text, fontFamily: fontFamily.bold, fontSize: 14 }}>{altLabel(r, t)}</Text>
                      </Pressable>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>

      {review && !wide && suggested.length > 0 && (
        <Pressable onPress={saveSuggested} disabled={busy} style={[s.solidBig, { backgroundColor: tokens.accent, opacity: busy ? 0.6 : 1 }]}>
          <Text style={{ color: tokens.accentText, fontFamily: fontFamily.extrabold, fontSize: 16 }}>
            {t('bank.saveSuggested').replace('{n}', String(suggested.length))}
          </Text>
        </Pressable>
      )}

      {matchRow && (
        <MatchSheet
          row={matchRow}
          entry={matchRow.match_transaction_id ? entries[matchRow.match_transaction_id] ?? null : null}
          busy={busy}
          onYes={() => guarded(async () => {
            await link(matchRow);
            setMatchRow(null);
          })}
          onNo={() => {
            setDismissedMatch((p) => new Set(p).add(matchRow.id));
            setMatchRow(null);
          }}
        />
      )}
    </View>
  );

  // "It's an expense" / "It's spending": treat the row as a normal payment (local only —
  // nothing changes in the database until it is saved with a category).
  function asExpense(r: BankRow) {
    setItems((prev) => prev.map((x) => (x.id === r.id ? { ...x, kind: 'EXPENSE' } : x)));
  }
  function startAsExpense(r: BankRow) {
    asExpense(r);
    setQueue([r.id]);
    setPos(0);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────
type T = (p: string) => string;

function primaryLabel(r: BankRow, hasMatch: boolean, t: T) {
  if (hasMatch) return t('bank.matchReview');
  if (r.kind === 'TRANSFER') return t('bank.markTransfer');
  if (r.kind === 'CASH') return t('bank.moveToCash');
  if (r.kind === 'INCOME') return t('bank.addIncome');
  return t('bank.save');
}
function altLabel(r: BankRow, t: T) {
  return r.kind === 'TRANSFER' ? t('bank.itsExpense') : r.kind === 'CASH' ? t('bank.itsSpending') : t('bank.notIncome');
}
function subLine(r: BankRow, t: T, accountName: (id: string | null) => string) {
  if (r.kind === 'TRANSFER') return t('bank.looksOwn').replace('{account}', accountName(r.suggested_account_id) || '—');
  if (r.kind === 'CASH') return t('bank.cashWithdrawal');
  if (r.kind === 'INCOME') return t('bank.incomingPayment');
  const bits = [r.details && r.details !== r.merchant ? r.details : null, r.movement_type?.toLowerCase().includes('kart') ? t('bank.card') : null];
  if (r.recurring_item_id) bits.push(t('bank.repeats'));
  else if (!r.suggested_category_id) bits.push(t('bank.newMerchant'));
  return bits.filter(Boolean).join(' · ');
}
function phoneSub(r: BankRow, categories: { id: string; name: string }[], t: T, accountName: (id: string | null) => string) {
  if (r.kind !== 'EXPENSE') return `${subLine(r, t, accountName)} · ${dayLabel(r.booked_date, t)}`;
  const c = categories.find((x) => x.id === r.suggested_category_id);
  return `${c ? c.name : t('bank.chooseCategory')} · ${dayLabel(r.booked_date, t)}`;
}
function statusText(r: BankRow, t: T, accountName: (id: string | null) => string) {
  if (r.status === 'TRANSFER') return r.to_account_id ? t('bank.statusMovedTo').replace('{account}', accountName(r.to_account_id)) : t('bank.statusTransfer');
  return { POSTED: t('bank.statusPosted'), LINKED: t('bank.statusLinked'), IGNORED: t('bank.statusIgnored'), DEBT: t('bank.statusDebt') }[r.status as 'POSTED'] ?? r.status;
}

function Check({ on, onPress, label, tokens }: { on: boolean; onPress: () => void; label: string; tokens: ReturnType<typeof useTheme>['tokens'] }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={label} style={s.checkWrap}>
      <View style={[s.check, { borderColor: on ? tokens.accent : tokens.border, backgroundColor: on ? tokens.accent : tokens.cardAlt }]}>
        {on && (
          <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={tokens.accentText} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M5 12l5 5 9-10" />
          </Svg>
        )}
      </View>
    </Pressable>
  );
}

/** Native <select> (web). Same trick TransactionEditor uses for its file input. */
function Select({
  value,
  options,
  onChange,
  label,
  warn,
  tokens,
}: {
  value: string;
  options: { id: string; name: string }[];
  onChange: (v: string) => void;
  label: string;
  warn?: boolean;
  tokens: ReturnType<typeof useTheme>['tokens'];
}) {
  return createElement(
    'select',
    {
      value,
      'aria-label': label,
      // deno-lint-ignore no-explicit-any
      onChange: (e: any) => onChange(e.target.value),
      style: {
        width: '100%',
        height: 44,
        borderRadius: 12,
        border: `1px solid ${warn ? tokens.amberFg : tokens.border}`,
        background: tokens.bg,
        color: warn ? tokens.amberFg : tokens.text,
        fontFamily: fontFamily.semibold,
        fontSize: 14,
        padding: '0 10px',
      },
    },
    ...options.map((o) => createElement('option', { key: o.id || 'none', value: o.id }, o.name)),
  );
}

const s = StyleSheet.create({
  headRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
  syncBtn: { height: 44, minWidth: 44, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  seg: { flexDirection: 'row', gap: 4, borderRadius: 14, padding: 4, alignSelf: 'flex-start' },
  segBtn: { height: 40, borderRadius: 10, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  panel: { borderWidth: 1, borderRadius: 18, overflow: 'hidden' },
  tr: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 64 },
  th: { fontFamily: fontFamily.bold, fontSize: 13 },
  date: { fontFamily: fontFamily.semibold, fontSize: 13 },
  name: { fontFamily: fontFamily.extrabold, fontSize: 15 },
  sub: { fontFamily: fontFamily.medium, fontSize: 13 },
  amt: { fontFamily: fontFamily.extrabold, fontSize: 15 },
  go: { height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  checkWrap: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -10 },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  bulk: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 1 },
  ghostBig: { height: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  ghost: { height: 44, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  solid: { height: 48, borderRadius: 12, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  solidBig: { height: 54, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  savedRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  row: { paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  tick: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  act: { height: 44, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
});
