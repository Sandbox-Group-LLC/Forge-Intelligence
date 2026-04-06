import { StrictMode } from 'react';
import { ClerkProvider, RedirectToSignIn, useAuth } from '@clerk/clerk-react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import Landing from './Landing';
import Product from './Product';
import ContextAgentPage from './pages/ContextAgentPage';
import GeoStrategistPage from './pages/GeoStrategistPage';
import AuthenticityEnricherPage from './pages/AuthenticityEnricherPage';
import ContentGeneratorPage from './pages/ContentGeneratorPage';
import CampaignGeneratorPage from './pages/CampaignGeneratorPage';
import ComplianceGatePage from './pages/ComplianceGatePage';
import IntegrationsPage from './pages/IntegrationsPage';
import PublishingQueuePage from './pages/PublishingQueuePage';
import PublicArticlePage from './pages/PublicArticlePage';
import PublicArticlesLibraryPage from './pages/PublicArticlesLibraryPage';
import PerformanceDashboardPage from './pages/PerformanceDashboardPage';
import BrandSettingsPage from './pages/BrandSettingsPage';
import ContentLibraryPage from './pages/ContentLibraryPage';
import ContentImportPage from './pages/ContentImportPage';
import AdminPage from './pages/AdminPage';
import TopicQueuePage from './pages/TopicQueuePage';
import ReviewPage from './pages/ReviewPage';
import PrivacyPage from './pages/PrivacyPage';
import { RequirePaid } from './components/RequirePaid';
import './index.css';



// ── Global fetch interceptor — auto-injects Clerk auth token on all /api/ calls ──
const _origFetch = window.fetch.bind(window);
(window as any).fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? input
    : input instanceof URL ? input.href
    : (input as Request).url;
  if (url.startsWith('/api/')) {
    const token = (window as any).__forgeToken;
    if (token) {
      init = {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(init.headers || {}),
          'Authorization': `Bearer ${token}`,
        },
      };
    }
  }
  return _origFetch(input, init);
};

// God mode bootstrap — runs before any route renders
// Must happen here before AppContext initializes
(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('god') === 'ForgeCanvas') {
    localStorage.setItem('forge_god_mode', 'true');
    window.history.replaceState({}, '', '/app/context-hub');
  } else if (params.has('ungod')) {
    localStorage.removeItem('forge_god_mode');
    window.history.replaceState({}, '', '/app/context-hub');
  }
})();



// ── Dev auth gate — single layout route wrapping all /app/* ──
function AuthGate() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return null;
  if (!isSignedIn) return <RedirectToSignIn />;
  return <Outlet />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || "pk_live_Y2xlcmsuZm9yZ2VpbnRlbGxpZ2VuY2UuYWkk"}>
    <BrowserRouter>
      <Routes>
        {/* Marketing site */}
        <Route path="/" element={<Landing />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/product" element={<Product />} />

        {/* App — all product routes gated by Clerk auth */}
        <Route element={<AuthGate />}>
          <Route path="/app/context-hub/*" element={<AppProvider><ContextAgentPage /></AppProvider>} />
          <Route path="/app/geo-strategist" element={<AppProvider><RequirePaid featureName="Geo Strategist"><GeoStrategistPage /></RequirePaid></AppProvider>} />
          <Route path="/app/authenticity-enricher" element={<AppProvider><RequirePaid featureName="Authenticity Enricher"><AuthenticityEnricherPage /></RequirePaid></AppProvider>} />
          <Route path="/app/content-generator" element={<AppProvider><RequirePaid featureName="Content Generator"><ContentGeneratorPage /></RequirePaid></AppProvider>} />
          <Route path="/app/campaign-generator" element={<AppProvider><RequirePaid featureName="Campaign Generator"><CampaignGeneratorPage /></RequirePaid></AppProvider>} />
          <Route path="/app/compliance-gate" element={<AppProvider><RequirePaid featureName="Compliance Gate"><ComplianceGatePage /></RequirePaid></AppProvider>} />
          <Route path="/app/integrations" element={<AppProvider><RequirePaid featureName="Integrations"><IntegrationsPage /></RequirePaid></AppProvider>} />
          <Route path="/app/publishing-queue" element={<AppProvider><RequirePaid featureName="Publishing Queue"><PublishingQueuePage /></RequirePaid></AppProvider>} />
          <Route path="/app/performance" element={<AppProvider><RequirePaid featureName="Performance Dashboard"><PerformanceDashboardPage /></RequirePaid></AppProvider>} />
          <Route path="/app/content-library" element={<AppProvider><RequirePaid featureName="Content Library"><ContentLibraryPage /></RequirePaid></AppProvider>} />
          <Route path="/app/content-import" element={<AppProvider><RequirePaid featureName="Content Import"><ContentImportPage /></RequirePaid></AppProvider>} />
          <Route path="/app/admin" element={<AppProvider><RequirePaid featureName="Admin"><AdminPage /></RequirePaid></AppProvider>} />
          <Route path="/app/topic-queue" element={<AppProvider><RequirePaid featureName="Topic Queue"><TopicQueuePage /></RequirePaid></AppProvider>} />
          <Route path="/app/brand-settings" element={<AppProvider><RequirePaid featureName="Brand Settings"><BrandSettingsPage /></RequirePaid></AppProvider>} />
        </Route>

        {/* Public article viewer — no AppProvider needed */}
        <Route path="/articles/:brandSlug/:articleSlug" element={<PublicArticlePage />} />
        <Route path="/articles/:brandSlug" element={<PublicArticlesLibraryPage />} />
        <Route path="/articles" element={<PublicArticlesLibraryPage />} />

        {/* External review page — no AppProvider, no auth */}
        <Route path="/review/:token" element={<ReviewPage />} />

        {/* Legacy redirects — keep old paths working during transition */}
        <Route path="/context-hub/*" element={<Navigate to="/app/context-hub" replace />} />
        <Route path="/geo-strategist" element={<Navigate to="/app/geo-strategist" replace />} />
        <Route path="/authenticity-enricher" element={<Navigate to="/app/authenticity-enricher" replace />} />
        <Route path="/content-generator" element={<Navigate to="/app/content-generator" replace />} />
        <Route path="/campaign-generator" element={<Navigate to="/app/campaign-generator" replace />} />
        <Route path="/compliance-gate" element={<Navigate to="/app/compliance-gate" replace />} />
        <Route path="/integrations" element={<Navigate to="/app/integrations" replace />} />
        <Route path="/publishing-queue" element={<Navigate to="/app/publishing-queue" replace />} />
        <Route path="/performance" element={<Navigate to="/app/performance" replace />} />
      </Routes>
    </BrowserRouter>
    </ClerkProvider>
  </StrictMode>
);
