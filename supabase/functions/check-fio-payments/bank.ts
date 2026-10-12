// Pure helpers for check-fio-payments: parsing Fio's JSON and deciding what
// each movement probably is. No I/O here so bank.test.ts can run it with
// plain bun/node (see README.md).

export interface FioTx {
  id: string; // movement ID (column22) — the only safe dedupe key
  date: string; // yyyy-mm-dd booked date
  amount: number; // signed: positive = incoming
  currency: string;
  vs: string;
  counterAccount: string;
  counterBank: string;
  counterName: string;
  type: string; // column8, e.g. "Platba kartou", "Výběr z bankomatu"
  message: string;
  details: string; // column18 "Upřesnění" (card payments carry the merchant here)
  comment: string;
}

// deno-lint-ignore no-explicit-any
export function parseFio(body: any): FioTx[] {
  const list = body?.accountStatement?.transactionList?.transaction ?? [];
  // deno-lint-ignore no-explicit-any
  const v = (c: any) => (c?.value == null ? '' : String(c.value));
  // deno-lint-ignore no-explicit-any
  return list.map((t: any): FioTx => ({
    id: v(t.column22),
    date: v(t.column0).slice(0, 10), // "2026-10-12+0200" -> "2026-10-12"
    amount: Number(t.column1?.value),
    currency: v(t.column14),
    vs: v(t.column5),
    counterAccount: v(t.column2),
    counterBank: v(t.column3),
    counterName: v(t.column10),
    type: v(t.column8),
    message: v(t.column16),
    details: v(t.column18),
    comment: v(t.column25),
  })).filter((t: FioTx) => t.id && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && Number.isFinite(t.amount));
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "ALBERT PRAHA 1042" -> "Albert Praha"; mixed-case text is left alone. */
export function pretty(raw: string): string {
  let s = clean(raw).replace(/(\s+\d+)+$/, '');
  if (s && s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());
  }
  return s;
}

/** The merchant text as the bank wrote it (before prettifying). */
export function rawMerchant(t: FioTx): string {
  // Card payments: "Nákup: ALBERT PRAHA 1042, PRAHA, CZ, dne 11.10.2026, ..."
  const m = /^(?:Nákup|Nakup|Platba kartou|Online platba)\s*:\s*([^,]+)/i.exec(t.details);
  if (m) return clean(m[1]);
  if (isAtm(t)) return clean(t.details.replace(/^[^:]*:\s*/, '').split(',')[0]) || 'ATM';
  return clean(t.counterName) || clean(t.message) || clean(t.comment) || clean(t.details) || clean(t.type) || 'Bank payment';
}

export const isAtm = (t: FioTx) => /bankomat/i.test(t.type) || /bankomat/i.test(t.details);

/** First two alphabetic words, lower-case — what bank_rules remember. */
export function merchantKey(merchant: string): string {
  return merchant
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
}

const digits = (s: string) => s.replace(/\D/g, '').replace(/^0+/, '');
const dayMs = 86_400_000;
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / dayMs;

export interface Ctx {
  /** the account being synced */
  accountId: string;
  /** all of the owner's active accounts (own-transfer + cash detection) */
  accounts: { id: string; account_type: string; account_number: string | null; bank_code: string | null }[];
  rules: Map<string, { category_id: string; uses: number }>;
  recurring: { id: string; name: string; amount: number; category_id: string }[];
  /** manual entries on this account not yet linked to a bank movement */
  manual: { id: string; transaction_date: string; type: string; amount: number }[];
  /** manual entries already offered to another movement in this run */
  taken: Set<string>;
}

export interface BankRow {
  movement_id: string;
  booked_date: string;
  amount: number;
  merchant: string;
  merchant_key: string;
  counter_account: string | null;
  counter_bank: string | null;
  movement_type: string | null;
  details: string | null;
  vs: string | null;
  kind: 'EXPENSE' | 'INCOME' | 'TRANSFER' | 'CASH';
  suggested_category_id: string | null;
  suggested_uses: number | null;
  suggested_account_id: string | null;
  recurring_item_id: string | null;
  match_transaction_id: string | null;
}

export function classify(t: FioTx, ctx: Ctx): BankRow {
  const raw = rawMerchant(t);
  const merchant = pretty(raw) || 'Bank payment';
  const key = merchantKey(merchant);
  const out = t.amount < 0;

  const row: BankRow = {
    movement_id: t.id,
    booked_date: t.date,
    amount: t.amount,
    merchant,
    merchant_key: key,
    counter_account: t.counterAccount || null,
    counter_bank: t.counterBank || null,
    movement_type: t.type || null,
    details: raw || null,
    vs: t.vs || null,
    kind: out ? 'EXPENSE' : 'INCOME',
    suggested_category_id: null,
    suggested_uses: null,
    suggested_account_id: null,
    recurring_item_id: null,
    match_transaction_id: null,
  };

  // Money moving between the owner's own accounts is not spending / income.
  const num = digits(t.counterAccount);
  const own = num
    ? ctx.accounts.find(
        (a) => a.id !== ctx.accountId && a.account_number && digits(a.account_number) === num && (a.bank_code ?? '') === t.counterBank,
      )
    : undefined;
  if (own) {
    row.kind = 'TRANSFER';
    row.suggested_account_id = own.id;
    return row;
  }
  if (out && isAtm(t)) {
    row.kind = 'CASH';
    row.suggested_account_id = ctx.accounts.find((a) => a.account_type === 'CASH')?.id ?? null;
    return row;
  }

  if (out) {
    const rule = key ? ctx.rules.get(key) : undefined;
    if (rule) {
      row.suggested_category_id = rule.category_id;
      row.suggested_uses = rule.uses;
    }
    const rec = ctx.recurring.find((r) => {
      const rk = merchantKey(r.name);
      return Math.abs(r.amount - Math.abs(t.amount)) <= 1 && rk && key && (key.includes(rk.split(' ')[0]) || rk.includes(key.split(' ')[0]));
    });
    if (rec) {
      row.recurring_item_id = rec.id;
      row.suggested_category_id ??= rec.category_id;
    }
  }

  // A manual entry that looks like this very payment (same amount, ±3 days).
  const wantType = out ? 'EXPENSE' : 'INCOME';
  let best: { id: string; d: number } | null = null;
  for (const m of ctx.manual) {
    if (ctx.taken.has(m.id) || m.type !== wantType || Math.abs(Number(m.amount) - Math.abs(t.amount)) > 0.005) continue;
    const d = dayDiff(m.transaction_date, t.date);
    if (d <= 3 && (!best || d < best.d)) best = { id: m.id, d };
  }
  if (best) {
    row.match_transaction_id = best.id;
    ctx.taken.add(best.id);
  }
  return row;
}
