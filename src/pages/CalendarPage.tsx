import { useState, useEffect, useMemo, useLayoutEffect } from 'react';
import { AppShell } from '../layouts/AppShell';
import { NoBrandEmpty } from '../components/NoBrandEmpty';
import { useApp } from '../context/AppContext';
import './CalendarPage.css';

// Apply wide-mode class to the outer .view-container as a fallback for browsers
// that don't support :has(). Runs synchronously on mount so the layout is correct
// before paint, then cleans up on unmount so other pages aren't affected.
function useWideLayout() {
  useLayoutEffect(() => {
    const el = document.querySelector('.view-container');
    if (el) el.classList.add('view-container-wide');
    return () => {
      const el2 = document.querySelector('.view-container');
      if (el2) el2.classList.remove('view-container-wide');
    };
  }, []);
}

type Stage = 'staged' | 'scheduled' | 'published';

interface QueueItem {
  id: string;
  title: string;
  status: string;
  channels: string[];
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string;
  publish_results?: Record<string, any>;
  content_id?: string;
}

// ── Icons ────────────────────────────────────────────────────────────────────
const ChevronLeft = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6"/>
  </svg>
);
const ChevronRight = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Determine which stage an item belongs to for calendar purposes
function stageOf(item: QueueItem): Stage | null {
  if (item.status === 'published' || item.published_at) return 'published';
  if (item.status === 'scheduled' && item.scheduled_at) return 'scheduled';
  if (item.status === 'staged') return 'staged';
  // archived, partial, etc. don't belong on the calendar
  return null;
}

// Pick the date that anchors an item on the calendar. Published first, then scheduled, then created.
function dateOf(item: QueueItem): Date | null {
  const raw = item.published_at || item.scheduled_at || item.created_at;
  if (!raw) return null;
  return new Date(raw);
}

// Return a Date set to local midnight for the given year/month/day (avoids UTC-vs-local drift)
function localMidnight(year: number, month: number, day: number): Date {
  return new Date(year, month, day, 0, 0, 0, 0);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

function CalendarPage() {
  useWideLayout();
  const { activeBrand, reportError } = useApp();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewDate, setViewDate] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  // Filter toggles — all three stages on by default
  const [visibleStages, setVisibleStages] = useState<Record<Stage, boolean>>({
    staged: true,
    scheduled: true,
    published: true,
  });
  const [selectedItem, setSelectedItem] = useState<QueueItem | null>(null);

  // Load the queue for the active brand
  useEffect(() => {
    if (!activeBrand?.id) return;
    setLoading(true);
    fetch(`/api/publishing/queue/${activeBrand.id}`)
      .then(r => r.json())
      .then(d => {
        if (d.success && Array.isArray(d.items)) setItems(d.items);
        else if (Array.isArray(d.queue)) setItems(d.queue);
        else if (Array.isArray(d)) setItems(d);
      })
      .catch(err => { console.error('[calendar] fetch failed:', err); reportError(err, { area: 'calendar' }); })
      .finally(() => setLoading(false));
  }, [activeBrand?.id]);

  // Build the month grid — 6 weeks of local-midnight dates
  const gridDays = useMemo(() => {
    const firstOfMonth = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
    const dayOfWeek = firstOfMonth.getDay();
    const gridStart = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1 - dayOfWeek);
    const days: Date[] = [];
    for (let i = 0; i < 42; i++) {
      days.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
    }
    return days;
  }, [viewDate]);

  // Bucket items by day
  const itemsByDay = useMemo(() => {
    const map = new Map<string, QueueItem[]>();
    for (const item of items) {
      const stage = stageOf(item);
      if (!stage || !visibleStages[stage]) continue;
      const d = dateOf(item);
      if (!d) continue;
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  }, [items, visibleStages]);

  const monthLabel = `${MONTHS[viewDate.getMonth()]} ${viewDate.getFullYear()}`;
  const todayMidnight = useMemo(() => {
    const t = new Date();
    return localMidnight(t.getFullYear(), t.getMonth(), t.getDate());
  }, []);

  const countsByStage: Record<Stage, number> = useMemo(() => {
    const c: Record<Stage, number> = { staged: 0, scheduled: 0, published: 0 };
    for (const item of items) {
      const s = stageOf(item);
      if (s) c[s]++;
    }
    return c;
  }, [items]);

  const goPrev = () => setViewDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  const goNext = () => setViewDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1));
  const goToday = () => {
    const d = new Date();
    setViewDate(new Date(d.getFullYear(), d.getMonth(), 1));
  };

  const pageTitle = activeBrand?.brandName ? `${activeBrand.brandName} Calendar` : 'Calendar';

  if (!activeBrand) {
    return (
      <AppShell pageTitle="Editorial Calendar">
        <NoBrandEmpty
          pageName="Editorial Calendar"
          pageDescription="See every article you have planned, scheduled, and published — across every campaign — in one calendar view."
          features={[
            'Drag-and-drop scheduling across days and weeks',
            'Color-coded by campaign and channel',
            'Spot publishing gaps and overlaps before they happen',
            'Coordinate publishing time with your team review cadence',
          ]}
        />
      </AppShell>
    );
  }

  return (
    <AppShell pageTitle={pageTitle}>
      <div className="cal-page">
        <div className="cal-toolbar">
          <div className="cal-nav">
            <button className="cal-nav-btn" onClick={goPrev} title="Previous month"><ChevronLeft /></button>
            <div className="cal-month-label">{monthLabel}</div>
            <button className="cal-nav-btn" onClick={goNext} title="Next month"><ChevronRight /></button>
            <button className="cal-today-btn" onClick={goToday}>Today</button>
          </div>

          <div className="cal-filters">
            <button
              className={`cal-filter-btn stage-staged ${visibleStages.staged ? 'on' : 'off'}`}
              onClick={() => setVisibleStages(s => ({ ...s, staged: !s.staged }))}
            >
              <span className="cal-filter-dot" />
              Staged
              <span className="cal-filter-count">{countsByStage.staged}</span>
            </button>
            <button
              className={`cal-filter-btn stage-scheduled ${visibleStages.scheduled ? 'on' : 'off'}`}
              onClick={() => setVisibleStages(s => ({ ...s, scheduled: !s.scheduled }))}
            >
              <span className="cal-filter-dot" />
              Scheduled
              <span className="cal-filter-count">{countsByStage.scheduled}</span>
            </button>
            <button
              className={`cal-filter-btn stage-published ${visibleStages.published ? 'on' : 'off'}`}
              onClick={() => setVisibleStages(s => ({ ...s, published: !s.published }))}
            >
              <span className="cal-filter-dot" />
              Published
              <span className="cal-filter-count">{countsByStage.published}</span>
            </button>
          </div>
        </div>

        {!activeBrand && (
          <div className="cal-empty-state">
            Select a brand from the sidebar to view its content calendar.
          </div>
        )}

        {activeBrand && (
          <div className="cal-grid-wrap">
            <div className="cal-daynames">
              {DAYS.map(d => <div key={d} className="cal-dayname">{d}</div>)}
            </div>
            <div className="cal-grid">
              {gridDays.map((day, idx) => {
                const inMonth = day.getMonth() === viewDate.getMonth();
                const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
                const dayItems = itemsByDay.get(key) || [];
                const isToday = sameDay(day, todayMidnight);
                return (
                  <div
                    key={idx}
                    className={`cal-cell ${inMonth ? 'in-month' : 'out-month'} ${isToday ? 'today' : ''}`}
                  >
                    <div className="cal-cell-header">
                      <span className="cal-cell-day">{day.getDate()}</span>
                      {isToday && <span className="cal-cell-today-dot" />}
                    </div>
                    <div className="cal-cell-items">
                      {dayItems.map(item => {
                        const stage = stageOf(item);
                        if (!stage) return null;
                        return (
                          <button
                            key={item.id}
                            className={`cal-item stage-${stage}`}
                            onClick={() => setSelectedItem(item)}
                            title={item.title}
                          >
                            <span className="cal-item-dot" />
                            <span className="cal-item-title">{item.title}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {loading && activeBrand && <div className="cal-loading">Loading calendar…</div>}

        {selectedItem && (
          <div className="cal-modal-backdrop" onClick={() => setSelectedItem(null)}>
            <div className="cal-modal" onClick={e => e.stopPropagation()}>
              <button className="cal-modal-close" onClick={() => setSelectedItem(null)}>✕</button>
              <div className={`cal-modal-stage stage-${stageOf(selectedItem)}`}>
                <span className="cal-item-dot" />
                {stageOf(selectedItem)?.toUpperCase()}
              </div>
              <h3 className="cal-modal-title">{selectedItem.title}</h3>
              <div className="cal-modal-meta">
                {selectedItem.scheduled_at && (
                  <div><strong>Scheduled:</strong> {new Date(selectedItem.scheduled_at).toLocaleString()}</div>
                )}
                {selectedItem.published_at && (
                  <div><strong>Published:</strong> {new Date(selectedItem.published_at).toLocaleString()}</div>
                )}
                {!selectedItem.scheduled_at && !selectedItem.published_at && (
                  <div><strong>Created:</strong> {new Date(selectedItem.created_at).toLocaleString()}</div>
                )}
                {Array.isArray(selectedItem.channels) && selectedItem.channels.length > 0 && (
                  <div><strong>Channels:</strong> {selectedItem.channels.join(', ')}</div>
                )}
              </div>
              <div className="cal-modal-actions">
                <a className="cal-modal-btn primary" href="/app/publishing-queue">Open in Queue</a>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

export default CalendarPage;
