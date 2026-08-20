/** Shared wire-value contracts for the browser OAuth boundary. */

export const OAUTH_STATE_BYTES = 24;
export const OAUTH_STATE_LENGTH = 32;
export const MAX_AUTHORIZATION_CODE_LENGTH = 8_192;
export const INVITATION_TOKEN_MIN_LENGTH = 43;
export const INVITATION_TOKEN_MAX_LENGTH = 128;
export const SESSION_TOKEN_LENGTH = 43;
/** Bound both cookie-tossing work and the SQLite logout revocation batch. */
export const MAX_LOGOUT_SESSION_CANDIDATES = 8;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function isOauthState(value: string | null): value is string {
  return value !== null && value.length === OAUTH_STATE_LENGTH && BASE64URL.test(value);
}

export function isAuthorizationCode(value: string | null): value is string {
  return value !== null &&
    value.length > 0 &&
    value.length <= MAX_AUTHORIZATION_CODE_LENGTH &&
    !hasControlCharacters(value);
}

export function isInvitationToken(value: string | null): value is string {
  return value !== null &&
    value.length >= INVITATION_TOKEN_MIN_LENGTH &&
    value.length <= INVITATION_TOKEN_MAX_LENGTH &&
    BASE64URL.test(value);
}

export function isSessionToken(value: string | null): value is string {
  return value !== null && value.length === SESSION_TOKEN_LENGTH && BASE64URL.test(value);
}

export function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
