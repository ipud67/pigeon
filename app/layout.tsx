import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
 title: 'Pigeon — what actually mattered',
 description:
 'A minimalist, fact-only news app. Time, place, fact, primary-source link. No opinion. No gossip. FACT → CONTEXT → WEIGH-IT.',
 manifest: '/manifest.webmanifest',
 icons: {
 icon: [
 { url: '/icons/favicon-48.png', sizes: '48x48', type: 'image/png' },
 { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
 { url: '/icons/favicon-16.png', sizes: '16x16', type: 'image/png' },
 ],
 apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
 },
};

export const viewport: Viewport = {
 themeColor: '#111922',
};

// Dark is the shipping default (Design ). Restore a saved preference before paint to
// avoid a flash. Pure DOM toggle — no client framework needed for the theme.
const themeBootstrap = `(function(){try{var t=localStorage.getItem('pigeon-theme');if(t){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

// FEED-REORDER FLASH (fixed 2026-07-23). The static page ships the UNIVERSAL editorial order;
// the reader's own order can only be computed in the browser, because the profile that drives it
// lives in localStorage. So a returning reader watched the feed paint one order and then swap to
// another — on today's data only 4 of 57 positions survived the swap. It read as the page
// changing its mind about the news.
//
// A first-time reader has no profile, so the static order IS their final order — they must not pay
// for this. This script only arms the hold when a profile actually exists. The feed body is then
// held (visibility only — layout is already correct, so nothing reflows) until the ranking layer
// has run, and released before paint by the layout effect in app/feed.tsx.
//
// FAILSAFE: if the JS bundle never arrives, the attribute is cleared on a timer anyway. A reader
// with broken JS sees the universal order, which is the honest fallback. Never a blank feed.
const personalizeBootstrap = `(function(){try{var d=document.documentElement;if(localStorage.getItem('pigeon.profile.lastVisit')||localStorage.getItem('pigeon.profile.seen')){d.setAttribute('data-personalizing','1');setTimeout(function(){d.removeAttribute('data-personalizing');},1200);}}catch(e){}})();`;

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
 <script dangerouslySetInnerHTML={{ __html: personalizeBootstrap }} />
 </head>
 <body>{children}</body>
 </html>
 );
}
