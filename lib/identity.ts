import type { ThemeTokens } from './theme';

/**
 * Design-refresh helper (2026-09): gives people and categories a stable,
 * distinguishing color without inventing a new palette or a `color` column
 * on `categories` — categories are free-text/user-defined (see
 * types/database.ts), so there's no fixed enum to hang colors off. Instead
 * this reuses `tokens.category`, the six-hue wheel that was already defined
 * in lib/theme.ts but never actually wired up anywhere in the app.
 *
 * `categoryColor` is for a category you already have an index for (its
 * position in a sorted list — see Overview/ExpenseEntryForm). `identityColorFor`
 * is for a free-text name (a debtor, a split partner) with no natural index —
 * it hashes the name into the same wheel so a given name always lands on the
 * same color across screens and reloads, without persisting anything.
 */
export function categoryColor(index: number, tokens: Pick<ThemeTokens, 'category'>): string {
  return tokens.category[index % tokens.category.length];
}

export function identityColorFor(name: string, tokens: Pick<ThemeTokens, 'category'>): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash += name.charCodeAt(i);
  return tokens.category[hash % tokens.category.length];
}

/** Soft translucent version of a hex token color, for avatar/badge
 * backgrounds — tokens.category entries are plain hex (see lib/theme.ts's
 * note on why: React Native's native color parser doesn't understand
 * oklch()), so this converts hex -> rgba rather than using CSS color-mix. */
export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
