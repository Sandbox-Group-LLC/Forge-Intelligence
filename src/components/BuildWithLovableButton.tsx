import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Rocket, ExternalLink, Copy, Loader2 } from 'lucide-react';

type Phase = 'idle' | 'loading' | 'fallback' | 'error';

interface BuildWithLovableButtonProps {
  brandProfileId: string;
  brandName?: string;
  appType?: string;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
}

interface PromptPackResponse {
  success: boolean;
  data?: {
    platform: 'lovable';
    brandProfileId: string;
    appType: string;
    recommendedAppName: string;
    prompt: string;
    promptLength: number;
    encodedPrompt: string;
    encodedLength: number;
    buildUrl: string;
    isUrlSafe: boolean;
    fallbackRequired: boolean;
    brainConsumption: Record<string, boolean>;
  };
  error?: string;
  details?: string;
}

const ROCKET = (
  <Rocket size={16} strokeWidth={1.5} aria-hidden="true" />
);
const EXTERNAL = (
  <ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" />
);

export function BuildWithLovableButton({
  brandProfileId,
  brandName,
  appType = 'content-command-center',
  variant = 'primary',
  disabled = false,
}: BuildWithLovableButtonProps) {
  const { getToken } = useAuth();
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [fallbackPrompt, setFallbackPrompt] = useState<string>('');
  const [copyStatus, setCopyStatus] = useState<string>('');

  const isDisabled = disabled || phase === 'loading';

  const handleClick = async () => {
    if (isDisabled) return;
    setPhase('loading');
    setErrorMsg('');
    setCopyStatus('');
    try {
      const token = await getToken();
      const res = await fetch('/api/forge/prompt-pack/lovable', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ brandProfileId, appType, compact: true }),
      });
      const data: PromptPackResponse = await res.json();
      if (!res.ok || !data.success || !data.data) {
        const msg = data.details || data.error || `Request failed (${res.status})`;
        setErrorMsg(msg);
        setPhase('error');
        return;
      }
      const pack = data.data;
      if (pack.isUrlSafe) {
        window.open(pack.buildUrl, '_blank', 'noopener,noreferrer');
        setPhase('idle');
        return;
      }
      // Oversized URL — request the full prompt for clipboard fallback so the
      // user gets every byte of context, not the truncated compact version.
      let promptForFallback = pack.prompt;
      try {
        const fullRes = await fetch('/api/forge/prompt-pack/lovable', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ brandProfileId, appType, compact: false }),
        });
        const fullData: PromptPackResponse = await fullRes.json();
        if (fullRes.ok && fullData.success && fullData.data?.prompt) {
          promptForFallback = fullData.data.prompt;
        }
      } catch { /* fall back to the compact prompt we already have */ }
      setFallbackPrompt(promptForFallback);
      setPhase('fallback');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not generate Lovable prompt. Try again.';
      setErrorMsg(msg);
      setPhase('error');
    }
  };

  const handleCopy = async () => {
    if (!fallbackPrompt) return;
    try {
      await navigator.clipboard.writeText(fallbackPrompt);
      setCopyStatus('Copied. Paste into Lovable’s prompt box.');
    } catch {
      setCopyStatus('Clipboard blocked by browser. Select the prompt manually and copy.');
    }
  };

  const handleOpenLovable = () => {
    window.open('https://lovable.dev/', '_blank', 'noopener,noreferrer');
  };

  const handleDismissFallback = () => {
    setPhase('idle');
    setFallbackPrompt('');
    setCopyStatus('');
  };

  const handleRetry = () => {
    setPhase('idle');
    setErrorMsg('');
  };

  const primaryStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 36,
    padding: '0 18px',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    background: variant === 'primary' ? '#4F46E5' : '#fff',
    color: variant === 'primary' ? '#fff' : '#0F172A',
    border: variant === 'primary' ? '1px solid #4F46E5' : '1px solid #e2e8f0',
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    lineHeight: 1,
    boxSizing: 'border-box',
    margin: 0,
    opacity: isDisabled ? 0.6 : 1,
  };

  const label = phase === 'loading' ? 'Packing brand brain…' : 'Build with Lovable';
  const icon = phase === 'loading' ? <Loader2 size={16} strokeWidth={1.5} aria-hidden="true" style={{ animation: 'forge-spin 1s linear infinite' }} /> : ROCKET;

  return (
    <section
      aria-labelledby="deploy-this-brain-heading"
      style={{
        marginBottom: 16,
        padding: '18px 20px',
        background: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: 12,
      }}
    >
      <style>{`@keyframes forge-spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
        <div style={{ minWidth: 0, flex: '1 1 280px' }}>
          <h3
            id="deploy-this-brain-heading"
            style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#0F172A', letterSpacing: '-0.01em' }}
          >
            Deploy This Brain
          </h3>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b', lineHeight: 1.5 }}>
            Turn {brandName ? `${brandName}’s` : 'this'} Brand Brain into a working app.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <button
            type="button"
            onClick={handleClick}
            disabled={isDisabled}
            aria-busy={phase === 'loading'}
            title={disabled ? 'Brand profile is incomplete — run a full analysis first' : 'Open Lovable with this Brain pre-loaded'}
            style={primaryStyle}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center' }}>{icon}</span>
            <span>{label}</span>
            {phase !== 'loading' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', opacity: 0.75 }}>{EXTERNAL}</span>
            )}
          </button>
          {phase === 'error' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#B91C1C' }}>
              <span>{errorMsg || 'Could not generate Lovable prompt.'}</span>
              <button
                type="button"
                onClick={handleRetry}
                style={{
                  height: 24,
                  padding: '0 10px',
                  fontSize: 12,
                  fontWeight: 500,
                  border: '1px solid #FCA5A5',
                  background: '#fff',
                  color: '#B91C1C',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  lineHeight: 1,
                }}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </div>

      {phase === 'fallback' && (
        <div
          style={{
            marginTop: 14,
            padding: 14,
            background: '#F8FAFC',
            border: '1px solid #e2e8f0',
            borderRadius: 10,
          }}
        >
          <div style={{ fontSize: 13, color: '#0F172A', marginBottom: 8, lineHeight: 1.5 }}>
            This Brand Brain is too rich for a safe one-click URL. Copy the prompt and paste it into Lovable.
          </div>
          <textarea
            readOnly
            value={fallbackPrompt}
            spellCheck={false}
            style={{
              width: '100%',
              minHeight: 200,
              maxHeight: 360,
              padding: 12,
              fontSize: 12,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: '#1E293B',
              background: '#fff',
              border: '1px solid #CBD5E1',
              borderRadius: 8,
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={handleCopy}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 32,
                padding: '0 14px',
                fontSize: 12,
                fontWeight: 600,
                border: '1px solid #4F46E5',
                background: '#4F46E5',
                color: '#fff',
                borderRadius: 8,
                cursor: 'pointer',
                fontFamily: 'inherit',
                lineHeight: 1,
              }}
            >
              <Copy size={14} strokeWidth={1.5} aria-hidden="true" /> Copy Prompt
            </button>
            <button
              type="button"
              onClick={handleOpenLovable}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 32,
                padding: '0 14px',
                fontSize: 12,
                fontWeight: 500,
                border: '1px solid #e2e8f0',
                background: '#fff',
                color: '#0F172A',
                borderRadius: 8,
                cursor: 'pointer',
                fontFamily: 'inherit',
                lineHeight: 1,
              }}
            >
              <ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" /> Open Lovable
            </button>
            <button
              type="button"
              onClick={handleDismissFallback}
              style={{
                height: 32,
                padding: '0 12px',
                fontSize: 12,
                fontWeight: 500,
                border: 'none',
                background: 'transparent',
                color: '#64748b',
                cursor: 'pointer',
                fontFamily: 'inherit',
                lineHeight: 1,
              }}
            >
              Close
            </button>
            {copyStatus && (
              <span style={{ fontSize: 12, color: copyStatus.startsWith('Copied') ? '#15803D' : '#B45309' }}>
                {copyStatus}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default BuildWithLovableButton;
