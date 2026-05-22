import { useState } from 'react';

interface SavedWebsite {
  credentials?: {
    endpointUrl?: string;
    format?: 'html' | 'markdown' | 'both';
    bearerToken?: string;
  };
  is_active?: boolean;
  updated_at?: string;
}

interface MyWebsiteFormProps {
  brandProfileId: string;
  saved: SavedWebsite | null;
  onChange: () => void;
}

type Format = 'html' | 'markdown' | 'both';

// Auth is injected automatically by the global fetch interceptor in main.tsx
// — no need to pass a token. All /api/ calls get the Clerk JWT attached.
export default function MyWebsiteForm({ brandProfileId, saved, onChange }: MyWebsiteFormProps) {
  const [endpointUrl, setEndpointUrl] = useState<string>(saved?.credentials?.endpointUrl || '');
  const [format, setFormat] = useState<Format>((saved?.credentials?.format as Format) || 'both');
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [tokenSaved, setTokenSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; status?: number; latencyMs?: number; error?: string; responseBody?: string } | null>(null);
  const [error, setError] = useState('');

  const hasToken = !!saved?.credentials?.bearerToken;
  const maskedToken = hasToken ? `forge_pub_••••${saved!.credentials!.bearerToken!.slice(-4)}` : '';

  const saveConfig = async () => {
    if (!endpointUrl.match(/^https?:\/\//i)) {
      setError('Endpoint URL must start with http:// or https://');
      return;
    }
    setSaving(true); setError('');
    try {
      const r = await fetch(`/api/integrations/website/${brandProfileId}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpointUrl, format }),
      });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.error || 'save failed');
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const generateToken = async () => {
    if (hasToken && !window.confirm('Rotating will immediately invalidate the current token. Your site will reject Forge publishes until you update the new token in your server environment. Continue?')) return;
    setGenerating(true); setError('');
    try {
      const r = await fetch(`/api/integrations/website/${brandProfileId}/generate-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.error || 'generate failed');
      setRevealedToken(d.bearerToken);
      setTokenSaved(false);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const runTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const r = await fetch(`/api/integrations/website/${brandProfileId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const d = await r.json();
      setTestResult(d);
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => setTokenSaved(true));
  };

  return (
    <div className="int-form-section int-website-form">
      {/* Endpoint URL */}
      <div className="int-form-label">Receiver endpoint URL</div>
      <input
        className="int-field-input"
        type="url"
        placeholder="https://yoursite.com/api/forge/publish"
        value={endpointUrl}
        onChange={e => setEndpointUrl(e.target.value)}
      />
      <div className="int-utm-hint">Forge will POST article payloads here. Your site implements the receiver.</div>

      {/* Format */}
      <div className="int-form-label" style={{ marginTop: 16 }}>Payload format</div>
      <div className="int-fields" style={{ flexDirection: 'row', gap: 16 }}>
        {(['html', 'markdown', 'both'] as Format[]).map(f => (
          <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="radio" name="website-format" value={f} checked={format === f} onChange={() => setFormat(f)} />
            <span style={{ textTransform: 'capitalize' }}>{f}</span>
          </label>
        ))}
      </div>
      <div className="int-utm-hint">
        {format === 'html' && 'Payload will include only the rendered HTML body.'}
        {format === 'markdown' && 'Payload will include only the source markdown.'}
        {format === 'both' && 'Payload will include both html and markdown — receiver picks.'}
      </div>

      {/* Save config */}
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button className="int-connect-btn" onClick={saveConfig} disabled={saving || !endpointUrl}>
          {saving ? 'Saving…' : 'Save config'}
        </button>
      </div>

      {/* Token section */}
      <div className="int-form-label" style={{ marginTop: 24 }}>Bearer token</div>
      {revealedToken ? (
        <div style={{ background: '#1a1a1a', border: '1px solid #f59e0b', borderRadius: 8, padding: 16, marginTop: 8 }}>
          <div style={{ color: '#f59e0b', fontWeight: 600, marginBottom: 8 }}>Save this now — you won't see it again</div>
          <code style={{ display: 'block', wordBreak: 'break-all', background: '#0a0a0a', padding: 12, borderRadius: 4, fontSize: 13, color: '#e5e5e5' }}>{revealedToken}</code>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="int-connect-btn" onClick={() => copyToClipboard(revealedToken)}>
              {tokenSaved ? 'Copied ✓' : 'Copy to clipboard'}
            </button>
            <button className="int-edit-btn" onClick={() => setRevealedToken(null)} disabled={!tokenSaved} title={tokenSaved ? 'Dismiss' : 'Copy the token first'}>
              I saved it — dismiss
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {hasToken ? <code style={{ fontSize: 13, color: '#888' }}>{maskedToken}</code> : <span style={{ color: '#888', fontSize: 13 }}>No token yet</span>}
          <button className="int-connect-btn" onClick={generateToken} disabled={generating}>
            {generating ? 'Generating…' : (hasToken ? 'Rotate token' : 'Generate token')}
          </button>
        </div>
      )}

      {/* Test publish */}
      <div className="int-form-label" style={{ marginTop: 24 }}>Test publish</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="int-connect-btn" onClick={runTest} disabled={testing || !hasToken || !saved?.credentials?.endpointUrl}>
          {testing ? 'Sending…' : 'Send test payload'}
        </button>
        <span className="int-utm-hint">Fires a sample article at your endpoint. Doesn't write to publish log.</span>
      </div>
      {testResult && (
        <div style={{ marginTop: 12, padding: 12, background: testResult.ok ? '#0a2e0a' : '#2e0a0a', border: `1px solid ${testResult.ok ? '#16a34a' : '#dc2626'}`, borderRadius: 6, fontSize: 13 }}>
          <div style={{ fontWeight: 600, color: testResult.ok ? '#16a34a' : '#dc2626', marginBottom: 4 }}>
            {testResult.ok ? '✓ Receiver responded successfully' : '✗ Test failed'}
          </div>
          {testResult.status != null && <div>HTTP {testResult.status} · {testResult.latencyMs}ms</div>}
          {testResult.error && <div style={{ color: '#fca5a5', marginTop: 4 }}>{testResult.error}</div>}
          {testResult.responseBody && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', color: '#aaa' }}>Response body</summary>
              <pre style={{ background: '#0a0a0a', padding: 8, borderRadius: 4, marginTop: 6, overflow: 'auto', maxHeight: 200, fontSize: 12 }}>{testResult.responseBody}</pre>
            </details>
          )}
        </div>
      )}

      {error && <div className="geo-error" style={{ marginTop: 12 }}>{error}</div>}
    </div>
  );
}
