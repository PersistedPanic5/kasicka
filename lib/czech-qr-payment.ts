/**
 * Czech domestic payment QR code (SPD 1.0 / "QR Platba" standard) — ported
 * from the old app's PaymentService.gs, see budgetor-current-app-analysis.md
 * "Feature: long-term/reserve payments + Czech QR codes". Two pieces:
 *
 * 1. Build a Czech IBAN from the local bank-account fields our schema
 *    stores (bank_code / account_prefix / account_number) via the
 *    standard ISO 7064 MOD97-10 check-digit algorithm — the same one
 *    every bank uses, not something Czech-specific in itself.
 * 2. Assemble the SPD payload a Czech banking app's QR scanner reads to
 *    pre-fill a payment, and encode that as a QR code (see the `QRCode`
 *    render in app/d/[token].tsx via react-native-qrcode-svg).
 */

function mod97(numericString: string): number {
  let remainder = numericString;
  while (remainder.length > 2) {
    const chunk = remainder.slice(0, 9);
    remainder = String(parseInt(chunk, 10) % 97) + remainder.slice(chunk.length);
  }
  return parseInt(remainder, 10) % 97;
}

/**
 * bankCode: 4 digits. accountNumber: up to 10 digits. accountPrefix:
 * optional up to 6 digits (many Czech accounts don't have one — treated
 * as all zeros, same as the account_prefix column's convention).
 */
export function czechIBAN(bankCode: string, accountNumber: string, accountPrefix?: string | null): string {
  const bank = bankCode.padStart(4, '0');
  const prefix = (accountPrefix ?? '').padStart(6, '0');
  const number = accountNumber.padStart(10, '0');
  const bban = `${bank}${prefix}${number}`; // 20 digits total

  // ISO 7064 MOD97-10: move the country code letters (C=12, Z=35) plus a
  // "00" check-digit placeholder to the end of the BBAN, then the whole
  // thing mod 97 gives the check digits as 98 - remainder.
  const remainder = mod97(`${bban}123500`);
  const checkDigits = String(98 - remainder).padStart(2, '0');
  return `CZ${checkDigits}${bban}`;
}

function sanitizeForSpd(s: string): string {
  // The SPD spec permits UTF-8, but plain ASCII is by far the safest
  // choice across real banking-app QR scanners — strip diacritics rather
  // than drop the message entirely.
  // NFD splits an accented letter into base + combining mark (e.g. "č" ->
  // "c" + U+030C); stripping everything outside ASCII then drops just the
  // marks and leaves the plain base letters.
  return s
    .normalize('NFD')
    .replace(/[^\x00-\x7F]/g, '')
    .trim();
}

/** Builds the SPD 1.0 payload string to encode into the QR code. */
export function buildSpdPayload(params: {
  iban: string;
  amount: number;
  message?: string;
  variableSymbol?: string;
}): string {
  const parts = ['SPD*1.0', `ACC:${params.iban}`, `AM:${params.amount.toFixed(2)}`, 'CC:CZK'];
  const message = params.message ? sanitizeForSpd(params.message) : '';
  if (message) parts.push(`MSG:${message.slice(0, 60)}`);
  if (params.variableSymbol) parts.push(`X-VS:${params.variableSymbol}`);
  return parts.join('*');
}
