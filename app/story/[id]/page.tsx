// app/story/[id]/page.tsx — the three-layer record: FACT → CONTEXT → WEIGH-IT.
//
// FACT: neutral who/what/when/where (+ exact quote for statements).
// CONTEXT: neutral factual background (Context is king).
// WEIGH-IT: value-lens QUESTIONS only, clearly labeled as a thinking aid, anchored to the
//           founding canon — never a conclusion (Clark §1b; v2 layer 3).
// Then a sources panel (every primary linkout, tiered, paywall-flagged) + long-form link.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { readFacts, readFactById } from '../../../lib/store';
import { Masthead, Footer } from '../../components';

export const dynamic = 'force-static';

export async function generateStaticParams() {
  return readFacts().map((f) => ({ id: f.id }));
}

const TIER_LABEL: Record<string, string> = {
  T1_wire: 'wire',
  T1_gov: 'primary / gov',
  T2_indie: 'independent',
  T3_factslice: 'detected',
};

function fmtFull(dt: string): string {
  const d = new Date(dt);
  if (isNaN(d.getTime())) return '';
  return (
    d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) +
    ' · ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) +
    ' UTC'
  );
}

export default async function Story({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fact = readFactById(id);
  if (!fact) notFound();

  return (
    <div className="shell">
      <Masthead />

      <div className="back-bar">
        <Link href="/">
          <span className="arrow">←</span> Back to today&rsquo;s dispatches
        </Link>
      </div>

      <article className="detail">
        <div className="region">
          {fact.place}
          {fact.economics_flag ? <span className="econ-tag">economics</span> : null}
        </div>
        <div className="datestamp">{fmtFull(fact.datetime_utc)}</div>
        <div className="rule" />

        {/* FACT */}
        <div className="lede">{fact.what}</div>
        {fact.quote ? <div className="quote">&ldquo;{fact.quote}&rdquo;</div> : null}

        {/* CONTEXT */}
        {fact.context && fact.context.trim() && fact.context !== fact.what ? (
          <section className="narr">
            <div className="sec-label">Context</div>
            <div className="body">{fact.context}</div>
          </section>
        ) : null}

        {/* WEIGH-IT — questions only, labeled, anchored to the canon */}
        {fact.weigh_it_questions.length > 0 ? (
          <section className="narr weighit">
            <div className="sec-label">Weigh It</div>
            <div className="lens-note">
              A reflective lens, not a verdict. These are questions to weigh the event against the
              American founding and constitutional tradition — Pigeon prompts your thinking; it never
              hands you the conclusion.
            </div>
            {fact.weigh_it_questions.map((w, i) => (
              <div className="weigh-q" key={w.tenet + i}>
                <span className="q-text">{w.question}</span>
                <span className="anchor">— {w.anchor}</span>
              </div>
            ))}
          </section>
        ) : null}

        {/* SOURCES */}
        <div className="sources-panel">
          <div className="sp-label">Primary sources</div>
          {fact.sources.map((s, i) => (
            <div className="src-row" key={s.url + i}>
              <span className="bullet">↗</span>
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.outlet}
              </a>
              <span className="tierbadge">{TIER_LABEL[s.tier] ?? s.tier}</span>
              {s.paywalled ? <span className="paywall">paywall</span> : null}
            </div>
          ))}
        </div>

        {/* LONG-FORM */}
        {fact.longform_url ? (
          <a className="longform-link" href={fact.longform_url} target="_blank" rel="noopener noreferrer">
            Watch / read the full event →
          </a>
        ) : null}
      </article>

      <Footer />
    </div>
  );
}
