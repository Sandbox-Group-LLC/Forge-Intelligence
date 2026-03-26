import { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { HistoryEntry } from '../../types';
import './BrainHistory.css';

// Lucide-style icons
const icons = {
  database: (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3"/>
      <path d="M3 5V19A9 3 0 0 0 21 19V5"/>
      <path d="M3 12A9 3 0 0 0 21 12"/>
    </svg>
  ),
  arrowRight: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14"/>
      <path d="m12 5 7 7-7 7"/>
    </svg>
  ),
  checkCircle: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
      <path d="m9 11 3 3L22 4"/>
    </svg>
  ),
  compareArrows: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m16 3 4 4-4 4"/>
      <path d="M20 7H4"/>
      <path d="m8 21-4-4 4-4"/>
      <path d="M4 17h16"/>
    </svg>
  )
};

export function BrainHistory() {
  const { historyEntries, setHistoryEntries, setCurrentView } = useApp();
  const [selectedEntries, setSelectedEntries] = useState<string[]>([]);
  const [filterBrand, setFilterBrand] = useState<string>('');

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatRelativeTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffHours < 1) return 'Just now';
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return formatDate(dateString);
  };

  // Get unique brands for filter
  const uniqueBrands = Array.from(new Set(historyEntries.map(e => e.brandName)));

  // Filter entries
  const filteredEntries = filterBrand
    ? historyEntries.filter(e => e.brandName === filterBrand)
    : historyEntries;

  // Group by brand
  const groupedEntries = filteredEntries.reduce((acc, entry) => {
    if (!acc[entry.brandName]) {
      acc[entry.brandName] = [];
    }
    acc[entry.brandName].push(entry);
    return acc;
  }, {} as Record<string, HistoryEntry[]>);

  const handleSelectEntry = (id: string) => {
    setSelectedEntries(prev => {
      if (prev.includes(id)) {
        return prev.filter(e => e !== id);
      }
      if (prev.length >= 2) {
        return [prev[1], id];
      }
      return [...prev, id];
    });
  };

  const handleSetActive = (entry: HistoryEntry) => {
    setHistoryEntries(historyEntries.map(e => ({
      ...e,
      isActive: e.id === entry.id
    })));
  };

  const handleViewProfile = () => {
    setCurrentView('brand-profile');
  };

  const canCompare = selectedEntries.length === 2;

  if (historyEntries.length === 0) {
    return (
      <div className="brain-history empty-state">
        <div className="empty-icon">{icons.database}</div>
        <h2 className="empty-title">No Brain History Yet</h2>
        <p className="empty-description">
          Run your first brand analysis to start building your intelligence memory.
        </p>
        <button className="btn-start" onClick={() => setCurrentView('new-analysis')}>
          Start New Analysis
        </button>
      </div>
    );
  }

  return (
    <div className="brain-history view-shell-centered">
      <div className="history-header">
        <div className="header-info">
          <h2 className="view-title">Brain History</h2>
          <p className="view-description">
            View and manage saved brand intelligence profiles
          </p>
        </div>
        <div className="header-stats">
          <div className="stat-item">
            <span className="stat-value">{historyEntries.length}</span>
            <span className="stat-label">Total Profiles</span>
          </div>
          <div className="stat-item">
            <span className="stat-value">{uniqueBrands.length}</span>
            <span className="stat-label">Brands</span>
          </div>
        </div>
      </div>

      <div className="history-controls">
        <div className="filter-section">
          <label className="filter-label">Filter by Brand</label>
          <select
            className="filter-select"
            value={filterBrand}
            onChange={(e) => setFilterBrand(e.target.value)}
          >
            <option value="">All Brands</option>
            {uniqueBrands.map(brand => (
              <option key={brand} value={brand}>{brand}</option>
            ))}
          </select>
        </div>

        {canCompare && (
          <button className="btn-compare">
            Compare Selected ({selectedEntries.length})
          </button>
        )}
      </div>

      <div className="history-content">
        {Object.entries(groupedEntries).map(([brandName, entries]) => (
          <div key={brandName} className="brand-group">
            <div className="brand-group-header">
              <div className="brand-info">
                <h3 className="brand-name">{brandName}</h3>
                <span className="brand-versions">{entries.length} version{entries.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="brand-status">
                {entries.some(e => e.isActive) && (
                  <span className="active-indicator">
                    <span className="active-dot"></span>
                    Active
                  </span>
                )}
              </div>
            </div>

            <div className="versions-list">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className={`version-card ${entry.isActive ? 'active' : ''} ${selectedEntries.includes(entry.id) ? 'selected' : ''}`}
                >
                  <div className="version-select">
                    <button
                      className={`select-checkbox ${selectedEntries.includes(entry.id) ? 'checked' : ''}`}
                      onClick={() => handleSelectEntry(entry.id)}
                      aria-label="Select for comparison"
                    >
                      {selectedEntries.includes(entry.id) && '✓'}
                    </button>
                  </div>

                  <div className="version-info">
                    <div className="version-header">
                      <span className="version-number">Version {entry.version}</span>
                      <span className="version-time">{formatRelativeTime(entry.timestamp)}</span>
                    </div>
                    <div className="version-meta">
                      <span className="meta-url">{entry.brandUrl.replace(/^https?:\/\//, '')}</span>
                      <span className="meta-dot">·</span>
                      <span className={`meta-cache ${entry.isCached ? 'cached' : 'fresh'}`}>
                        {entry.isCached ? 'Cached' : 'Fresh Run'}
                      </span>
                    </div>
                    <div className="version-date">{formatDate(entry.timestamp)}</div>
                  </div>

                  <div className="version-actions">
                    {entry.isActive ? (
                      <span className="active-badge">Active</span>
                    ) : (
                      <button
                        className="btn-set-active"
                        onClick={() => handleSetActive(entry)}
                      >
                        Set Active
                      </button>
                    )}
                    <button
                      className="btn-view"
                      onClick={handleViewProfile}
                    >
                      View
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {canCompare && (
        <div className="compare-panel">
          <div className="compare-info">
            <span className="compare-icon">⇄</span>
            <span className="compare-text">
              {selectedEntries.length} versions selected for comparison
            </span>
          </div>
          <div className="compare-actions">
            <button className="btn-clear" onClick={() => setSelectedEntries([])}>
              Clear
            </button>
            <button className="btn-compare-action">
              Compare Versions
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
