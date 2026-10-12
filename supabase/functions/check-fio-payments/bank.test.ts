// Run:  bun supabase/functions/check-fio-payments/bank.test.ts
// One check for the classification logic: fake Fio JSON in, expected inbox rows out.
import { classify, merchantKey, parseFio, pretty, type Ctx } from './bank.ts';
import assert from 'node:assert/strict';

const col = (value: unknown) => ({ value });
const mv = (o: Record<string, unknown>) => ({
  column0: col(o.date ?? '2026-10-12+0200'),
  column1: col(o.amount),
  column2: o.acc ? col(o.acc) : null,
  column3: o.bank ? col(o.bank) : null,
  column5: o.vs ? col(o.vs) : null,
  column8: col(o.type ?? 'Platba kartou'),
  column10: o.name ? col(o.name) : null,
  column14: col('CZK'),
  column16: o.msg ? col(o.msg) : null,
  column18: o.spec ? col(o.spec) : null,
  column22: col(o.id),
});
const fio = {
  accountStatement: {
    transactionList: {
      transaction: [
        mv({ id: 1, amount: -486, spec: 'Nákup: ALBERT PRAHA 1042, PRAHA, CZ, dne 11.10.2026, částka 486.00 CZK' }),
        mv({ id: 2, amount: -5000, type: 'Bezhotovostní platba', acc: '0000004417', bank: '3030', name: 'Pavel Skuhrovec' }),
        mv({ id: 3, amount: -2000, type: 'Výběr z bankomatu', spec: 'Výběr z bankomatu: ATM Karlovo nám., Praha' }),
        mv({ id: 4, amount: 48200, type: 'Bezhotovostní příjem', name: 'Acme s.r.o.', vs: '123' }),
        mv({ id: 5, amount: -259, spec: 'Nákup: NETFLIX.COM, 800-000, NL' }),
        mv({ id: 6, amount: -92, spec: 'Nákup: PEKARNA U ZLATEHO, PRAHA' }),
      ],
    },
  },
};

const ctx = (): Ctx => ({
  accountId: 'fio',
  accounts: [
    { id: 'fio', account_type: 'BANK', account_number: '2701234567', bank_code: '2010' },
    { id: 'air', account_type: 'BANK', account_number: '4417', bank_code: '3030' },
    { id: 'cash', account_type: 'CASH', account_number: null, bank_code: null },
  ],
  rules: new Map([['albert praha', { category_id: 'food', uses: 11 }]]),
  recurring: [{ id: 'nf', name: 'Netflix', amount: 259, category_id: 'fun' }],
  manual: [
    { id: 'm1', transaction_date: '2026-10-12', type: 'EXPENSE', amount: 486 }, // same amount, 0 days
    { id: 'm2', transaction_date: '2026-10-01', type: 'EXPENSE', amount: 92 }, // too far away
  ],
  taken: new Set(),
});

const rows = parseFio(fio).map((t, _i, _a) => t);
assert.equal(rows.length, 6);
assert.equal(rows[0].date, '2026-10-12');

const c = ctx();
const [albert, transfer, atm, income, netflix, bakery] = rows.map((t) => classify(t, c));

assert.equal(albert.merchant, 'Albert Praha');
assert.equal(albert.kind, 'EXPENSE');
assert.equal(albert.suggested_category_id, 'food'); // remembered merchant
assert.equal(albert.suggested_uses, 11);
assert.equal(albert.match_transaction_id, 'm1'); // manual entry offered for linking
assert.equal(transfer.kind, 'TRANSFER'); // counter-account is the owner's Air Bank
assert.equal(transfer.suggested_account_id, 'air');
assert.equal(atm.kind, 'CASH');
assert.equal(atm.suggested_account_id, 'cash');
assert.equal(income.kind, 'INCOME');
assert.equal(netflix.recurring_item_id, 'nf'); // matches the recurring item
assert.equal(netflix.suggested_category_id, 'fun');
assert.equal(bakery.match_transaction_id, null); // 11 days away: not offered
assert.equal(bakery.suggested_category_id, null);

// the same manual entry is never offered to two movements
const dup = ctx();
const twice = parseFio({ accountStatement: { transactionList: { transaction: [mv({ id: 7, amount: -486, spec: 'Nákup: A' }), mv({ id: 8, amount: -486, spec: 'Nákup: B' })] } } });
const [x, y] = twice.map((t) => classify(t, dup));
assert.equal(x.match_transaction_id, 'm1');
assert.equal(y.match_transaction_id, null);

assert.equal(pretty('ALBERT PRAHA 1042'), 'Albert Praha');
assert.equal(pretty('Rohlik.cz'), 'Rohlik.cz');
assert.equal(merchantKey('Albert Praha'), 'albert praha');
console.log('bank.test.ts: ok');
