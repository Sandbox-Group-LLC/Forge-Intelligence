import { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { AppShell } from '../layouts/AppShell';
import './TopicQueuePage.css';

interface TopicIdea {
  id: string;
  brand_profile_id: string;
  topic: string;
  note: string | null;
  status: 'idea' | 'in_progress' | 'generated';
  created_at: string;
}

type Filter = 'all' | 'idea' | 'in_progress' | 'generated';

const STATUS_LABEL: Record<string, string> = {
  idea: 'Idea', in_progress: 'In Progress', generated: 'Generated',
};
const STATUS_COLOR: Record<string, string> = {
  idea: 'var(--color-text-muted)', in_progress: '#F59E0B', generated: '#10B981',
};

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
  </svg>
);
const ArrowIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
  </svg>
);
const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);

function TopicRow({ t, ah, onUpdate, onDelete, onSend, sending, anySending }: {
  t: TopicIdea;
  ah: () => Record<string, string>;
  onUpdate: (id: string, fields: Partial<TopicIdea>) => void;
  onDelete: (id: string) => void;
  onSend: (t: TopicIdea) => void;
  sending: boolean;
  anySending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editTopic, setEditTopic] = useState(t.topic);
  const [editNote, setEditNote] = useState(t.note || '');
  const [saving, setSaving] = useState(false);
  const topicRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setEditTopic(t.topic);
    setEditNote(t.note || '');
    setEditing(true);
    setTimeout(() => topicRef.current?.focus(), 0);
  };

  const saveEdit = async () => {
    if (!editTopic.trim() || saving) return;
    setSaving(true);
    await fetch(`/api/topic-ideas/${t.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...ah() },
      body: JSON.stringify({ topic: editTopic.trim(), note: editNote.trim() || null }),
    });
    onUpdate(t.id, { topic: editTopic.trim(), note: editNote.trim() || null });
    setSaving(false);
    setEditing(false);
  };

  const cancelEdit = () => {
    setEditTopic(t.topic);
    setEditNote(t.note || '');
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
    if (e.key === 'Escape') cancelEdit();
  };

  return (
    <div className={`tq-row ${editing ? 'tq-row-editing' : ''}`}>
      <div className="tq-row-left">
        {editing ? (
          <div className="tq-edit-fields">
            <input
              ref={topicRef}
              className="tq-input tq-edit-topic"
              value={editTopic}
              onChange={e => setEditTopic(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Topic..."
            />
            <input
              className="tq-input tq-edit-note"
              value={editNote}
              onChange={e => setEditNote(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Notes, angle, target persona... (optional)"
            />
          </div>
        ) : (
          <div className="tq-row-content" onClick={startEdit} title="Click to edit">
            <div className="tq-topic">{t.topic}</div>
            {t.note && <div className="tq-note">{t.note}</div>}
          </div>
        )}
      </div>

      <div className="tq-row-right">
        {editing ? (
          <>
            <button className="tq-action-btn tq-save-btn" onClick={saveEdit} disabled={!editTopic.trim() || saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button className="tq-action-btn tq-cancel-btn" onClick={cancelEdit}>Cancel</button>
          </>
        ) : (
          <>
            <span className="tq-status" style={{ color: STATUS_COLOR[t.status] }}>
              ● {STATUS_LABEL[t.status]}
            </span>
            {t.status !== 'generated' && (
              <button
                className="tq-action-btn tq-send-btn"
                onClick={() => onSend(t)}
                disabled={anySending}
                title={anySending && !sending ? 'Another brief is building — wait for it to finish' : 'Build the brief and continue to Authenticity Enricher'}
              >
                {sending ? 'Building brief…' : <>Build brief <ArrowIcon /></>}
              </button>
            )}
            <button className="tq-action-btn tq-delete-btn" onClick={() => onDelete(t.id)}>
              <TrashIcon />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function TopicQueuePage() {
  const { activeBrand, authToken } = useApp();
  const brandProfileId = activeBrand?.id || '';
  const authTokenRef = useRef(authToken);
  useEffect(() => { authTokenRef.current = authToken; });

  const [topics, setTopics] = useState<TopicIdea[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [topic, setTopic] = useState('');
  // Tracks which row is mid-brief-build so the button can disable + label.
  // Single string instead of a Set because we serialize one brief build at a
  // time — the GEO endpoint is LLM-bound and parallel runs waste API spend.
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);

  const ah = (): Record<string, string> => {
    const t = authTokenRef.current || authToken || '';
    return t ? { 'Authorization': `Bearer ${t}` } : {};
  };

  useEffect(() => {
    if (!brandProfileId) return;
    setLoading(true);
    fetch(`/api/topic-ideas/${brandProfileId}`, { headers: ah() })
      .then(r => r.json())
      .then(d => { if (d.success) setTopics(d.ideas || []); })
      .finally(() => setLoading(false));
  }, [brandProfileId, authToken]);

  const addTopic = async () => {
    if (!topic.trim() || !brandProfileId || adding) return;
    setAdding(true);
    try {
      const r = await fetch('/api/topic-ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah() },
        body: JSON.stringify({ brandProfileId, topic: topic.trim(), note: note.trim() || null }),
      });
      const d = await r.json();
      if (d.success) { setTopics(prev => [d.idea, ...prev]); setTopic(''); setNote(''); }
    } finally { setAdding(false); }
  };

  const handleUpdate = (id: string, fields: Partial<TopicIdea>) => {
    setTopics(prev => prev.map(t => t.id === id ? { ...t, ...fields } : t));
  };

  const deleteTopic = async (id: string) => {
    await fetch(`/api/topic-ideas/${id}`, { method: 'DELETE', headers: ah() });
    setTopics(prev => prev.filter(t => t.id !== id));
  };

  const sendToGenerator = async (t: TopicIdea) => {
    if (sendingId) return;
    setSendingId(t.id);
    try {
      const r = await fetch('/api/geo/topic-brief/from-topic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ah() },
        body: JSON.stringify({ brandProfileId: t.brand_profile_id, topic: t.topic }),
      });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.error || 'Brief build failed');
      // Mark in_progress only after the brief builds successfully — avoids
      // status drift if the brief call fails and the user retries.
      fetch(`/api/topic-ideas/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...ah() },
        body: JSON.stringify({ status: 'in_progress' }),
      });
      setTopics(prev => prev.map(x => x.id === t.id ? { ...x, status: 'in_progress' } : x));
      window.location.href = `/app/authenticity-enricher?topicBriefId=${d.briefId}`;
    } catch (e) {
      alert(`Couldn't build brief from topic: ${(e as Error).message}`);
      setSendingId(null);
    }
  };

  const counts = {
    all: topics.length,
    idea: topics.filter(t => t.status === 'idea').length,
    in_progress: topics.filter(t => t.status === 'in_progress').length,
    generated: topics.filter(t => t.status === 'generated').length,
  };
  const filtered = filter === 'all' ? topics : topics.filter(t => t.status === filter);

  return (
    <AppShell>
      <div className="tq-page">
        <div className="geo-header" style={{ marginBottom: 32 }}>
          <div>
            <div className="geo-eyebrow">Publishing</div>
            <h1 className="geo-title">Topic Queue</h1>
            <p className="geo-description">Park ideas here. Send them to the generator when ready.</p>
          </div>
        </div>

        <div className="tq-add-card">
          <div className="tq-add-inputs">
            <input
              className="tq-input tq-topic-input"
              placeholder="Topic or working title..."
              value={topic}
              onChange={e => setTopic(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addTopic()}
            />
            <input
              className="tq-input tq-note-input"
              placeholder="Notes, angle, target persona... (optional)"
              value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addTopic()}
            />
          </div>
          <button className="tq-add-btn" onClick={addTopic} disabled={!topic.trim() || adding || !brandProfileId}>
            <PlusIcon /> {adding ? 'Adding...' : 'Add Topic'}
          </button>
        </div>

        <div className="tq-filters">
          {(['all', 'idea', 'in_progress', 'generated'] as Filter[]).map(f => (
            <button key={f} className={`tq-filter-tab ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : STATUS_LABEL[f]}
              <span className="tq-filter-count">{counts[f]}</span>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="tq-empty">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="tq-empty">
            {filter === 'all' ? 'No topics yet — add your first idea above.' : `No ${STATUS_LABEL[filter]} topics.`}
          </div>
        ) : (
          <div className="tq-list">
            {filtered.map(t => (
              <TopicRow key={t.id} t={t} ah={ah} onUpdate={handleUpdate} onDelete={deleteTopic} onSend={sendToGenerator} sending={sendingId === t.id} anySending={!!sendingId} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
