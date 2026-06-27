// app/story/[id]/page.tsx — every headline IS its own long form (SPEC v2 §B).
//
// Section order:
//   FACT                    — dateline + who/what/when/where (+ exact quote for statements)
//   CONTEXT                  — the neutral factual blurb (kept) + SHORT HISTORY subsection
//   CONSTITUTIONAL ANALYSIS  — within-bounds vs beyond-bounds, cited to founding documents
//   PREDICTIVE MODEL         — neutral, indicator-based per-story forecast (no value lens)
//   PRIMARY SOURCES          — every linkout, tiered, paywall-flagged (+ full-event linkout)
//
// Depth fields come from data/depth-overrides.json (Clark's research) when present, else the
// ingest output: constitutional analysis is rule-based + cited (real now); short history +
// prediction are clearly-labeled placeholders under mock and real under Grok — NEVER faked.
// White-House advocacy phrasing is neutralized before render (Clark editorial must-fix).

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { readFacts, readFactById } from '../../../lib/store';
import { Masthead, Footer } from '../../components';
import { neutralizeText } from '../../../lib/editorial/neutralize';

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

function srcTag(source: string): string {
  if (source === 'override') return 'researched';
  if (source === 'llm') return 'model-generated';
  if (source === 'rule-based') return 'cited framework';
  return 'pending';
}

export default async function Story({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fact = readFactById(id);
  if (!fact) notFound();

  const headline = neutralizeText(fact.what) || fact.what;
  const context = neutralizeText(fact.context);
  const depth = fact.depth;
  const ca = depth?.constitutional_analysis;
  const sh = depth?.short_history;
  const pred = depth?.prediction;

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
        <div className="lede">{headline}</div>
        {fact.quote ? <div className="quote">&ldquo;{neutralizeText(fact.quote) || fact.quote}&rdquo;</div> : null}

        {/* CONTEXT (+ SHORT HISTORY) */}
        {context && context.trim() && context !== headline ? (
          <section className="narr">
            <div className="sec-label">Context</div>
            <div className="body">{context}</div>
          </section>
        ) : null}

        <section className="narr">
          <div className="sec-label">Short history</div>
          {sh && sh.source !== 'placeholder' ? (
            <div className="body">{sh.text}</div>
          ) : (
            <div className="body placeholder-body">{sh?.text}</div>
          )}
          {sh ? <div className="depth-prov">{srcTag(sh.source)}</div> : null}
        </section>

        {/* CONSTITUTIONAL ANALYSIS — directional: the founding standard IS the measure */}
        <section className="narr constitutional">
          <div className="sec-label">Constitutional analysis</div>
          <div className="lens-note">
            The facts weighed against the American founding standard — the Constitution, the founders&rsquo;
            ideals, and the founding tradition. That standard is the measure here, not modern jurisprudence.
            A court ruling is reported as a fact and tracked as a forecast indicator; it is not treated as
            the constitutional yardstick, and a modern-liberal ruling is never presented as a co-equal
            opposing view.
          </div>

          {ca?.framing ? <div className="framing">{ca.framing}</div> : null}

          {ca?.prose ? (
            <div className="body">{ca.prose}</div>
          ) : ca && ca.contrasts.length > 0 ? (
            ca.contrasts.map((c, i) => (
              <div className="contrast" key={c.tenet + i}>
                <div className="contrast-q">{c.question}</div>
                <div className="within">
                  <span className="side-label">By the founding standard</span>
                  {c.within_bounds}
                </div>
                <div className="beyond">
                  <span className="side-label">The founding-based tension</span>
                  {c.beyond_bounds}
                </div>
                <div className="anchor">— {c.anchor}</div>
              </div>
            ))
          ) : (
            <div className="body placeholder-body">
              {ca?.note ??
                'No constitutional question maps to this routine item — Pigeon shows the fact and its context only.'}
            </div>
          )}
          {ca ? <div className="depth-prov">{srcTag(ca.source)}</div> : null}
        </section>

        {/* PREDICTIVE MODEL — neutral, indicator-based */}
        <section className="narr predictive">
          <div className="sec-label">Predictive model</div>
          <div className="lens-note">
            A neutral, indicator-based forecast — how long this is likely to continue and where it may
            go next. Falsifiable, value-lens excluded.
          </div>
          {pred && pred.source !== 'placeholder' ? (
            <>
              <div className="body">{pred.forecast}</div>
              {pred.horizon ? <div className="horizon">Horizon: {pred.horizon}</div> : null}
              {pred.indicators && pred.indicators.length > 0 ? (
                <ul className="indicators">
                  {pred.indicators.map((ind, i) => (
                    <li key={i}>{ind}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <div className="body placeholder-body">{pred?.forecast}</div>
          )}
          {pred ? <div className="depth-prov">{srcTag(pred.source)}</div> : null}
        </section>

        {/* PRIMARY SOURCES */}
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
          {fact.longform_url ? (
            <a className="longform-link" href={fact.longform_url} target="_blank" rel="noopener noreferrer">
              Watch / read the full event →
            </a>
          ) : null}
        </div>
      </article>

      <Footer />
    </div>
  );
}
