import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import './globals.css';

/**
 * THE FONTS THE DESIGN WAS SPECIFIED IN, ACTUALLY LOADED — AND SELF-HOSTED.
 *
 * `design/design-tokens.md` names three families and `lib/ui.ts` asks for all
 * three by name on nearly every element. None of them was ever loaded. Every
 * heading, every uppercase label and EVERY NUMBER fell back to `system-ui` from
 * the day the shell was built.
 *
 * That is most of why the product looked flat. The tokens file calls monospace
 * tabular figures "non-negotiable — columns must align in an MIS tool", and they
 * were not aligning, because `font-variant-numeric: tabular-nums` does very
 * little in a proportional UI face. The condensed display face is what makes a
 * 1.4px-tracked uppercase micro-label read as a label rather than as stretched
 * body text; without it those labels were the worst thing on the screen.
 *
 * WHY LOCAL FILES RATHER THAN `next/font/google`. That was the first attempt and
 * it failed the same way twice: "Failed to download `Barlow Condensed` from
 * Google Fonts. Using fallback font instead" — a three-second budget against a
 * link that is fine but not that fine. It falls back SILENTLY, which is exactly
 * the failure mode that hid the missing fonts for weeks. The seven latin woff2
 * files sit in `app/fonts` (~210 kB total) and cannot fail to arrive. It also
 * suits the deployment: a Mumbai VPS should not need Google reachable to render
 * its own admin tool.
 *
 * Latin subset only. latin-ext, cyrillic and vietnamese would triple the payload
 * for glyphs this product never renders — Devanagari is stored and displayed as
 * data, and the system face handles it.
 */

const sans = localFont({
  src: [
    { path: './fonts/ibm-plex-sans-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-sans-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-sans-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-sans',
  display: 'swap',
  // Measured against the fallback so a swap does not shift the layout.
  adjustFontFallback: 'Arial',
});

const mono = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-500.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-mono',
  display: 'swap',
});

const display = localFont({
  src: [
    { path: './fonts/barlow-condensed-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/barlow-condensed-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-display',
  display: 'swap',
});

export const metadata = {
  title: 'Razorveda CRM',
  description: 'Internal CRM and MIS platform',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}
