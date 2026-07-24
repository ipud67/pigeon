// app/local/[slug]/page.tsx — a LOCAL area page (R31 pilot). Heritage pack + client map
// locator + vocab + region-tagged news, all from the baked data/local/{slug}.json record.
//
// Every heritage claim carries a primary/authoritative source linkout (checkable). Prose is
// rule-based template built at ingest from structured data — NOT LLM-generated, never invented.
// A field with no real data renders an honest "on record" / "not wired yet" state — never a
// fake figure, date, or placeholder dressed up as real (Pigeon red line + QC).

import Link from 'next/link';
import { notFound } from 'next/navigation';
import {Footer} from '../../components';
import { Flag, BottomTabs } from '../../flag';
import { listLocalSlugs, readLocalArea } from '../../../lib/local';
import type {
 LocalMarker, LocalSource, LocalOutlet, LocalGovLink, LocalPark,
 LocalCivicNews, LocalCalendar,
} from '../../../lib/local';
import { LocalMap } from './LocalMap';
import { AddAreaButton } from './AddAreaButton';

export const dynamic = 'force-static';

export function generateStaticParams() {
 return listLocalSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
 const { slug } = await params;
 const area = readLocalArea(slug);
 return { title: area ? `${area.area.name} — Pigeon Local` : 'Local — Pigeon' };
}

// Reader-facing group headers (plural — one per category of notable figure). The figures section
// is grouped by marker and collapsed by default (compact, click-to-expand) so a reader never
// scrolls a long single-column list. Order = most-honored first.
const GROUP_LABEL: Record<LocalMarker, string> = {
 medal_of_honor: 'Medal of Honor recipients',
 signer: 'Founding signers',
 pioneer: 'Founding settlers',
 astronaut: 'Astronauts',
 olympic: 'Olympic medalists',
 athlete: 'Athletes',
 inventor: 'Inventors',
 politician: 'Politicians',
 entrepreneur: 'Business founders',
 author: 'Authors',
 actor: 'Actors',
 musician: 'Musicians',
};
const GROUP_ORDER: LocalMarker[] = [
 'medal_of_honor', 'signer', 'pioneer', 'astronaut', 'olympic', 'athlete',
 'inventor', 'politician', 'entrepreneur', 'author', 'actor', 'musician',
];

const TIER_LABEL: Record<string, string> = {
 T1_wire: 'wire',
 T1_gov: 'primary / gov',
 T2_indie: 'reference',
 T3_factslice: 'detected',
};

function Sources({ sources }: { sources: LocalSource[] }) {
 if (!sources || sources.length === 0) return null;
 return (
 <div className="local-src">
 {sources.map((s, i) => (
 <span className="local-src-item" key={s.url + i}>
 <a href={s.url} target="_blank" rel="noopener noreferrer">
 {s.outlet}
 </a>
 <span className="tierbadge">{TIER_LABEL[s.tier] ?? s.tier}</span>
 </span>
 ))}
 </div>
 );
}

const SITES_SHOWN = 12;

// "Worth Exploring" park tiers, rendered as sub-headers inside the one dropdown (most-public first).
const PARK_TIERS: { key: LocalPark['tier']; label: string }[] = [
 { key: 'national', label: 'National' },
 { key: 'state', label: 'State' },
 { key: 'local', label: 'Local' },
];

// A list of government / park linkouts: name links out, with a plain one-line note and any
// facts-only lines (e.g. enrollment). No feed is claimed where none exists (Research-confirmed);
// this is the honest labeled-linkout treatment.
function LinkoutList({ items, testid }: { items: LocalGovLink[]; testid: string }) {
 return (
 <ul className="local-links linkout-list">
 {items.map((it) => (
 <li key={it.url} data-testid={testid}>
 <a href={it.url} target="_blank" rel="noopener noreferrer">
 {it.name} <span className="ext">&#8599;</span>
 </a>
 {it.note ? <div className="ll-note">{it.note}</div> : null}
 {(it.facts ?? []).map((f, i) => (
 <div className="ll-fact" key={i}>
 {f}
 </div>
 ))}
 </li>
 ))}
 </ul>
 );
}

const OUTLET_KIND_LABEL: Record<LocalOutlet['kind'], string> = {
 news: 'news',
 civic_video: 'council video',
 gov: 'government',
};

function fmtLocalDate(dt: string): string {
 const d = new Date(dt);
 if (isNaN(d.getTime())) return '';
 return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export default async function LocalArea({ params }: { params: Promise<{ slug: string }> }) {
 const { slug } = await params;
 const data = readLocalArea(slug);
 if (!data) notFound();

 const { area, heritage, news, outlets, vocab } = data;
 const civicNews: LocalCivicNews = data.civic_news ?? { items: [], generated_at: '' };
 const calendar: LocalCalendar = data.calendar ?? { meetings: [], meeting_sources: [], elections: [], generated_at: '' };
 const companies = heritage.companies ?? [];
 const gov = data.gov ?? { law_enforcement: [], school_boards: [], education: [] };
 const parks = data.parks ?? [];
 const kindLabel = area.kind === 'independent_city' ? 'Independent city' : 'County';
 const sitesShown = heritage.sites.slice(0, SITES_SHOWN);
 const sitesMore = heritage.sites.length - sitesShown.length;

 // Group notable figures by marker into compact, collapsed dropdowns (one per category).
 const figureGroups = GROUP_ORDER.map((marker) => ({
 marker,
 items: heritage.figures.filter((f) => f.marker === marker),
 })).filter((g) => g.items.length > 0);

 return (
 <div className="shell">
 <Flag activeNav="local" />

 <div className="back-bar">
 <Link href="/local">
 <span className="arrow">&larr;</span> All local areas
 </Link>
 </div>

 {/* AREA HEADER */}
 <div className="local-head">
 <div className="local-kind">
 {kindLabel} · {area.state}
 </div>
 <h1 className="local-name">{area.name}</h1>
 <div className="local-sub">
 Primary city: {area.primary_city}
 {area.kind === 'independent_city' ? ' · belongs to no county' : ''}
 </div>
 {/* Build-out C2: "+ Add [area] to my feed" — client-side, localStorage-backed. Adds this
 area to the reader's own local newsfeed (reachable from the Local-news headline on
 Today). When the globe ships later it reuses the same store. */}
 <AddAreaButton slug={slug} name={area.name} />
 </div>

 {/* MAP LOCATOR */}
 <LocalMap
 boundary={area.boundary ?? null}
 centroid={area.centroid}
 label={area.primary_city}
 kindLabel={kindLabel}
 map={area.map ?? null}
 />

 {/* THIS WEEK — the AI-distilled weekly civic summary (build-out D, R49+R53). Produced by the
 cost-capped Grok classifier from ONLY the real kept headlines below (no fabrication); house
 style (5th-grade, past tense, no opinion). Rendered ABOVE the verbatim roundup, which stays.
 Absent under the mock provider or when no fact-reports survived this week. */}
 {civicNews.summary ? (
 <>
 <div className="section-kicker" style={{ paddingTop: 30 }}>
 This week
 </div>
 <section className="local-block">
 <p className="local-week-summary" data-testid="civic-week-summary">
 {civicNews.summary}
 </p>
 <div className="local-week-provenance">
 AI summary drawn only from this week&rsquo;s local headlines below.
 </div>
 </section>
 </>
 ) : null}

 {/* LOCAL NEWS — the FREE, real civic-news roundup. Real headlines from the local outlet RSS
 feeds, kept by the keyword pre-filter and (when LLM_PROVIDER=xai) the Grok fact-vs-opinion +
 geo classifier, shown VERBATIM with a link out to the source. Never rewritten, never
 fabricated. Honest empty-state when no civic fact-report surfaced this week. */}
 <div className="section-kicker" style={{ paddingTop: civicNews.summary ? 8 : 30 }}>
 Local news
 </div>
 <section className="local-block">
 {civicNews.items.length === 0 ? (
 <div className="local-empty" data-testid="civic-news-empty">
 {civicNews.note ?? 'No civic news on record for this area this week.'}
 </div>
 ) : (
 <div className="local-news" data-testid="civic-news">
 {civicNews.items.map((it) => (
 <div className="local-news-row" data-testid="civic-news-row" key={it.url}>
 <div className="lnr-date">{fmtLocalDate(it.date)}</div>
 <a className="lnr-title" href={it.url} target="_blank" rel="noopener noreferrer">
 {it.title} <span className="ext">&#8599;</span>
 </a>
 <div className="lnr-outlet">
 {it.outlet}
 {it.scope === 'state' ? ' · statewide' : ''}
 </div>
 </div>
 ))}
 </div>
 )}
 </section>

 {/* CIVIC CALENDAR — the FREE, real upcoming layer (build-out C1). Real dated public meetings
 where a free government feed exists (Legistar), else honest linkouts to the official
 meeting calendars. Elections link out to the registrar / state office — election dates are
 not machine-readable here, so we never project or invent one. */}
 <div className="section-kicker" style={{ paddingTop: 8 }}>
 Civic calendar
 </div>
 <section className="local-block">
 {calendar.meetings.length > 0 ? (
 <div className="ld-subgroup" data-testid="cal-meetings">
 <div className="ld-subhead">Upcoming public meetings</div>
 <div className="local-cal">
 {calendar.meetings.map((m) => (
 <div className="local-cal-row" data-testid="cal-meeting-row" key={m.url + m.date}>
 <div className="lcr-date">{fmtLocalDate(m.date)}</div>
 <a className="lcr-title" href={m.url} target="_blank" rel="noopener noreferrer">
 {m.title} <span className="ext">&#8599;</span>
 </a>
 </div>
 ))}
 </div>
 </div>
 ) : null}

 {calendar.meeting_sources.length > 0 ? (
 <div className="ld-subgroup" data-testid="cal-meeting-sources">
 <div className="ld-subhead">
 {calendar.meetings.length > 0 ? 'More meeting calendars' : 'Public meeting calendars'}
 </div>
 <LinkoutList items={calendar.meeting_sources} testid="cal-meeting-source-row" />
 </div>
 ) : null}

 {calendar.elections.length > 0 ? (
 <div className="ld-subgroup" data-testid="cal-elections">
 <div className="ld-subhead">Elections</div>
 <LinkoutList items={calendar.elections} testid="cal-election-row" />
 </div>
 ) : null}
 </section>

 {/* HERITAGE */}
 <div className="section-kicker" style={{ paddingTop: 30 }}>
 Heritage
 </div>

 <section className="local-block">
 <div className="local-block-label">Founding{heritage.founding.year ? ` · ${heritage.founding.year}` : ''}</div>
 <div className="local-body">{heritage.founding.text}</div>
 <Sources sources={heritage.founding.sources} />
 </section>

 <section className="local-block">
 <div className="local-block-label">Economy</div>
 <div className="local-body">{heritage.economy.text}</div>
 <Sources sources={heritage.economy.sources} />
 </section>

 <section className="local-block">
 <div className="local-block-label">Statehood</div>
 <div className="local-body">{heritage.statehood.note}</div>
 <Sources sources={heritage.statehood.sources} />
 </section>

 {/* NOTABLE FIGURES — the accomplished FROM the area, plus companies started here. ONE outer
 dropdown : one click opens the whole thing; the categories are sub-groups INSIDE it,
 not separate top-level dropdowns. Name only — no wiki/catalog links surfaced .
 Honest empty-state when nothing is on record. */}
 <section className="local-block">
 <div className="local-block-label">Notable figures</div>
 {figureGroups.length === 0 && companies.length === 0 ? (
 <div className="local-empty" data-testid="figures-empty">
 No notable figures are on record yet for this area.
 </div>
 ) : (
 <details className="local-dropdown" data-testid="figures-dropdown">
 <summary>
 <span className="ld-label">Notable figures</span>
 <span className="ld-count">{heritage.figures.length + companies.length}</span>
 </summary>
 <div className="ld-body">
 {figureGroups.map((g) => (
 <div className="ld-subgroup" data-testid="figure-subgroup" key={g.marker}>
 <div className="ld-subhead">
 {GROUP_LABEL[g.marker]} <span className="ld-subcount">{g.items.length}</span>
 </div>
 {/* Each figure is tappable to a one-sentence explanation of what made them notable
 (build-out B). Figures with no clean description render name-only — never an
 empty or fabricated sentence (Pigeon red line). */}
 <div className="lfg-list">
 {g.items.map((f) =>
 f.blurb ? (
 <details className="lfg-row" data-testid="figure-row" data-marker={f.marker} key={f.wikidata_qid}>
 <summary>{f.name}</summary>
 <div className="lfg-blurb">{f.blurb}</div>
 </details>
 ) : (
 <div className="lfg-row lfg-row-plain" data-testid="figure-row" data-marker={f.marker} key={f.wikidata_qid}>
 {f.name}
 </div>
 ),
 )}
 </div>
 </div>
 ))}
 {companies.length > 0 ? (
 <div className="ld-subgroup" data-testid="figure-subgroup">
 <div className="ld-subhead">
 Companies started here <span className="ld-subcount">{companies.length}</span>
 </div>
 <div className="lfg-items">
 {companies.map((c) => (
 <span className="lfg-item" data-testid="company-row" key={c.wikidata_qid}>
 {c.name}
 </span>
 ))}
 </div>
 </div>
 ) : null}
 </div>
 </details>
 )}
 </section>

 {/* HISTORIC SITES — NRHP. A collapsed dropdown for consistency . NPS linkout per site;
 NO reference number is ever shown to the reader (R33 — the ref# lives in data only). */}
 <section className="local-block">
 <div className="local-block-label">Historic sites on the National Register</div>
 {sitesShown.length === 0 ? (
 <div className="local-empty">No National Register sites on record yet.</div>
 ) : (
 <details className="local-dropdown" data-testid="sites-dropdown">
 <summary>
 <span className="ld-label">Historic sites</span>
 <span className="ld-count">{heritage.sites.length}</span>
 </summary>
 <div className="ld-body">
 {/* Each site is tappable to a one-sentence explanation of what it is / why it is
 historic (build-out B). The NRHP linkout lives inside the expansion. Sites with no
 clean description show name-only, with the linkout as before. NO reference number
 is ever rendered (R33 — ref# is data-only, builds the linkout URL). */}
 <ul className="local-sites">
 {sitesShown.map((s) =>
 s.blurb ? (
 <li key={s.nrhp_ref}>
 <details className="site-entry" data-testid="site-entry">
 <summary>{s.name}</summary>
 <div className="site-blurb">
 {s.blurb}
 <a className="site-link" href={s.url} target="_blank" rel="noopener noreferrer">
 National Register listing <span className="ext">&#8599;</span>
 </a>
 </div>
 </details>
 </li>
 ) : (
 <li key={s.nrhp_ref}>
 <a href={s.url} target="_blank" rel="noopener noreferrer">
 {s.name} <span className="ext">&#8599;</span>
 </a>
 </li>
 ),
 )}
 </ul>
 {sitesMore > 0 ? (
 <div className="local-note">
 and {sitesMore} more listed on the National Register of Historic Places.
 </div>
 ) : null}
 </div>
 </details>
 )}
 </section>

 {/* WORTH EXPLORING — curated confirmed parks / public lands, grouped National / State / Local
 inside one collapsed dropdown . Each entry is a name + one plain line + a linkout to
 the managing agency's own page. No fabricated parks (Pigeon red line). */}
 {parks.length > 0 ? (
 <section className="local-block">
 <div className="local-block-label">Worth exploring</div>
 <details className="local-dropdown" data-testid="parks-dropdown">
 <summary>
 <span className="ld-label">Parks and public lands</span>
 <span className="ld-count">{parks.length}</span>
 </summary>
 <div className="ld-body">
 {PARK_TIERS.map((t) => {
 const items = parks.filter((p) => p.tier === t.key);
 if (items.length === 0) return null;
 return (
 <div className="ld-subgroup" key={t.key}>
 <div className="ld-subhead">{t.label}</div>
 {/* Each park/public land is tappable to its one-line explanation (build-out B);
 the managing-agency linkout lives inside the expansion. */}
 <ul className="local-links linkout-list">
 {items.map((p) => (
 <li key={p.url} data-testid="park-row">
 <details className="park-entry" data-testid="park-entry">
 <summary>{p.name}</summary>
 <div className="ll-note">{p.note}</div>
 <a className="park-link" href={p.url} target="_blank" rel="noopener noreferrer">
 Official page <span className="ext">&#8599;</span>
 </a>
 </details>
 </li>
 ))}
 </ul>
 </div>
 );
 })}
 </div>
 </details>
 </section>
 ) : null}

 {/* HMdb MARKERS — link only (copyrighted; never ingested) */}
 {heritage.markers_linkout.length > 0 ? (
 <section className="local-block">
 <div className="local-block-label">Historical markers</div>
 <ul className="local-links">
 {heritage.markers_linkout.map((m) => (
 <li key={m.hmdb_url}>
 <a href={m.hmdb_url} target="_blank" rel="noopener noreferrer">
 {m.title} <span className="ext">&#8599;</span>
 </a>
 </li>
 ))}
 </ul>
 </section>
 ) : null}

 {/* VOCAB — R13 education layer, tappable (native <details>, static-safe) */}
 {vocab.length > 0 ? (
 <section className="local-block">
 <div className="local-block-label">Words to know</div>
 <div className="local-vocab">
 {vocab.map((v) => (
 <details className="vocab-word" data-testid="vocab-word" key={v.word}>
 <summary>{v.word}</summary>
 <div className="vocab-def">{v.definition}</div>
 </details>
 ))}
 </div>
 </section>
 ) : null}

 {/* LOCAL GOVERNMENT — one dropdown, EXPANDED by default . The board/council records are
 primary-by-construction fact records; law enforcement, school board, and schools are honest
 labeled linkouts (Research confirmed NO machine feed exists for any of them). */}
 <div className="section-kicker" style={{ paddingTop: 8 }}>
 Local government
 </div>
 <section className="local-block">
 <details className="local-dropdown" data-testid="govt-dropdown" open>
 <summary>
 <span className="ld-label">Local government</span>
 </summary>
 <div className="ld-body">
 {/* County board / city council — real meeting records, or an honest empty-state */}
 <div className="ld-subgroup">
 <div className="ld-subhead">{area.kind === 'independent_city' ? 'City council' : 'County board'}</div>
 {news.length === 0 ? (
 <div className="local-empty" data-testid="news-empty">
 No structured government feed is wired for this area yet. The city council posts
 records through a document system with no public feed; its meetings are linked under
 Local outlets.
 </div>
 ) : (
 <div className="local-gov" data-testid="gov-list">
 {news.map((n) => (
 <div className="local-gov-row" data-testid="gov-row" key={n.id}>
 <div className="lgr-date">{fmtLocalDate(n.datetime_utc)}</div>
 <div className="lgr-what">{n.what}</div>
 <div className="local-src">
 {n.sources.map((s, i) => (
 <span className="local-src-item" key={s.url + i}>
 <a href={s.url} target="_blank" rel="noopener noreferrer">
 {s.outlet} <span className="ext">&#8599;</span>
 </a>
 </span>
 ))}
 </div>
 </div>
 ))}
 </div>
 )}
 </div>

 {/* Law enforcement — linkout only (no feed exists) */}
 {gov.law_enforcement.length > 0 ? (
 <div className="ld-subgroup" data-testid="gov-law">
 <div className="ld-subhead">Law enforcement</div>
 <LinkoutList items={gov.law_enforcement} testid="gov-law-row" />
 </div>
 ) : null}

 {/* School board meetings — linkout to the board portal */}
 {gov.school_boards.length > 0 ? (
 <div className="ld-subgroup" data-testid="gov-schoolboard">
 <div className="ld-subhead">School board</div>
 <LinkoutList items={gov.school_boards} testid="gov-schoolboard-row" />
 </div>
 ) : null}

 {/* Schools — facts-only (enrollment) + linkout to the official state report card */}
 {gov.education.length > 0 ? (
 <div className="ld-subgroup" data-testid="gov-education">
 <div className="ld-subhead">Schools</div>
 <LinkoutList items={gov.education} testid="gov-education-row" />
 </div>
 ) : null}
 </div>
 </details>
 </section>

 {/* LOCAL OUTLETS — Research-vetted link-out directory. Presence here is the honest counter to a
 "news desert" claim; a genuine desert would say so plainly instead. */}
 <section className="local-block">
 <div className="local-block-label">Local outlets</div>
 {outlets.length === 0 ? (
 <div className="local-empty" data-testid="outlets-empty">
 No local news outlet covers this area. It is one of the counties with no local desk.
 </div>
 ) : (
 <ul className="local-links" data-testid="outlets-list">
 {outlets.map((o) => (
 <li key={o.url}>
 <a href={o.url} target="_blank" rel="noopener noreferrer">
 {o.name} <span className="ext">&#8599;</span>
 </a>
 <span className="ls-ref">{OUTLET_KIND_LABEL[o.kind]}{o.scope === 'state' ? ' · statewide' : ''}</span>
 {o.paywalled ? <span className="paywall">paywall</span> : null}
 </li>
 ))}
 </ul>
 )}
 </section>

 <Footer />
 <BottomTabs activeNav="local" />
 </div>
 );
}
