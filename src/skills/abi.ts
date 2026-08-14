import { scriptExtension } from '../contracts/scriptEnvelope.js';
import type { SkillLanguage } from './types.js';

/**
 * SCRIPT-SKILL ABI — the calling convention between atoma and a compiled
 * skill script, in ONE module. Both dispatch paths (the L1-driven
 * untrusted path via skillContextBlock, and the zero-LLM trusted path in
 * runScriptSkillDirect) MUST agree on: where the scratch file lands, which
 * interpreter runs it, and what argv it receives. They used to derive
 * these independently in two places — any drift meant "script works on
 * one path, fails on the other", the least debuggable failure shape the
 * lifecycle can produce (counters move on one path only).
 *
 * The stdout envelope half of the ABI lives in
 * src/contracts/scriptEnvelope.ts (schema + strict parse + pre-flight
 * gate); this module owns the INVOCATION half.
 */

/** Sandbox-local scratch filename: `_skill_<id>.<ext>`. Extension policy
 * (.mjs, never bare .js) is scriptExtension's — see its comment. */
export function scriptScratchFilename(skillId: string, language: SkillLanguage): string {
  return `_skill_${skillId}.${scriptExtension(language)}`;
}

/** Interpreter binary for run_shell. All three appear in the run_shell allowlist. */
export function scriptInterpreter(language: SkillLanguage): string {
  return language === 'python' ? 'python3' : language;
}

/**
 * argv contract: ONE argument — the JSON-encoded subtask description.
 * Everything task-specific must be DERIVED by the script from the
 * workspace + this argument (compile prompt: NO TASK-SPECIFIC LITERALS).
 */
export function scriptArgv(subtaskDescription: string): string[] {
  return [JSON.stringify(subtaskDescription)];
}

/** Full run_shell argv for the trusted direct path. */
export function scriptInvocationArgv(
  filename: string,
  subtaskDescription: string
): string[] {
  return [filename, ...scriptArgv(subtaskDescription)];
}

/**
 * Human-readable form of the same ABI for the L1-driven prompt path.
 * The placeholder is intentionally executable-looking without encoding the
 * literal word "subtaskDescription" as the argument value.
 */
export function scriptInvocationArgvTemplate(filename: string): string {
  return `["${filename}", <JSON.stringify(subtaskDescription)>]`;
}
