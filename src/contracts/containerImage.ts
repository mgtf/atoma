import { z } from 'zod';

/** Content identity accepted by the local container engine, never a mutable tag. */
export const containerImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
