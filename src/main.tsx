import { StrictMode } from 'react';
import { ClerkProvider } from '@clerk/clerk-react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import WelcomePage from './pages/WelcomePage';
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
import TermsPage from './pages/TermsPage';
import AcceptableUsePage from './pages/AcceptableUsePage';
import EmailCampaignPage from './pages/EmailCampaignPage';
import './index.css';



// ── Global fetch interceptor — auto-injects Clerk auth token on all /api/ calls ──
// Token is written to window.__forgeToken by AppContext on sign-in and refreshed every 55s.
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


createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || "pk_live_Y2xlcmsuZm9yZ2VpbnRlbGxpZ2VuY2UuYWkk"}>
    <BrowserRouter>
      <Routes>
        {/* Marketing site */}
        <Route path="/" element={<Landing />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/acceptable-use" element={<AcceptableUsePage />} />
        <Route path="/product" element={<Product />} />
        <Route path="/welcome" element={<WelcomePage />} />

        {/* App — all product routes live under /app/ */}
        <Route
          path="/app/context-hub/*"
          element={<AppProvider><ContextAgentPage /></AppProvider>}
        />
        <Route path="/app/geo-strategist" element={<AppProvider><GeoStrategistPage /></AppProvider>} />
        <Route path="/app/authenticity-enricher" element={<AppProvider><AuthenticityEnricherPage /></AppProvider>} />
        <Route path="/app/content-generator" element={<AppProvider><ContentGeneratorPage /></AppProvider>} />
        <Route path="/app/campaign-generator" element={<AppProvider><CampaignGeneratorPage /></AppProvider>} />
        <Route path="/app/email-campaign" element={<AppProvider><EmailCampaignPage /></AppProvider>} />
        <Route path="/app/compliance-gate" element={<AppProvider><ComplianceGatePage /></AppProvider>} />
        <Route path="/app/integrations" element={<AppProvider><IntegrationsPage /></AppProvider>} />
        <Route path="/app/publishing-queue" element={<AppProvider><PublishingQueuePage /></AppProvider>} />
        <Route path="/app/performance" element={<AppProvider><PerformanceDashboardPage /></AppProvider>} />
        <Route path="/app/content-library" element={<AppProvider><ContentLibraryPage /></AppProvider>} />
        <Route path="/app/content-import" element={<AppProvider><ContentImportPage /></AppProvider>} />
        <Route path="/app/mc" element={<AppProvider><AdminPage /></AppProvider>} />
        <Route path="/app/topic-queue" element={<AppProvider><TopicQueuePage /></AppProvider>} />
        <Route path="/app/brand-settings" element={<AppProvider><BrandSettingsPage /></AppProvider>} />

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
