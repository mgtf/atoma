import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AUTH_LOGIN_PATH,
  redirectIfAuthenticationRequired,
  type AuthNavigator,
} from '../client/auth-session.js';

export interface AuthViewer {
  displayName: string;
  role: string;
  activeOrganisation: AuthOrganisation | null;
  organisations: AuthOrganisation[];
  /** Instance-wide operator flag; the server is the authority, this only shapes the UI. */
  platformAdmin: boolean;
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

interface AuthController {
  snapshot: AuthUiSnapshot | null;
  activate: (id: string) => void;
}

const AuthContext = createContext<AuthController | null>(null);

export function useAuthController(): AuthController {
  const controller = useContext(AuthContext);
  if (!controller) throw new Error('useAuthController must be used within AuthControls');
  return controller;
}

function replaceLocation(path: string): void {
  globalThis.location.replace(path);
}

export function AuthControls({
  active = true,
  children,
  t,
  fetchImpl = fetch,
  navigate = replaceLocation,
}: {
  active?: boolean;
  children?: ReactNode;
  t: (key: string, vars?: Record<string, unknown>) => string;
  fetchImpl?: typeof fetch;
  navigate?: AuthNavigator;
}) {
  const [viewer, setViewer] = useState<AuthViewer | null>(null);
  const [failure, setFailure] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [switchingOrganisationId, setSwitchingOrganisationId] = useState<string | null>(null);
  const signingOutRef = useRef(false);

  useEffect(() => {
    let active = true;
    void fetchImpl('/auth/whoami', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
      .then(async (response) => {
        if (redirectIfAuthenticationRequired(response.status, navigate)) return;
        if (!response.ok) return;
        const body = await response.json() as Record<string, unknown>;
        if (
          active &&
          body['authenticated'] === true &&
          typeof body['displayName'] === 'string' &&
          typeof body['role'] === 'string'
        ) {
          const organisations = Array.isArray(body['organisations'])
            ? body['organisations'].flatMap((candidate): AuthOrganisation[] => {
                if (
                  candidate === null ||
                  typeof candidate !== 'object' ||
                  typeof (candidate as Record<string, unknown>)['id'] !== 'string' ||
                  typeof (candidate as Record<string, unknown>)['name'] !== 'string' ||
                  typeof (candidate as Record<string, unknown>)['role'] !== 'string'
                ) return [];
                return [candidate as AuthOrganisation];
              })
            : [];
          const active = body['activeOrganisation'];
          const activeOrganisation =
            active !== null &&
            typeof active === 'object' &&
            typeof (active as Record<string, unknown>)['id'] === 'string' &&
            typeof (active as Record<string, unknown>)['name'] === 'string' &&
            typeof (active as Record<string, unknown>)['role'] === 'string'
              ? active as AuthOrganisation
              : null;
          setViewer({
            displayName: body['displayName'],
            role: body['role'],
            activeOrganisation,
            organisations,
            platformAdmin: body['platformAdmin'] === true,
          });
        }
      })
      .catch(() => {
        // A 404 is the normal auth-disabled developer path. Data queries own
        // general connectivity errors, so this optional control stays quiet.
      });
    return () => {
      active = false;
    };
  }, [fetchImpl, navigate]);

  const switchOrganisation = useCallback(async (orgId: string): Promise<void> => {
    if (switchingOrganisationId || signingOutRef.current) return;
    setFailure(false);
    setSwitchingOrganisationId(orgId);
    try {
      const response = await fetchImpl(
        `/auth/organisations/${encodeURIComponent(orgId)}/activate`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        }
      );
      if (!response.ok) throw new Error('organisation switch failed');
      navigate('/');
    } catch {
      setFailure(true);
    } finally {
      setSwitchingOrganisationId(null);
    }
  }, [fetchImpl, navigate, switchingOrganisationId]);

  const signOut = useCallback(async (): Promise<void> => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    setFailure(false);
    setSigningOut(true);
    try {
      const response = await fetchImpl('/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'text/html' },
      });
      if (!response.ok) throw new Error('logout failed');
      navigate(AUTH_LOGIN_PATH);
    } catch {
      setFailure(true);
    } finally {
      signingOutRef.current = false;
      setSigningOut(false);
    }
  }, [fetchImpl, navigate]);

  const activate = useCallback((id: string): void => {
    if (id === 'auth.signOut') void signOut();
    else if (id.startsWith('org.switch.')) void switchOrganisation(id.slice('org.switch.'.length));
  }, [signOut, switchOrganisation]);

  const snapshot = useMemo<AuthUiSnapshot | null>(() => viewer ? {
    viewer,
    failure,
    signingOut,
    switchingOrganisationId,
  } : null, [failure, signingOut, switchingOrganisationId, viewer]);
  const controller = useMemo<AuthController>(() => ({ snapshot, activate }), [activate, snapshot]);

  return (
    <AuthContext.Provider value={controller}>
      {children}
      {viewer && active ? (
        <aside className="gpu-a11y-bridge" aria-label={t('auth.account')}>
          <span title={viewer.role}>{t('auth.signedInAs', { name: viewer.displayName })}</span>
          {viewer.activeOrganisation ? (
            <span>{t('auth.organisation', { name: viewer.activeOrganisation.name })}</span>
          ) : null}
          {viewer.organisations
            .filter((organisation) => organisation.id !== viewer.activeOrganisation?.id)
            .map((organisation) => (
              <button
                key={organisation.id}
                type="button"
                disabled={switchingOrganisationId !== null}
                onClick={() => activate(`org.switch.${organisation.id}`)}
              >
                {t('auth.switchToOrganisation', { name: organisation.name })}
              </button>
            ))}
          <button
            type="button"
            disabled={signingOut}
            onClick={() => activate('auth.signOut')}
          >
            {t('auth.signOut')}
          </button>
          {failure ? <span role="alert">{t('auth.actionFailed')}</span> : null}
        </aside>
      ) : null}
    </AuthContext.Provider>
  );
}
