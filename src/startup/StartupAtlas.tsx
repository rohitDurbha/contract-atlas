import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, Building2, Command, MapPin, Moon, Search, Sun, Wifi, X } from 'lucide-react';
import {
  EMPTY_FILTERS, FAMILIES, SEGMENTS, family, filterJobs, fuzzy, inSegment, payLabel, relative,
  type Family, type Filters, type StartupCompany, type StartupJob, type StartupOverview,
} from './data';
import './startup.css';

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`The StartupAtlas service answered with HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const FONTS_URL = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap';
const TIER_ORDER = ['1-10', '11-25', '26-50', '51-100', '101-250', '250+'];
type Theme = 'light' | 'dark';

function storedTheme(): Theme | null {
  try { const t = localStorage.getItem('startupatlas-theme'); return t === 'light' || t === 'dark' ? t : null; } catch { return null; }
}

// Adds the "in" class once the element scrolls into view. A callback ref
// is used because the element only mounts after the data arrives.
function useReveal<T extends HTMLElement>() {
  const observer = useRef<IntersectionObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);
  return useCallback((el: T | null) => {
    observer.current?.disconnect();
    if (!el) return;
    if (reducedMotion() || !('IntersectionObserver' in window)) { el.classList.add('in'); return; }
    observer.current = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) { el.classList.add('in'); observer.current?.disconnect(); } }), { threshold: 0.05 });
    observer.current.observe(el);
  }, []);
}

function Ticker({ value, suffix = '' }: { value: number; suffix?: string }) {
  const [shown, setShown] = useState(() => (reducedMotion() ? value : 0));
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (reducedMotion()) { setShown(value); return; }
    let frame = 0;
    const start = () => {
      const t0 = performance.now();
      const step = (t: number) => {
        const p = Math.min(1, (t - t0) / 900);
        setShown(Math.round(value * (1 - Math.pow(1 - p, 3))));
        if (p < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) { start(); return () => cancelAnimationFrame(frame); }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { start(); io.disconnect(); } });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(frame); };
  }, [value]);
  return <span ref={ref} className="sa-num">{shown.toLocaleString()}{suffix}</span>;
}

function spotlight(e: ReactPointerEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty('--x', `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty('--y', `${e.clientY - r.top}px`);
}

function Topbar({ theme, setTheme, openPalette }: { theme: Theme; setTheme: (t: Theme) => void; openPalette: () => void }) {
  return (
    <header className="sa-top">
      <a className="sa-wordmark" href="/startups" aria-label="StartupAtlas home">Startup<em>Atlas</em></a>
      <nav className="sa-switch" aria-label="Atlas sections">
        <a href="/">Contract Atlas</a>
        <a href="/startups" aria-current="page">StartupAtlas</a>
      </nav>
      <div className="sa-top-actions">
        <button className="sa-search-trigger" onClick={openPalette} aria-label="Search companies and roles">
          <Search size={15} strokeWidth={1.5} /><span>Search</span><kbd><Command size={11} strokeWidth={1.5} />K</kbd>
        </button>
        <button className="sa-icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
          {theme === 'dark' ? <Sun size={16} strokeWidth={1.5} /> : <Moon size={16} strokeWidth={1.5} />}
        </button>
      </div>
    </header>
  );
}

function Hero({ overview, hiring }: { overview?: StartupOverview; hiring: number }) {
  const month = new Date().toLocaleString('en-US', { month: 'short', year: 'numeric' }).toUpperCase();
  const remoteShare = overview && overview.roles ? Math.round((overview.remoteRoles / overview.roles) * 100) : 0;
  return (
    <section className="sa-hero">
      <div className="sa-hero-copy">
        <p className="sa-eyebrow">StartupAtlas / {month}</p>
        <h1>Every open role at the startups growing <span className="sa-reveal" aria-label="fastest">{'fastest'.split('').map((ch, i) => <span key={i} style={{ '--i': i } as CSSProperties} aria-hidden="true">{ch}</span>)}</span>.</h1>
        <p className="sa-lede">
          {overview
            ? <>{overview.roles.toLocaleString()} roles across {hiring} hiring companies, read straight from their public job boards. {overview.updatedAt ? <>Checked {relative(overview.updatedAt)} ago.</> : <>The first check is still on its way.</>}</>
            : <>Reading {122} company job boards…</>}
        </p>
      </div>
      <dl className="sa-stats">
        <div><dt>Open roles</dt><dd><Ticker value={overview?.roles ?? 0} /></dd></div>
        <div><dt>Companies hiring</dt><dd><Ticker value={hiring} /><span className="sa-of">/{overview?.companies ?? 122}</span></dd></div>
        <div><dt>Remote friendly</dt><dd><Ticker value={remoteShare} suffix="%" /></dd></div>
      </dl>
    </section>
  );
}

function Marquee({ companies, onPick }: { companies: StartupCompany[]; onPick: (id: string) => void }) {
  const fastest = companies.filter(c => c.fastestRank).sort((a, b) => a.fastestRank! - b.fastestRank!);
  if (!fastest.length) return null;
  const items = (copy: number) => fastest.map(c => (
    <button key={`${copy}-${c.id}`} className="sa-marquee-item" onClick={() => onPick(c.id)} tabIndex={copy ? -1 : 0} aria-hidden={copy ? true : undefined}>
      <span className="sa-mono">#{String(c.fastestRank).padStart(2, '0')}</span>{c.name}
    </button>
  ));
  return (
    <div className="sa-marquee" aria-label="The 32 fastest growing startups of the past 30 days">
      <div className="sa-marquee-track">{items(0)}{items(1)}</div>
    </div>
  );
}

function Bento({ companies, onPick, onSeeAll }: { companies: StartupCompany[]; onPick: (id: string) => void; onSeeAll: () => void }) {
  const ref = useReveal<HTMLElement>();
  const top = companies.filter(c => c.fastestRank).sort((a, b) => a.fastestRank! - b.fastestRank!).slice(0, 6);
  if (!top.length) return null;
  return (
    <section className="sa-bento-wrap sa-fade" ref={ref}>
      <div className="sa-section-head">
        <h2>Fastest growing, past 30 days</h2>
        <button className="sa-link" onClick={onSeeAll}>See all 32 <ArrowUpRight size={14} strokeWidth={1.5} /></button>
      </div>
      <div className="sa-bento">
        {top.map((c, i) => (
          <button key={c.id} className={`sa-tile sa-tile-${i}`} style={{ '--i': i } as CSSProperties} onPointerMove={spotlight} onClick={() => onPick(c.id)}>
            <span className="sa-rank" aria-hidden="true">{String(c.fastestRank).padStart(2, '0')}</span>
            <span className="sa-tile-body">
              <strong>{c.name}</strong>
              <span>{c.focus}</span>
              <span className="sa-mono sa-tile-meta">{c.location} · {c.roleCount ? `${c.roleCount} open` : c.status === 'pending' ? 'checking' : 'no public board'}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function FilterBar({ filters, setFilters, count, families, openPalette }: { filters: Filters; setFilters: (f: Filters) => void; count: number; families: [Family, number][]; openPalette: () => void }) {
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });
  return (
    <div className="sa-filters" role="region" aria-label="Filters">
      <div className="sa-tabs" role="tablist" aria-label="Company group">
        {SEGMENTS.map(s => (
          <button key={s.id} role="tab" aria-selected={filters.segment === s.id} className={filters.segment === s.id ? 'on' : ''} onClick={() => set({ segment: s.id, company: null })}>{s.label}</button>
        ))}
      </div>
      <div className="sa-filter-row">
        <label className="sa-inline-search">
          <Search size={15} strokeWidth={1.5} aria-hidden="true" />
          <input value={filters.query} onChange={e => set({ query: e.target.value })} placeholder="Filter by title, team, place or company" aria-label="Filter roles" />
          {filters.query && <button onClick={() => set({ query: '' })} aria-label="Clear the text filter"><X size={14} strokeWidth={1.5} /></button>}
          <button className="sa-kbd-hint" onClick={openPalette} tabIndex={-1} aria-hidden="true"><kbd>/</kbd></button>
        </label>
        <div className="sa-chips">
          <button className={filters.remote ? 'sa-chip on' : 'sa-chip'} aria-pressed={filters.remote} onClick={() => set({ remote: !filters.remote })}><Wifi size={13} strokeWidth={1.5} />Remote</button>
          <button className={filters.withPay ? 'sa-chip on' : 'sa-chip'} aria-pressed={filters.withPay} onClick={() => set({ withPay: !filters.withPay })}>Pay listed</button>
          <label className={filters.family ? 'sa-chip sa-select on' : 'sa-chip sa-select'}>
            <span className="sr-only">Role family</span>
            <select value={filters.family ?? ''} onChange={e => set({ family: (e.target.value || null) as Family | null })}>
              <option value="">Any team</option>
              {families.map(([f, n]) => <option key={f} value={f}>{f} ({n})</option>)}
            </select>
          </label>
        </div>
        <p className="sa-count sa-mono" aria-live="polite">{count.toLocaleString()} {count === 1 ? 'role' : 'roles'}</p>
      </div>
    </div>
  );
}

function Directory({ companies, selected, onSelect, segment }: { companies: StartupCompany[]; selected: string | null; onSelect: (id: string | null) => void; segment: Filters['segment'] }) {
  const visible = companies.filter(c => inSegment(c, segment));
  const groups = segment === 'fastest'
    ? [['Fastest 32', [...visible].sort((a, b) => a.fastestRank! - b.fastestRank!)] as const]
    : [...TIER_ORDER.map(t => [`${t} people`, visible.filter(c => c.tier === t).sort((a, b) => b.roleCount - a.roleCount || a.name.localeCompare(b.name))] as const),
       ['Fastest 32 only', visible.filter(c => !c.tier).sort((a, b) => b.roleCount - a.roleCount)] as const].filter(([, list]) => list.length);
  return (
    <aside className="sa-directory" aria-label="Companies">
      <div className="sa-dir-head">
        <span className="sa-mono">Companies · {visible.length}</span>
        {selected && <button className="sa-link" onClick={() => onSelect(null)}>Show all</button>}
      </div>
      <div className="sa-dir-scroll">
        {groups.map(([label, list]) => (
          <section key={label}>
            <h3 className="sa-mono">{label}<span>{list.length}</span></h3>
            <ul>
              {list.map(c => (
                <li key={c.id}>
                  <button className={selected === c.id ? 'sa-co on' : 'sa-co'} aria-pressed={selected === c.id} onClick={() => onSelect(selected === c.id ? null : c.id)} onPointerMove={spotlight}>
                    <span className="sa-co-name">{c.fastestRank && segment !== 'fastest' && <span className="sa-mono sa-co-rank">#{c.fastestRank}</span>}{c.name}</span>
                    <span className="sa-co-focus">{c.focus}</span>
                    <span className={c.roleCount ? 'sa-co-count sa-mono' : 'sa-co-count sa-mono muted'}>{c.roleCount || (c.status === 'pending' ? '…' : '0')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}

function CompanyChips({ companies, selected, onSelect, segment }: { companies: StartupCompany[]; selected: string | null; onSelect: (id: string | null) => void; segment: Filters['segment'] }) {
  const list = companies.filter(c => inSegment(c, segment) && c.roleCount > 0).sort((a, b) => b.roleCount - a.roleCount);
  return (
    <div className="sa-co-chips" aria-label="Companies">
      <button className={!selected ? 'sa-chip on' : 'sa-chip'} onClick={() => onSelect(null)}>All</button>
      {list.map(c => <button key={c.id} className={selected === c.id ? 'sa-chip on' : 'sa-chip'} onClick={() => onSelect(c.id)}>{c.name}<span className="sa-mono">{c.roleCount}</span></button>)}
    </div>
  );
}

function CompanyCard({ company, onClear }: { company: StartupCompany; onClear: () => void }) {
  return (
    <div className="sa-company-card">
      <div>
        <p className="sa-mono sa-company-kicker">{company.fastestRank ? `#${company.fastestRank} fastest growing` : ''}{company.fastestRank && company.tier ? ' · ' : ''}{company.tier ? `${company.tier} people` : ''}</p>
        <h2>{company.name}</h2>
        <p>{company.breakoutFocus ?? company.focus}</p>
        <p className="sa-mono sa-company-meta"><MapPin size={12} strokeWidth={1.5} />{company.location}{company.ats ? ` · via ${company.ats}` : ''}</p>
        {company.roleCount === 0 && company.message && <p className="sa-company-note">{company.message}</p>}
      </div>
      <div className="sa-company-actions">
        {(company.boardUrl || company.careersUrl) && <a className="sa-button" href={company.boardUrl ?? company.careersUrl!} target="_blank" rel="noreferrer">{company.boardUrl ? 'Job board' : 'Careers page'}<ArrowUpRight size={14} strokeWidth={1.5} /></a>}
        <button className="sa-link" onClick={onClear}><ArrowLeft size={14} strokeWidth={1.5} />All companies</button>
      </div>
    </div>
  );
}

function JobRow({ job, company, showCompany }: { job: StartupJob; company?: StartupCompany; showCompany: boolean }) {
  return (
    <li>
      <a className="sa-row" href={job.url} target="_blank" rel="noreferrer">
        <span className="sa-row-title">
          <strong>{job.title}</strong>
          <span>{showCompany && company ? <>{company.name}{job.team ? ' · ' : ''}</> : null}{job.team}</span>
        </span>
        <span className="sa-row-place">{job.remote && <span className="sa-pill">Remote</span>}<span className="sa-row-loc">{job.location}</span></span>
        <span className="sa-row-type">{job.employmentType ?? '—'}</span>
        <span className="sa-row-pay sa-mono">{payLabel(job)}</span>
        <span className="sa-row-age sa-mono" title={job.postedAt ? new Date(job.postedAt).toLocaleDateString() : 'Posting date not listed'}>{relative(job.postedAt ?? job.firstSeenAt)}</span>
        <span className="sa-row-go" aria-hidden="true"><ArrowUpRight size={16} strokeWidth={1.5} /></span>
        <span className="sr-only">(opens the application page)</span>
      </a>
    </li>
  );
}

function JobList({ jobs, companies, selected, onSelect }: { jobs: StartupJob[]; companies: Map<string, StartupCompany>; selected: string | null; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(30);
  useEffect(() => setLimit(30), [jobs]);
  if (selected) {
    return <ul className="sa-rows">{jobs.map(j => <JobRow key={j.id} job={j} company={companies.get(j.companyId)} showCompany={false} />)}</ul>;
  }
  const groups = new Map<string, StartupJob[]>();
  for (const j of jobs) groups.set(j.companyId, [...(groups.get(j.companyId) ?? []), j]);
  const ordered = [...groups.entries()];
  return (
    <div className="sa-groups">
      {ordered.slice(0, limit).map(([id, list]) => {
        const c = companies.get(id);
        const expanded = open.has(id);
        const shown = expanded ? list : list.slice(0, 3);
        return (
          <section key={id} className="sa-group">
            <header>
              <button className="sa-group-name" onClick={() => onSelect(id)}>{c?.name ?? id}<span className="sa-mono">{list.length}</span></button>
              <span className="sa-group-focus">{c?.focus}</span>
            </header>
            <ul className="sa-rows">{shown.map(j => <JobRow key={j.id} job={j} company={c} showCompany={false} />)}</ul>
            {list.length > 3 && (
              <button className="sa-more" onClick={() => setOpen(prev => { const next = new Set(prev); if (expanded) next.delete(id); else next.add(id); return next; })}>
                {expanded ? 'Show fewer' : `+${list.length - 3} more ${list.length - 3 === 1 ? 'role' : 'roles'}`}
              </button>
            )}
          </section>
        );
      })}
      {ordered.length > limit && <button className="sa-button sa-load" onClick={() => setLimit(limit + 30)}>Show {Math.min(30, ordered.length - limit)} more companies</button>}
    </div>
  );
}

function Skeleton() {
  return <ul className="sa-rows sa-skeleton" aria-label="Loading roles">{Array.from({ length: 8 }, (_, i) => <li key={i}><span /><span /><span /></li>)}</ul>;
}

function Empty({ filters, clear, clearLast }: { filters: Filters; clear: () => void; clearLast: () => void }) {
  const active = [filters.query && `“${filters.query}”`, filters.remote && 'Remote', filters.withPay && 'Pay listed', filters.family, filters.segment !== 'all' && SEGMENTS.find(s => s.id === filters.segment)?.label].filter(Boolean);
  return (
    <div className="sa-empty">
      <span className="sa-empty-zero" aria-hidden="true">0</span>
      <p>No roles match {active.length ? active.join(' + ') : 'this view'}.</p>
      <div>
        {active.length > 1 && <button className="sa-button" onClick={clearLast}>Remove the last filter</button>}
        <button className="sa-link" onClick={clear}>Clear every filter</button>
      </div>
    </div>
  );
}

interface PaletteItem { kind: 'company' | 'role'; id: string; label: string; sub: string; score: number; href?: string }

function Palette({ open, onClose, companies, jobs, onPickCompany }: { open: boolean; onClose: () => void; companies: StartupCompany[]; jobs: StartupJob[]; onPickCompany: (id: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const byId = useMemo(() => new Map(companies.map(c => [c.id, c])), [companies]);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) { d.showModal?.(); setQuery(''); setActive(0); setTimeout(() => input.current?.focus(), 0); }
    if (!open && d.open) d.close();
  }, [open]);
  const results = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    if (!q) return companies.filter(c => c.fastestRank).sort((a, b) => a.fastestRank! - b.fastestRank!).slice(0, 6).map(c => ({ kind: 'company', id: c.id, label: c.name, sub: c.focus, score: 0 }));
    const cs = companies.map(c => ({ kind: 'company' as const, id: c.id, label: c.name, sub: c.focus, score: fuzzy(c.name, q) * 1.5 })).filter(r => r.score > 0);
    const rs = jobs.map(j => {
      const c = byId.get(j.companyId);
      return { kind: 'role' as const, id: j.id, label: j.title, sub: `${c?.name ?? ''} · ${j.location}`, href: j.url, score: Math.max(fuzzy(j.title, q), fuzzy(`${j.title} ${c?.name ?? ''}`, q) - 2) };
    }).filter(r => r.score >= q.replace(/\s+/g, '').length * 2.5);
    return [...cs.sort((a, b) => b.score - a.score).slice(0, 4), ...rs.sort((a, b) => b.score - a.score).slice(0, 8)];
  }, [query, companies, jobs, byId]);
  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (item.kind === 'company') { onPickCompany(item.id); onClose(); }
    else if (item.href) { window.open(item.href, '_blank', 'noopener'); onClose(); }
  };
  return (
    <dialog ref={dialog} className="sa-palette" onClose={onClose} onClick={e => { if (e.target === dialog.current) onClose(); }} aria-label="Search StartupAtlas">
      <div className="sa-palette-box">
        <label className="sa-palette-input">
          <Search size={17} strokeWidth={1.5} aria-hidden="true" />
          <input ref={input} value={query} placeholder="Jump to a company or role" aria-label="Search companies and roles" role="combobox" aria-expanded="true" aria-controls="sa-palette-list" aria-activedescendant={results[active] ? `sa-opt-${active}` : undefined}
            onChange={e => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
              if (e.key === 'Enter') { e.preventDefault(); choose(results[active]); }
            }} />
          <kbd>esc</kbd>
        </label>
        <ul id="sa-palette-list" role="listbox">
          {!query.trim() && <li className="sa-palette-label sa-mono" role="presentation">Fastest growing</li>}
          {results.map((r, i) => (
            <li key={`${r.kind}-${r.id}`} id={`sa-opt-${i}`} role="option" aria-selected={i === active} className={i === active ? 'on' : ''} onMouseEnter={() => setActive(i)} onClick={() => choose(r)}>
              <span className="sa-palette-kind" aria-hidden="true">{r.kind === 'company' ? <Building2 size={14} strokeWidth={1.5} /> : <ArrowUpRight size={14} strokeWidth={1.5} />}</span>
              <span className="sa-palette-text"><strong>{r.label}</strong><span>{r.sub}</span></span>
              <span className="sa-mono sa-palette-type">{r.kind}</span>
            </li>
          ))}
          {query.trim() && !results.length && <li className="sa-palette-none" role="presentation">Nothing matches “{query}”.</li>}
        </ul>
      </div>
    </dialog>
  );
}

export default function StartupAtlas() {
  const [theme, setThemeState] = useState<Theme>(() => storedTheme() ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const setTheme = (t: Theme) => { setThemeState(t); try { localStorage.setItem('startupatlas-theme', t); } catch { /* per-visitor only */ } };
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [history, setHistory] = useState<Filters[]>([]);
  const [palette, setPalette] = useState(false);
  const listTop = useRef<HTMLDivElement>(null);

  const overview = useQuery({ queryKey: ['startups', 'overview'], queryFn: () => get<StartupOverview>('/api/startups/overview') });
  const companiesQuery = useQuery({ queryKey: ['startups', 'companies'], queryFn: () => get<StartupCompany[]>('/api/startups/companies') });
  const jobsQuery = useQuery({ queryKey: ['startups', 'jobs'], queryFn: () => get<StartupJob[]>('/api/startups/jobs') });

  const companies = companiesQuery.data ?? [];
  const jobs = jobsQuery.data ?? [];
  const byId = useMemo(() => new Map(companies.map(c => [c.id, c])), [companies]);
  const filtered = useMemo(() => filterJobs(jobs, byId, filters), [jobs, byId, filters]);
  const families = useMemo(() => {
    const counts = new Map<Family, number>();
    for (const j of filterJobs(jobs, byId, { ...filters, family: null })) counts.set(family(j), (counts.get(family(j)) ?? 0) + 1);
    return FAMILIES.filter(f => counts.get(f)).map(f => [f, counts.get(f)!] as [Family, number]);
  }, [jobs, byId, filters]);
  const hiring = companies.filter(c => c.roleCount > 0).length;
  const selected = filters.company ? byId.get(filters.company) : undefined;

  const update = (next: Filters) => { setHistory(h => [...h.slice(-20), filters]); setFilters(next); };
  const pickCompany = (id: string | null) => {
    update({ ...filters, company: id, segment: id && !inSegment(byId.get(id)!, filters.segment) ? 'all' : filters.segment });
    if (id) requestAnimationFrame(() => listTop.current?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }));
  };

  // Fonts load through a plain link so a blocked font host never stops the
  // tab's own stylesheet from loading. The page falls back to system fonts.
  useEffect(() => {
    if (document.getElementById('sa-fonts')) return;
    const link = Object.assign(document.createElement('link'), { id: 'sa-fonts', rel: 'stylesheet', href: FONTS_URL });
    document.head.appendChild(link);
  }, []);
  useEffect(() => {
    document.title = 'StartupAtlas · Open roles at fast-growing startups';
    const meta = document.querySelector('meta[name="theme-color"]');
    const previous = meta?.getAttribute('content');
    meta?.setAttribute('content', theme === 'dark' ? '#0a0a0a' : '#fafafa');
    return () => { if (previous) meta?.setAttribute('content', previous); };
  }, [theme]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /input|textarea|select/i.test(e.target.tagName);
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const loading = companiesQuery.isLoading || jobsQuery.isLoading;
  const error = companiesQuery.error || jobsQuery.error;
  let body: ReactNode;
  if (error) body = <div className="sa-error"><p className="sa-mono">{(error as Error).message}</p><button className="sa-button" onClick={() => { companiesQuery.refetch(); jobsQuery.refetch(); }}>Retry</button></div>;
  else if (loading) body = <Skeleton />;
  else if (!jobs.length) body = <div className="sa-empty"><span className="sa-empty-zero" aria-hidden="true">0</span><p>No startup roles have been collected yet. The next refresh reads every company's public job board, so check back within two hours.</p></div>;
  else if (!filtered.length) body = <Empty filters={filters} clear={() => update(EMPTY_FILTERS)} clearLast={() => { const prev = history[history.length - 1]; if (prev) { setHistory(h => h.slice(0, -1)); setFilters(prev); } }} />;
  else body = <JobList jobs={filtered} companies={byId} selected={filters.company} onSelect={id => pickCompany(id)} />;

  return (
    <div className="sa-root" data-theme={theme}>
      <a className="sa-skip" href="#sa-roles">Skip to roles</a>
      <Topbar theme={theme} setTheme={setTheme} openPalette={() => setPalette(true)} />
      <main>
        <Hero overview={overview.data} hiring={hiring} />
        <Marquee companies={companies} onPick={id => pickCompany(id)} />
        <Bento companies={companies} onPick={id => pickCompany(id)} onSeeAll={() => { update({ ...filters, segment: 'fastest', company: null }); listTop.current?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' }); }} />
        <div ref={listTop} className="sa-anchor" />
        <FilterBar filters={filters} setFilters={update} count={filtered.length} families={families} openPalette={() => setPalette(true)} />
        <CompanyChips companies={companies} selected={filters.company} onSelect={pickCompany} segment={filters.segment} />
        <div className="sa-body">
          <Directory companies={companies} selected={filters.company} onSelect={pickCompany} segment={filters.segment} />
          <div className="sa-results" id="sa-roles">
            {selected && <CompanyCard company={selected} onClear={() => pickCompany(null)} />}
            {!selected || filtered.length ? body : <div className="sa-empty"><span className="sa-empty-zero" aria-hidden="true">0</span><p>{selected.roleCount ? 'None of this company’s roles match the current filters.' : 'This company has no open roles on a public board right now.'}</p></div>}
          </div>
        </div>
      </main>
      <footer className="sa-footer">
        <p>Roles come from each company’s public job board and link straight to the original posting. StartupAtlas never edits a listing.</p>
        <p className="sa-mono">Company list from the Breakout List and the 32 fastest-growing startups of the past 30 days{overview.data?.updatedAt ? ` · checked ${new Date(overview.data.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : ''}</p>
      </footer>
      <Palette open={palette} onClose={() => setPalette(false)} companies={companies} jobs={jobs} onPickCompany={id => pickCompany(id)} />
    </div>
  );
}
