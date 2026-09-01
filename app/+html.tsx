import { ScrollViewStyleReset } from 'expo-router/html';
import { type PropsWithChildren } from 'react';

/**
 * Wraps every static HTML page Expo Router exports (see
 * https://docs.expo.dev/router/reference/static-rendering/#root-html).
 * Without this file, Expo's default template ships an empty <title>, no
 * meta description, and no Open Graph/Twitter Card tags — confirmed by
 * inspecting a plain `expo export --platform web` output before this file
 * existed. This is where the app finally gets a real tab title, a link
 * preview (Messenger/WhatsApp/iMessage/Slack all read og:*), and a
 * matching theme-color + apple-touch-icon for when it's added to a home
 * screen.
 *
 * og:image/twitter:image must be an ABSOLUTE url per the spec — link
 * unfurlers won't resolve a relative path — hence the hardcoded
 * kasicka.eu origin. public/og-image.png (1200×630) is served at exactly
 * that path by the static export (see design/og-image.svg for the
 * source).
 */
const TITLE = 'Kasička — personal finance & debts, kept simple';
const DESCRIPTION =
  'Track spending, plan your monthly budget, and split debts with friends — Kasička keeps personal finance simple.';
const SITE_URL = 'https://kasicka.eu';
const OG_IMAGE_URL = `${SITE_URL}/og-image.png`;
const THEME_COLOR = '#f8f7f2';

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no" />

        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta name="theme-color" content={THEME_COLOR} />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="icon" href="/favicon.ico" />

        {/* Open Graph — link previews in Messenger, WhatsApp, iMessage, Slack, etc. */}
        <meta property="og:type" content="website" />
        <meta property="og:url" content={SITE_URL} />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:image" content={OG_IMAGE_URL} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />

        {/* Twitter/X card */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={TITLE} />
        <meta name="twitter:description" content={DESCRIPTION} />
        <meta name="twitter:image" content={OG_IMAGE_URL} />

        <ScrollViewStyleReset />

        {/* Keep the page background steady (no white flash) before the app's
            own ThemeProvider paints — matches app.json's web.backgroundColor. */}
        <style dangerouslySetInnerHTML={{ __html: `html,body{background-color:${THEME_COLOR}}` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
