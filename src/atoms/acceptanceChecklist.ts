import type { GenerationParams, RunContext } from '../core/types.js';
import { modelForTier } from '../core/models.js';
import { extractJson } from './json.js';
import {
  MAX_CHECKLIST_BEHAVIOUR_CHARS,
  MAX_CHECKLIST_ITEMS,
  parseAcceptanceChecklist,
  type AcceptanceChecklist,
} from '../contracts/acceptanceChecklist.js';

/**
 * Drafting the acceptance checklist — docs/acceptance-checklist-2026-09-25.md.
 *
 * ONE call per run, on the cheapest tier, before the attempt loop (a
 * deepening does not redraft it). The system prompt is fixed but far below
 * the cacheable minimum, so it does not cache; the call is small by bounding
 * the output instead. It is a deliberate deviation from the acceptance
 * contract's "no extra LLM call" for its initial vocabulary, recorded in the
 * design. Its actor is `run-checklist` at the tier of the model it uses,
 * never `run-root`, whose calls are counted and read on their own.
 */
export const CHECKLIST_ACTOR = { name: 'run-checklist', tier: 1 } as const;

export const CHECKLIST_SYSTEM_PROMPT = [
  'You turn a software goal into a short checklist of behaviours a finished delivery must show.',
  'Output ONE JSON object and nothing else: {"items": [{"behaviour": string, "check": {...}}]}.',
  '',
  'RULES',
  `- At most ${MAX_CHECKLIST_ITEMS} items, each "behaviour" under ${MAX_CHECKLIST_BEHAVIOUR_CHARS} characters, in the goal's order.`,
  '- Only behaviours the goal ASKS FOR. Never add features, polish, tests or documentation it does not name.',
  '- "check" is {"kind": "http", "method": "GET", "path": "/api/items", "status": 404} ONLY when the goal itself',
  '  names BOTH the HTTP method and the path. Use ":name" for a path segment the goal leaves variable',
  '  ("/api/items/:id"). Give "status" only when the goal states it; omit it to mean any 2xx.',
  '- Every other behaviour is {"kind": "review"}: pages, interactions, CLI output, persistence, files, anything',
  '  whose method or path the goal does not spell out. Never invent a route.',
  '- A goal with nothing verifiable yields {"items": []}.',
  '',
  'EXAMPLE',
  'Goal: "Node API: GET /api/notes lists notes, POST /api/notes creates one, GET /api/notes/:id returns 404 for an',
  'unknown id. Add a page that shows the list."',
  '{"items": [',
  ' {"behaviour": "lists notes", "check": {"kind": "http", "method": "GET", "path": "/api/notes"}},',
  ' {"behaviour": "creates a note", "check": {"kind": "http", "method": "POST", "path": "/api/notes"}},',
  ' {"behaviour": "unknown note id is 404", "check": {"kind": "http", "method": "GET", "path": "/api/notes/:id", "status": 404}},',
  ' {"behaviour": "a page shows the list of notes", "check": {"kind": "review"}}',
  ']}',
].join('\n');

const CHECKLIST_PARAMS: GenerationParams = { temperature: 0, maxTokens: 1200 };

/**
 * Draft the checklist for a goal. Never throws: a transport error, a parse
 * failure or an abort yields [] and one warning, because the checklist is an
 * aid to the run and must never be the reason it stops.
 */
export async function draftAcceptanceChecklist(ctx: RunContext, goal: string): Promise<AcceptanceChecklist> {
  try {
    ctx.signal.throwIfAborted();
    const resp = await ctx.llm.complete({
      model: modelForTier(1),
      systemPrompt: CHECKLIST_SYSTEM_PROMPT,
      userContent: `Goal:\n${goal}`,
      params: CHECKLIST_PARAMS,
      signal: ctx.signal,
      role: 'draft-checklist',
      actor: CHECKLIST_ACTOR,
    });
    return parseAcceptanceChecklist(extractJson(resp.text));
  } catch (error) {
    ctx.logger.warn(`[checklist] no acceptance checklist for this run: ${(error as Error).message}`);
    return [];
  }
}
