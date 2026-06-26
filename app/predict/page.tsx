// app/predict/page.tsx — PREDICT. Indicator-based, falsifiable geopolitical forecasting.
//
// HARD RULE (Clark §2c): the value lens is BANNED from the forecast. PREDICT answers only
// "what is likely to happen," mechanically and scoreably. Each forecast names its base
// rate first, then indicators by category, an adjusted probability + confidence band, the
// watch items, a resolution date + criterion, and (when scored) a Brier score.

import { readForecasts } from '../../lib/store';
import { trackRecord } from '../../lib/predict/brier';
import { Masthead, Footer } from '../components';
import type { Indicator } from '../../lib/types';

export const dynamic = 'force-static';

const CAT_LABEL: Record<Indicator['category'], string> = {
  statements_signaling: 'statements / signaling',
  diplomatic_protocol: 'diplomatic protocol',
  military_movements: 'military movements',
  economic_trade: 'economic & trade',
  domestic_political: 'domestic politics',
  base_rate_history: 'base rate / history',
};

const DIR_GLYPH: Record<Indicator['direction'], string> = { up: '↑', down: '↓', neutral: '→' };

export default function Predict() {
  const forecasts = readForecasts();
  const tr = trackRecord(forecasts);

  return (
    <div className="shell">
      <Masthead activeNav="predict" />
      <div className="section-kicker" style={{ paddingTop: 26 }}>
        Predict
      </div>
      <p className="empty" style={{ paddingTop: 0, paddingBottom: 4 }}>
        Indicator-based, falsifiable projections. Base rate first, then the tells. Scored against
        outcomes (Brier) — un-scored forecasts are wishcasting.
        <br />
        Track record: {tr.resolved} resolved
        {tr.meanBrier !== null ? ` · mean Brier ${tr.meanBrier}` : ' · none scored yet'}.
      </p>

      <div className="predict-firewall">
        Firewall: PREDICT carries no value lens. It estimates what is likely to happen, not what
        should happen. The Weigh-It questions never enter a probability.
      </div>

      {forecasts.length === 0 ? (
        <div className="empty">No active forecasts.</div>
      ) : (
        forecasts.map((f) => (
          <article className="forecast" key={f.id}>
            <div className="thread">{f.thread}</div>
            <div className="question">{f.question}</div>

            <div className="prob-row">
              <span className="prob">{Math.round(f.probability * 100)}%</span>
              <span className="band">confidence band {f.confidence_band}</span>
            </div>
            <div className="meta-line">
              Resolves {f.resolution_date} · {f.resolution_criterion}
            </div>
            <div className="meta-line">
              <strong>Base rate (outside view):</strong> {f.base_rate}
            </div>

            <div className="indicator-grid">
              {f.indicators.map((ind, i) => (
                <div className="indicator" key={i}>
                  <span className={`dir ${ind.direction}`}>{DIR_GLYPH[ind.direction]}</span>
                  <span>
                    <span className="cat">{CAT_LABEL[ind.category]}</span> — {ind.text}
                  </span>
                </div>
              ))}
            </div>

            {f.economics_note ? (
              <div className="meta-line" style={{ marginTop: 12 }}>
                <strong>Economics tell:</strong> {f.economics_note}
              </div>
            ) : null}

            <div className="meta-line" style={{ marginTop: 12 }}>
              <strong>Watch items:</strong>
              <ul style={{ margin: '6px 0 0 18px' }}>
                {f.watch_items.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>

            {f.resolved ? (
              <div className="meta-line" style={{ marginTop: 10 }}>
                Resolved {f.resolved.outcome ? 'YES' : 'NO'} · Brier {f.resolved.brier}
              </div>
            ) : null}
          </article>
        ))
      )}
      <Footer />
    </div>
  );
}
