import Svg, { Circle, Path, Rect } from 'react-native-svg';

/**
 * The piggy-bank brand mark (design/mark.svg), reused inline as a small
 * React Native SVG component so it can sit next to the "KASIČKA" wordmark
 * wherever that text already appears (nav header, wizard, quick-entry,
 * sign-in, the public debt-share page) — previously the mark only existed
 * as a static PNG (favicon/app icon/OG image), never actually visible on
 * the page itself.
 *
 * The eye/nostril "holes" are drawn as filled circles in `holeColor` rather
 * than a true transparent cutout (unlike the generated PNG assets, which
 * use an SVG mask) — simpler and perfectly fine here, since every call site
 * places this mark directly on a flat `tokens.bg` surface, never over an
 * image or gradient.
 *
 * Cropped to the mark's own bounding box (design/mark.svg is authored on a
 * 1024×1024 square with lots of padding around it, sized for an app icon)
 * so it isn't mostly empty space at the small sizes used here — `size` sets
 * the rendered height; width follows the mark's natural aspect ratio.
 */
const VIEW_BOX = '170 330 740 520';
const ASPECT_RATIO = 740 / 520;

export function LogoMark({
  size = 22,
  color,
  holeColor,
}: {
  size?: number;
  color: string;
  holeColor: string;
}) {
  return (
    <Svg width={size * ASPECT_RATIO} height={size} viewBox={VIEW_BOX}>
      <Path
        d="M 248 578 C 200 566, 198 612, 246 604"
        fill="none"
        stroke={color}
        strokeWidth={24}
        strokeLinecap="round"
      />
      <Path d="M 335 410 C 328 362, 386 350, 415 385 C 390 383, 358 392, 342 420 Z" fill={color} />
      <Rect x={245} y={410} width={560} height={380} rx={190} fill={color} />
      <Rect x={330} y={740} width={60} height={90} rx={26} fill={color} />
      <Rect x={470} y={740} width={60} height={90} rx={26} fill={color} />
      <Rect x={610} y={740} width={60} height={90} rx={26} fill={color} />
      <Rect x={705} y={740} width={60} height={90} rx={26} fill={color} />
      <Circle cx={800} cy={600} r={95} fill={color} />
      <Rect x={470} y={380} width={140} height={34} rx={17} fill={color} />
      <Circle cx={775} cy={600} r={9} fill={holeColor} />
      <Circle cx={825} cy={600} r={9} fill={holeColor} />
      <Circle cx={700} cy={520} r={14} fill={holeColor} />
    </Svg>
  );
}
