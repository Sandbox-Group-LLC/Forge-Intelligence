import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import App from './App';
import Landing from './Landing';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route
          path="/context-agent/*"
          element={
            <AppProvider>
              <App />
            </AppProvider>
          }
        />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
