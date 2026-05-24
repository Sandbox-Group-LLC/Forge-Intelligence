import { sandboxGtm } from './providers/sandbox-gtm';

// The Connector Fabric registry. Each provider declares how it connects
// (Nango-managed OAuth, API key, or inbound webhook) and which unified-record
// objects it maps to. Port: Forge `publishing_channels` credential pattern.
export type AuthMode = 'nango_oauth' | 'api_key' | 'webhook';
export type SyncDirection = 'inbound' | 'outbound' | 'bidirectional';
export type ProviderCategory =
  | 'event_management'
  | 'crm'
  | 'networking'
  | 'mobile'
  | 'lead_capture'
  | 'community';

export interface ConnectorProvider {
  id: string;
  name: string;
  category: ProviderCategory;
  authMode: AuthMode;
  direction: SyncDirection;
  objects: string[];
  owned?: boolean; // true = Sandbox IP
  status: 'live' | 'planned';
}

// MVP anchors on owned IP; open-API tools come next (research flagged
// HubSpot/Salesforce/Attio/Swapcard/Brella as open, RainFocus/Whova gated).
export const registry: Record<string, ConnectorProvider> = {
  [sandboxGtm.id]: sandboxGtm,
  hubspot: { id: 'hubspot', name: 'HubSpot', category: 'crm', authMode: 'nango_oauth', direction: 'bidirectional', objects: ['contacts', 'accounts', 'engagements'], status: 'planned' },
  swapcard: { id: 'swapcard', name: 'Swapcard', category: 'networking', authMode: 'nango_oauth', direction: 'inbound', objects: ['contacts', 'sessions', 'engagements'], status: 'planned' },
  cvent: { id: 'cvent', name: 'Cvent', category: 'event_management', authMode: 'nango_oauth', direction: 'inbound', objects: ['contacts', 'sessions', 'session_attendance'], status: 'planned' },
};

export function listProviders(): ConnectorProvider[] {
  return Object.values(registry);
}

export function getProvider(id: string): ConnectorProvider | undefined {
  return registry[id];
}
