/**
 * Shared logic for Debts page's "select two-or-more and merge" action
 * (Pavel: "suddenly I have one person with like 3 bills and I need to
 * share 3 links with them") — see app/(app)/debts.tsx. Combines several
 * debts into a single new one: amounts sum plainly, but the message needs
 * more care since it becomes the QR code's payment message.
 */

// lib/czech-qr-payment.ts's buildSpdPayload() truncates the SPD MSG field
// to 60 chars at encode time regardless — this mirrors that limit so the
// merge preview Pavel reviews before confirming already reflects what will
// actually end up on the QR code, rather than getting silently chopped
// later without him seeing it happen.
const QR_MESSAGE_LIMIT = 60;
const SEPARATOR = ' + ';

/**
 * Pavel's spec: "if it fits in the message, then fit in, if all texts
 * would be too long, then connect the beginnings of the messages and
 * shorten so we can fit into the QR code limit." Empty/null messages are
 * dropped rather than contributing blank segments.
 */
export function mergeDebtMessages(messages: (string | null | undefined)[]): string {
  const clean = messages.map((m) => (m ?? '').trim()).filter(Boolean);
  if (clean.length === 0) return '';

  const joined = clean.join(SEPARATOR);
  if (joined.length <= QR_MESSAGE_LIMIT) return joined;

  // Doesn't fit whole — give every message an equal-ish character budget
  // (rather than keeping the first in full and dropping the rest) so the
  // merged message still reads as "a bit of everything", truncated with an
  // ellipsis wherever a piece had to be cut.
  const separatorBudget = SEPARATOR.length * (clean.length - 1);
  const perMessageBudget = Math.max(Math.floor((QR_MESSAGE_LIMIT - separatorBudget) / clean.length), 1);
  const shortened = clean.map((m) =>
    m.length > perMessageBudget ? `${m.slice(0, Math.max(perMessageBudget - 1, 1))}…` : m
  );
  return shortened.join(SEPARATOR).slice(0, QR_MESSAGE_LIMIT);
}
