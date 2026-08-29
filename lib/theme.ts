/**
 * "Calm & Clear" theme tokens — ported directly from the approved Design canvas
 * mockups (Main.dc.html, Overview.dc.html, Debts.dc.html, Transactions.dc.html,
 * More.dc.html, MonthlyWizard.dc.html, DebtorShare.dc.html) so the real app
 * matches the approved visuals rather than being redesigned from scratch.
 * Soft off-white / sage-green accent, Manrope typeface.
 *
 * Values are hex, not oklch: React Native's native color parser (iOS/Android)
 * doesn't understand oklch() — only the web CSS engine does — so each value
 * here was computed from the mockup's original oklch() via the standard CSS
 * Color 4 conversion (see scripts/oklch-to-hex.mjs) and the source oklch is
 * kept in a comment for provenance. Re-run that script if a token changes.
 */

export type ThemeMode = 'light' | 'dark';

export interface ThemeTokens {
  bg: string;
  card: string;
  cardAlt: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  accentText: string;
  accentBorder: string;
  amberBg: string;
  amberFg: string;
  greenBg: string;
  greenFg: string;
  coral: string;
  amber: string;
  /** category dots, in the order categories are usually listed:
   * Food, Fun, Transport, Housing, Insurance, Other */
  category: [string, string, string, string, string, string];
}

const light: ThemeTokens = {
  bg: '#f8f7f2',          // oklch(0.975 0.006 90)
  card: '#eeebe4',        // oklch(0.94 0.01 90)
  cardAlt: '#f7f5f1',     // oklch(0.97 0.006 90)
  text: '#1c1a15',        // oklch(0.22 0.01 90)
  textMuted: '#767165',   // oklch(0.55 0.02 90)
  border: '#d7d4cd',      // oklch(0.87 0.01 90)
  accent: '#32604d',      // oklch(0.45 0.06 165)
  accentText: '#ffffff',
  accentBorder: '#9ac2af',// oklch(0.78 0.05 165)
  amberBg: '#fae1b8',     // oklch(0.92 0.06 80)
  amberFg: '#845a0f',     // oklch(0.5 0.1 75)
  greenBg: '#cbefd6',     // oklch(0.92 0.05 155)
  greenFg: '#225a39',     // oklch(0.42 0.08 155)
  coral: '#b94739',       // oklch(0.55 0.15 30)
  amber: '#b37903',       // oklch(0.62 0.13 75)
  category: [
    '#da8f74', // Food      oklch(0.72 0.1 40)
    '#cf8cb8', // Fun       oklch(0.72 0.1 340)
    '#5bb0d7', // Transport oklch(0.72 0.1 230)
    '#459173', // Housing   oklch(0.6 0.09 165)
    '#989ee2', // Insurance oklch(0.72 0.1 280)
    '#b0aea7', // Other     oklch(0.75 0.01 90)
  ],
};

const dark: ThemeTokens = {
  bg: '#171613',          // oklch(0.20 0.006 90)
  card: '#282622',        // oklch(0.27 0.008 90)
  cardAlt: '#201f1c',     // oklch(0.24 0.007 90)
  text: '#ecebe8',        // oklch(0.94 0.004 90)
  textMuted: '#928f87',   // oklch(0.65 0.012 90)
  border: '#3f3d38',      // oklch(0.36 0.008 90)
  accent: '#6fc5a1',      // oklch(0.76 0.1 165)
  accentText: '#05100b',  // oklch(0.16 0.02 165)
  accentBorder: '#32604d',// oklch(0.45 0.06 165)
  amberBg: '#3c2a0e',     // oklch(0.3 0.05 75)
  amberFg: '#f0c781',     // oklch(0.85 0.1 80)
  greenBg: '#173523',     // oklch(0.3 0.05 155)
  greenFg: '#8ed8a8',     // oklch(0.82 0.1 155)
  coral: '#e47d6d',       // oklch(0.7 0.13 30)
  amber: '#e4ac59',       // oklch(0.78 0.12 75)
  category: [
    '#c37960', // Food      oklch(0.65 0.1 40)
    '#b876a2', // Fun       oklch(0.65 0.1 340)
    '#449ac0', // Transport oklch(0.65 0.1 230)
    '#4ba280', // Housing   oklch(0.65 0.1 165)
    '#8388cb', // Insurance oklch(0.65 0.1 280)
    '#767165', // Other     oklch(0.55 0.02 90)
  ],
};

export const palettes: Record<ThemeMode, ThemeTokens> = { light, dark };

export const fontFamily = {
  regular: 'Manrope_400Regular',
  medium: 'Manrope_500Medium',
  semibold: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
  extrabold: 'Manrope_800ExtraBold',
};

/** Category display order used across Overview/Transactions/wizard mockups. */
export const CATEGORY_NAMES = [
  'Food',
  'Fun',
  'Transport',
  'Housing',
  'Insurance',
  'Other',
] as const;
