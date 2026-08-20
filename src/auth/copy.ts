/**
 * English copy for the server-owned authentication surface.
 *
 * The visualizer normally reads its strings from the shared i18n catalogs,
 * but the login selector is deliberately rendered before the React client is
 * available. Keep that small surface catalog-backed here instead of scattering
 * user-facing sentences through the HTTP router.
 */
export const AUTH_COPY = Object.freeze({
  pageTitle: 'Atoma — sign in',
  brand: 'Atoma',
  signInSubtitle: 'Sign in to view runs',
  invalidInvitation: 'Invalid invitation token.',
  invalidState: 'Missing or invalid login state.',
  replayedState: 'Login transaction expired or replayed — start again.',
  expiredState: 'Unknown or expired login transaction — start again.',
  providerRefused:
    'Login was refused by the provider. If you used an invitation, reopen its original link before trying again.',
  invalidAuthorizationCode: 'Missing or invalid authorization code.',
  invitationRequired: 'This account has not been invited to this instance.',
  providerFailure:
    'Login could not be completed. If you used an invitation, reopen its original link before trying again.',
});
