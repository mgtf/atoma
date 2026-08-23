// The auth context, its shapes, and the hook that reads it. Split out of
// `AuthControls.tsx` so that file exports its component only: vite's Fast
// Refresh gives up on a module mixing a component with a hook.
import { createContext, useContext } from 'react';

export interface AuthViewer {
  displayName: string;
  role: string;
  activeOrganisation: AuthOrganisation | null;
  organisations: AuthOrganisation[];
  /** Instance-wide operator flag; the server is the authority, this only shapes the UI. */
  platformAdmin: boolean;
  /**
   * Stable account id. Only used as the seed for the procedural orb, so an
   * account with no picture still gets colours of its own.
   */
  principalId: string;
  /** Same-origin avatar URL (`/auth/avatar/...`), or null for the fallback orb. */
  avatarUrl: string | null;
  /** 'provider' while the name is still imported, 'user' once renamed here. */
  displayNameSource: 'provider' | 'user';
}

export interface AuthOrganisation {
  id: string;
  name: string;
  role: string;
}

export interface AuthUiSnapshot {
  viewer: AuthViewer;
  failure: boolean;
  signingOut: boolean;
  switchingOrganisationId: string | null;
}

/**
 * Where this browser stands with the gate. `unknown` is the pre-whoami
 * instant and network failure; `off` is the ungated developer path;
 * `unauthenticated` means the arrival gate must offer the providers below
 * instead of Continue.
 */
export type AuthGateStatus = 'unknown' | 'off' | 'unauthenticated' | 'authenticated';

export interface AuthProviderOption {
  id: string;
  label: string;
}

export interface AuthController {
  snapshot: AuthUiSnapshot | null;
  gate: AuthGateStatus;
  providers: AuthProviderOption[];
  activate: (id: string) => void;
}

const AuthContext = createContext<AuthController | null>(null);

export function useAuthController(): AuthController {
  const controller = useContext(AuthContext);
  if (!controller) throw new Error('useAuthController must be used within AuthControls');
  return controller;
}

export { AuthContext };

