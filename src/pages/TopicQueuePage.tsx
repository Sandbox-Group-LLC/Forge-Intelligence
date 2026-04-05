import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { AppShell } from '../layouts/AppShell';
import './TopicQueuePage.css';

interface TopicIdea {
  id: string;
  brand_profile_id: string;
  topic: string;
  note: string;
  status: 'idea' | 'in_progress' | 'generated';
  created_at: string;
}

const STATUS_LABEL: Record<string, string> = {
  idea: 'Idea',
  in_progress: 'In Progress',
  generated: 'Generated',
};

const STATUS_COLOR: Record<string, string> = {
  idea: 'var(--color-text-muted)',
  in_progress: '#F59E0B',
  generated: '#10B981',
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

export default function TopicQueuePage() {
  const { activeBrandId } = useApp();
  const selectedBrand = activeBrandId || localStorage.getItem('forge_active_brand_id') || '';
  const [topics, setTopics] = useState<TopicIdea[]>([]);
  const filter = 'all' as const;


  useEffect(() => {
    if (!selectedBrand) return;
    fetch(`/api/topic-ideas/${selectedBrand}`).then(r => r.json()).then(d => {
      if (d.success) setTopics(d.ideas || d.data || []);
    });
  }, [selectedBrand]);


  const updateStatus = async (id: string, status: string) => {
    await fetch(`/api/topic-ideas/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    setTopics(prev => prev.map(t => t.id === id ? { ...t, status: status as any } : t));
  };

  const deleteTopic = async (id: string) => {
    await fetch(`/api/topic-ideas/${id}`, { method: 'DELETE' });
    setTopics(prev => prev.filter(t => t.id !== id));
  };

  const sendToGenerator = (t: TopicIdea) => {
    updateStatus(t.id, 'in_progress');
    window.location.href = `/app/content-generator?topic=${encodeURIComponent(t.topic)}&brand=${t.brand_profile_id}`;
  };

  const filtered = filter === 'all' ? topics : topics.filter(t => t.status === filter);

  return (
    <AppShell>
      <div className="tq-page">
        <div className="geo-header" style={{ marginBottom: 32 }}>
          <div>
            <div className="geo-eyebrow">Publishing</div>
            <h1 className="geo-title">Topic Queue</h1>
            <p className="geo-description">Park content ideas here. Send them to the generator when ready.</p>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="tq-empty">
            {filter === 'all' ? 'No topics yet. Add your first idea above.' : `No ${STATUS_LABEL[filter]} topics.`}
          </div>
        ) : (
          <div className="tq-list">
            {filtered.map(t => (
              <div key={t.id} className="tq-row">
                <div className="tq-row-left">
                  <div className="tq-topic">{t.topic}</div>
                  {t.note && <div className="tq-note">{t.note}</div>}
                </div>
                <div className="tq-row-right">
                  <span className="tq-status" style={{ color: STATUS_COLOR[t.status] }}>
                    ● {STATUS_LABEL[t.status]}
                  </span>
                  {t.status === 'idea' && (
                    <button className="tq-action-btn tq-send-btn" onClick={() => sendToGenerator(t)} title="Send to Content Generator">
                      Send to Generator <ArrowIcon />
                    </button>
                  )}
                  <button className="tq-action-btn tq-delete-btn" onClick={() => deleteTopic(t.id)} title="Delete">
                    <TrashIcon />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
