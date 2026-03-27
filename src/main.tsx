import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import Landing from './Landing';
import ContextAgentPage from './pages/ContextAgentPage';
import GeoStrategistPage from './pages/GeoStrategistPage';
import AuthenticityEnricherPage from './pages/AuthenticityEnricherPage';
import ContentGeneratorPage from './pages/ContentGeneratorPage';
import CampaignGeneratorPage from './pages/CampaignGeneratorPage';
import ComplianceGatePage from './pages/ComplianceGatePage';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Marketing site */}
        <Route path="/" element={<Landing />} />

        {/* App — all product routes live under /app/ */}
        <Route path="/app" element={<Navigate to="/app/context-hub" replace />} />
        <Route
          path="/app/context-hub/*"
          element={<AppProvider><ContextAgentPage /></AppProvider>}
        />
        <Route path="/app/geo-strategist" element={<AppProvider><GeoStrategistPage /></AppProvider>} />
        <Route path="/app/authenticity-enricher" element={<AppProvider><AuthenticityEnricherPage /></AppProvider>} />
        <Route path="/app/content-generator" element={<AppProvider><ContentGeneratorPage /></AppProvider>} />
        <Route path="/app/campaign-generator" element={<AppProvider><CampaignGeneratorPage /></AppProvider>} />
        <Route path="/app/compliance-gate" element={<AppProvider><ComplianceGatePage /></AppProvider>} />

        {/* Legacy redirects — keep old paths working during transition */}
        <Route path="/context-hub/*" element={<Navigate to="/app/context-hub" replace />} />
        <Route path="/geo-strategist" element={<Navigate to="/app/geo-strategist" replace />} />
        <Route path="/authenticity-enricher" element={<Navigate to="/app/authenticity-enricher" replace />} />
        <Route path="/content-generator" element={<Navigate to="/app/content-generator" replace />} />
        <Route path="/campaign-generator" element={<Navigate to="/app/campaign-generator" replace />} />
        <Route path="/compliance-gate" element={<Navigate to="/app/compliance-gate" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
