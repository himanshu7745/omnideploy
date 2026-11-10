import type { ProviderId } from '../value-objects/ProviderId.js';

export type DeploymentState = 'queued' | 'building' | 'ready' | 'error' | 'canceled' | 'unknown';

export interface Deployment {
  provider: ProviderId;
  id: string;
  url?: string;
  state: DeploymentState;
  dashboardUrl?: string;
  /** Provider state to persist in omnideploy.json (e.g. a newly created siteId). */
  configUpdates?: Record<string, unknown>;
}

export interface DeploymentStatus {
  id: string;
  state: DeploymentState;
  url?: string;
  createdAt?: string;
  message?: string;
}
