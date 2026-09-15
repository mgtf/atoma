import { z } from 'zod';

/** Public namespace metadata: no prompts, project details, or credentials. */
export const skillNamespaceInfoSchema = z.object({
  name: z.string().min(1).max(128),
  tools: z.array(z.string().min(1).max(128)).max(256),
}).strict();
export type SkillNamespaceInfo = z.infer<typeof skillNamespaceInfoSchema>;
