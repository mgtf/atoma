import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { canonicalGitHubId } from './config.js';
import {
  type GitHubInstallationStatus,
  type GitHubStore,
  type GitHubWebhookMutation,
} from './store.js';

export const GITHUB_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

export type GitHubWebhookErrorCode =
  | 'invalid_signature'
  | 'body_too_large'
  | 'invalid_headers'
  | 'invalid_payload'
  | 'wrong_app';

export class GitHubWebhookError extends Error {
  readonly code: GitHubWebhookErrorCode;

  constructor(code: GitHubWebhookErrorCode, message: string) {
    super(message);
    this.name = 'GitHubWebhookError';
    this.code = code;
  }
}

export interface ProcessGitHubWebhookInput {
  readonly store: GitHubStore;
  readonly appId: string;
  readonly webhookSecret: string;
  /** Exact bytes received from the network, before JSON parsing. */
  readonly rawBody: Buffer | Uint8Array;
  readonly signature: string | undefined;
  readonly deliveryId: string | undefined;
  readonly event: string | undefined;
  readonly receivedAt?: Date | number;
}

export interface ProcessGitHubWebhookResult {
  readonly accepted: true;
  readonly duplicate: boolean;
  readonly applied: boolean;
}

/** Verify `X-Hub-Signature-256` over the exact, unparsed request body. */
export function verifyGitHubWebhookSignature(
  secret: string,
  rawBody: Buffer | Uint8Array,
  signature: string | undefined
): boolean {
  const bytes = Buffer.from(rawBody);
  const expected = createHmac('sha256', secret).update(bytes).digest();
  const match = /^sha256=([0-9a-f]{64})$/.exec(signature ?? '');
  // Always compare two equal-size buffers so malformed input takes the same final primitive.
  const supplied = match ? Buffer.from(match[1]!, 'hex') : Buffer.alloc(expected.length);
  const equal = timingSafeEqual(expected, supplied);
  return match !== null && equal;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubWebhookError('invalid_payload', `${label} has an invalid shape`);
  }
  return value as Record<string, unknown>;
}

function parsePayload(rawBody: Buffer): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
  } catch {
    throw new GitHubWebhookError('invalid_payload', 'GitHub webhook body is not valid UTF-8');
  }
  try {
    return object(JSON.parse(text) as unknown, 'GitHub webhook payload');
  } catch (error) {
    if (error instanceof GitHubWebhookError) throw error;
    throw new GitHubWebhookError('invalid_payload', 'GitHub webhook body is not valid JSON');
  }
}

function installationMutation(
  payload: Record<string, unknown>,
  event: string,
  expectedAppId: string
): GitHubWebhookMutation | undefined {
  if (event !== 'installation' && event !== 'installation_repositories') return undefined;
  const installation = object(payload['installation'], 'GitHub webhook installation');
  const appId = canonicalGitHubId(installation['app_id'], 'GitHub webhook App id');
  if (appId !== expectedAppId) {
    throw new GitHubWebhookError('wrong_app', 'GitHub webhook installation belongs to another App');
  }
  const installationId = canonicalGitHubId(
    installation['id'],
    'GitHub webhook installation id'
  );
  if (event === 'installation_repositories') {
    return Object.freeze({ kind: 'touch', installationId });
  }

  const action = payload['action'];
  if (typeof action !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(action)) {
    throw new GitHubWebhookError('invalid_payload', 'GitHub webhook action has an invalid value');
  }
  let status: GitHubInstallationStatus | undefined;
  switch (action) {
    case 'created':
    case 'unsuspend':
    case 'new_permissions_accepted':
      status = 'active';
      break;
    case 'suspend':
      status = 'suspended';
      break;
    case 'deleted':
      status = 'deleted';
      break;
    default:
      return undefined;
  }
  return Object.freeze({ kind: 'transition', installationId, status });
}

/** Authenticate, parse, deduplicate, and atomically apply installation state changes. */
export function processGitHubWebhook(
  input: ProcessGitHubWebhookInput
): ProcessGitHubWebhookResult {
  const rawBody = Buffer.from(input.rawBody);
  if (rawBody.byteLength > GITHUB_WEBHOOK_MAX_BODY_BYTES) {
    throw new GitHubWebhookError('body_too_large', 'GitHub webhook body exceeds the byte limit');
  }
  if (!verifyGitHubWebhookSignature(input.webhookSecret, rawBody, input.signature)) {
    throw new GitHubWebhookError('invalid_signature', 'GitHub webhook signature is invalid');
  }
  if (
    !input.deliveryId ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(input.deliveryId) ||
    !input.event ||
    !/^[a-z][a-z0-9_]{0,99}$/.test(input.event)
  ) {
    throw new GitHubWebhookError('invalid_headers', 'GitHub webhook headers are invalid');
  }
  const appId = canonicalGitHubId(input.appId, 'GitHub App id');
  const payload = parsePayload(rawBody);
  const mutation = installationMutation(payload, input.event, appId);
  const delivery = input.store.recordWebhookDelivery({
    deliveryId: input.deliveryId,
    event: input.event,
    payloadSha256: createHash('sha256').update(rawBody).digest('hex'),
    ...(mutation === undefined ? {} : { mutation }),
    ...(input.receivedAt === undefined ? {} : { receivedAt: input.receivedAt }),
  });
  return Object.freeze({
    accepted: true,
    duplicate: delivery.duplicate,
    applied: delivery.applied,
  });
}
