import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pigeon — what actually mattered',
  description:
    'A minimalist, fact-only news app. Time, place, fact, primary-source link. No opinion. No gossip. FACT → CONTEXT → WEIGH-IT.',
};

// Dark is the shipping default (Davinci D3). Restore a saved preference before paint to
// avoid a flash. Pure DOM toggle — no client framework needed for the theme.
const themeBootstrap = `(function(){try{var t=localStorage.getItem('pigeon-theme');if(t){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <link rel="preconnect" href="https://fonts.bunny.net" />
        <link
          href="https://fonts.bunny.net/css?family=source-serif-4:400,400i,600,700|inter:500,600,700"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
