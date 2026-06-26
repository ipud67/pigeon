// app/components.tsx — shared server components + tiny client islands for Pigeon.

import Link from 'next/link';
import type { Category } from '../lib/types';
import { ThemeToggle } from './theme-toggle';

// The default view is "Top Stories" — the mixed, importance-ranked stream (NOT a category).
// The category entries are OPT-IN filters (mission rule 4), never the default. Economics is
// the path to the micro-noise the home buries (8-K filings etc.).
export const TOP_FILTER = 'top' as const;
export const CATEGORIES: { id: Category | typeof TOP_FILTER; label: string }[] = [
  { id: 'top', label: 'Top Stories' },
  { id: 'war', label: 'War' },
  { id: 'world', label: 'World' },
  { id: 'government', label: 'Government' },
  { id: 'economics', label: 'Economics' },
  { id: 'courts', label: 'Courts' },
  { id: 'health', label: 'Health' },
];

export function fmtMastheadDate(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function Masthead({ count, activeNav }: { count?: number; activeNav?: string }) {
  return (
    <header>
      <div className="masthead">
        <div className="name">
          <Link href="/">Pigeon</Link>
        </div>
        <div className="date">
          {fmtMastheadDate()}
          {typeof count === 'number' ? ` · ${count} dispatches` : ''}
        </div>
      </div>
      <div className="masthead-rule" />
      <nav className="nav">
        <Link href="/" className={activeNav === 'today' ? '' : 'muted'}>
          Today
        </Link>
        <Link href="/weekly" className={activeNav === 'weekly' ? '' : 'muted'}>
          This Week
        </Link>
      </nav>
      <ThemeToggle />
    </header>
  );
}

export function Footer() {
  return (
    <div className="footer">
      Pigeon · facts, not takes · every claim links to its primary source
      <br />© {new Date().getFullYear()} Creatus LLC. All rights reserved.
    </div>
  );
}
