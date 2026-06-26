// app/components.tsx — shared server components + tiny client islands for Pigeon.

import Link from 'next/link';
import type { FactRecord, Category } from '../lib/types';
import { ThemeToggle } from './theme-toggle';

export const CATEGORIES: { id: Category | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'war', label: 'War' },
  { id: 'world', label: 'World' },
  { id: 'government', label: 'Government' },
  { id: 'economics', label: 'Economics' },
  { id: 'courts', label: 'Courts' },
  { id: 'health', label: 'Health' },
];

function fmtMeta(dt: string): string {
  const d = new Date(dt);
  if (isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
  return `${time} UTC`;
}

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
        <Link href="/longform" className={activeNav === 'longform' ? '' : 'muted'}>
          Long-form
        </Link>
        <Link href="/predict" className={activeNav === 'predict' ? '' : 'muted'}>
          Predict
        </Link>
      </nav>
      <ThemeToggle />
    </header>
  );
}

// One feed entry. The whole card links to the detail view; primary sources are surfaced
// inline. Statement-shaped records (with a quote) render the quote as the lede.
export function Dispatch({ fact }: { fact: FactRecord }) {
  return (
    <Link href={`/story/${fact.id}`} className="dispatch">
      <div className="meta">
        <span>
          {fact.place} · {fmtMeta(fact.datetime_utc)}
        </span>
        {fact.economics_flag ? <span className="econ-tag">economics</span> : null}
      </div>
      {fact.quote ? (
        <>
          <div className="deck">{fact.what}</div>
          <div className="quote">&ldquo;{fact.quote}&rdquo;</div>
        </>
      ) : (
        <>
          <div className="lede">{fact.what}</div>
          {fact.deck && fact.deck !== fact.what ? <div className="deck">{fact.deck}</div> : null}
        </>
      )}
      <div className="sources">
        {fact.sources.slice(0, 4).map((s, i) => (
          <span key={s.url + i}>
            {i > 0 ? <span className="sep"> · </span> : null}
            <span className="src">{s.outlet}</span>
          </span>
        ))}
      </div>
    </Link>
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
