import type { ReactNode } from 'react';

export const metadata = {
  title: 'Razorveda CRM',
  description: 'Internal CRM and MIS platform',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* Design tokens land with the real shell in Phase 1 (design/design-tokens.md). */}
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#E7EAEE' }}>
        {children}
      </body>
    </html>
  );
}
