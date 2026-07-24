// /globe/ — the Matte Atlas World→Local globe, ported into the app (Globe Detail Build Phase 1,
// the globe build spec §3). Static-export-safe: the page shell pre-renders; the
// engine + base geometry load client-side from /globe/data/, detail packs lazy from /globe/packs/.
import type { Metadata } from 'next';
import GlobeClient from './GlobeClient';
import './globe.css';

export const metadata: Metadata = {
 title: 'Pigeon — World → Local',
 description:
 'Grab the world. Spin it. Zoom from the whole planet down into your local news — the Matte Atlas globe.',
};

export const dynamic = 'force-static';

export default function GlobePage() {
 return <GlobeClient />;
}
