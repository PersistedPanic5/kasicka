// One-off conversion: oklch(...) tokens from the mockups -> hex, since React
// Native's native color parser (iOS/Android) does not understand oklch() —
// only the web CSS engine does. Run once, paste results into lib/theme.ts.
// Implements the standard CSS Color 4 OKLCH -> sRGB algorithm.

function oklchToRgb(L, C, Hdeg) {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  let bch = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  const gamma = (x) => {
    x = Math.min(1, Math.max(0, x));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  };
  r = gamma(r);
  g = gamma(g);
  bch = gamma(bch);

  const toHex = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(bch)}`;
}

const tokens = {
  light: {
    bg: [0.975, 0.006, 90], card: [0.94, 0.01, 90], cardAlt: [0.97, 0.006, 90],
    text: [0.22, 0.01, 90], textMuted: [0.55, 0.02, 90], border: [0.87, 0.01, 90],
    accent: [0.45, 0.06, 165], accentBorder: [0.78, 0.05, 165],
    amberBg: [0.92, 0.06, 80], amberFg: [0.5, 0.1, 75],
    greenBg: [0.92, 0.05, 155], greenFg: [0.42, 0.08, 155],
    coral: [0.55, 0.15, 30], amber: [0.62, 0.13, 75],
    cat1: [0.72, 0.1, 40], cat2: [0.72, 0.1, 340], cat3: [0.72, 0.1, 230],
    cat4: [0.6, 0.09, 165], cat5: [0.72, 0.1, 280], cat6: [0.75, 0.01, 90],
  },
  dark: {
    bg: [0.20, 0.006, 90], card: [0.27, 0.008, 90], cardAlt: [0.24, 0.007, 90],
    text: [0.94, 0.004, 90], textMuted: [0.65, 0.012, 90], border: [0.36, 0.008, 90],
    accent: [0.76, 0.1, 165], accentText: [0.16, 0.02, 165], accentBorder: [0.45, 0.06, 165],
    amberBg: [0.3, 0.05, 75], amberFg: [0.85, 0.1, 80],
    greenBg: [0.3, 0.05, 155], greenFg: [0.82, 0.1, 155],
    coral: [0.7, 0.13, 30], amber: [0.78, 0.12, 75],
    cat1: [0.65, 0.1, 40], cat2: [0.65, 0.1, 340], cat3: [0.65, 0.1, 230],
    cat4: [0.65, 0.1, 165], cat5: [0.65, 0.1, 280], cat6: [0.55, 0.02, 90],
  },
};

for (const [mode, group] of Object.entries(tokens)) {
  console.log(`\n${mode}:`);
  for (const [name, [L, C, H]] of Object.entries(group)) {
    console.log(`  ${name}: ${oklchToRgb(L, C, H)}  // oklch(${L} ${C} ${H})`);
  }
}
