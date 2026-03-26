import { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import './ActiveRun.css';

// Lucide-style icons
const icons = {
  check: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  alertCircle: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" x2="12" y1="8" y2="12"/>
      <line x1="12" x2="12.01" y1="16" y2="16"/>
    </svg>
  ),
  brain: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-1.54"/>
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-1.54"/>
    </svg>
  ),
  zap: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  )
};

const stageMessages: Record<string, string[]> = {
  ingest: [
    'Initializing signal collectors...',
    'Parsing domain structure...',
    'Extracting page metadata...'
  ],
  brain: [
    'Querying Brain for existing profiles...',
    'Checking cache freshness...',
    'Validating stored context...'
  ],
  scrape: [
    'Crawling primary site content...',
    'Analyzing competitor positioning...',
    'Extracting voice patterns...'
  ],
  synthesize: [
    'Building voice profile...',
    'Generating persona models...',
    'Mapping competitive whitespace...'
  ],
  save: [
    'Structuring brand profile...',
    'Persisting to Brain...',
    'Indexing for future retrieval...'
  ]
};

export function ActiveRun() {
  const { processingStages, analysisInput } = useApp();
  const [elapsedTime, setElapsedTime] = useState(0);
  const [activityLog, setActivityLog] = useState<{ time: number; message: string }[]>([]);

  const currentStage = processingStages.find(s => s.status === 'running');
  const completedCount = processingStages.filter(s => s.status === 'complete').length;
  const progress = (completedCount / processingStages.length) * 100;

  useEffect(() => {
    const startTime = Date.now();
    const timer = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (currentStage) {
      const messages = stageMessages[currentStage.id] || [];
      let messageIndex = 0;

      const addMessage = () => {
        if (messageIndex < messages.length) {
          setActivityLog(prev => [...prev, { time: elapsedTime, message: messages[messageIndex] }]);
          messageIndex++;
        }
      };

      addMessage();
      const interval = setInterval(addMessage, 800);

      return () => clearInterval(interval);
    }
  }, [currentStage?.id]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="active-run">
      <div className="run-header">
        <div className="run-title-section">
          <h2 className="view-title">Context Agent Running</h2>
          <p className="view-description">
            Analyzing {analysisInput.brandUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'brand'}
          </p>
        </div>
        <div className="elapsed-time">
          <span className="time-label">ELAPSED</span>
          <span className="time-value">{formatTime(elapsedTime)}</span>
        </div>
      </div>

      <div className="progress-section">
        <div className="progress-header">
          <span className="progress-label">Analysis Progress</span>
          <span className="progress-percent">{Math.round(progress)}%</span>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="stages-section">
        <h3 className="section-label">PROCESSING STAGES</h3>
        <div className="stages-list">
          {processingStages.map((stage, index) => (
            <div key={stage.id} className={`stage-item ${stage.status}`}>
              <div className="stage-indicator">
                {stage.status === 'complete' && <span className="stage-check">{icons.check}</span>}
                {stage.status === 'running' && <span className="stage-spinner" />}
                {stage.status === 'pending' && <span className="stage-number">{index + 1}</span>}
                {stage.status === 'error' && <span className="stage-error">{icons.alertCircle}</span>}
              </div>
              <div className="stage-content">
                <span className="stage-name">{stage.name}</span>
                {stage.status === 'running' && (
                  <span className="stage-status">Processing...</span>
                )}
                {stage.status === 'complete' && (
                  <span className="stage-status complete">Complete</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="activity-section">
        <h3 className="section-label">ACTIVITY LOG</h3>
        <div className="activity-log">
          {activityLog.length === 0 ? (
            <div className="activity-empty">Waiting for activity...</div>
          ) : (
            activityLog.map((entry, index) => (
              <div key={index} className="activity-entry">
                <span className="activity-time">{formatTime(entry.time)}</span>
                <span className="activity-message">{entry.message}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {analysisInput.checkBrainFirst && (
        <div className="brain-check-panel">
          <div className="panel-header">
            <span className="panel-icon">{icons.brain}</span>
            <span className="panel-title">Brain Check</span>
          </div>
          <div className="panel-content">
            <p className="panel-text">
              Looking for existing profile for this brand...
            </p>
            {completedCount >= 2 && (
              <div className="cache-result">
                <span className="cache-badge new">
                  <span className="badge-icon">{icons.zap}</span>
                  No Cache Hit
                </span>
                <span className="cache-message">Running fresh analysis</span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="signals-section">
        <h3 className="section-label">RETRIEVED SIGNALS</h3>
        <div className="signals-grid">
          {completedCount >= 1 && (
            <div className="signal-card fade-in">
              <div className="signal-source">Domain Analysis</div>
              <div className="signal-value">Primary site crawled</div>
              <div className="signal-confidence">
                <span className="confidence-bar" style={{ width: '95%' }} />
              </div>
            </div>
          )}
          {completedCount >= 3 && analysisInput.competitorUrls.length > 0 && (
            <div className="signal-card fade-in">
              <div className="signal-source">Competitor Data</div>
              <div className="signal-value">{analysisInput.competitorUrls.length} competitors analyzed</div>
              <div className="signal-confidence">
                <span className="confidence-bar" style={{ width: '88%' }} />
              </div>
            </div>
          )}
          {completedCount >= 4 && (
            <div className="signal-card fade-in">
              <div className="signal-source">Voice Profile</div>
              <div className="signal-value">5 tone attributes extracted</div>
              <div className="signal-confidence">
                <span className="confidence-bar" style={{ width: '92%' }} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
