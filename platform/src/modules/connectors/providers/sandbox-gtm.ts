import type { ConnectorProvider } from '../registry';

// First connector — owned IP (Sandbox-GTM + Engage). Full API control, the
// dogfoodable anchor for the MVP consistency thread.
export const sandboxGtm: ConnectorProvider = {
  id: 'sandbox-gtm',
  name: 'Sandbox-GTM + Engage',
  category: 'event_management',
  authMode: 'api_key',
  direction: 'bidirectional',
  objects: ['contacts', 'accounts', 'sessions', 'session_attendance', 'engagements'],
  owned: true,
  status: 'planned',
};
