import { Rectangle } from 'pixi.js';
import type { RegistryType } from '../../../client/types.js';
import { taxonomyForTier } from '../../../../core/taxonomy.js';
import { elementForTool } from '../../../../contracts/toolTaxonomy.js';
import type { GpuRenderSnapshot, RendererCtx } from '../../gpu-renderer.js';
import { GPU_COLORS } from '../../theme.js';
import { truncate } from '../copy.js';
import { createScrollPane } from '../scroll-pane.js';

/**
 * Right-pane agent detail — ONE definition, shared by the Registry view and
 * the Runs view's atom selection. Name, rank and counters stay fixed; every
 * FACT about the type scrolls in a masked pane driven by the shared detail
 * wheel route, so its tail is reachable instead of silently overflowing the
 * panel (2026-08-14 review).
 *
 * IT SHOWS ITS SECTIONS UNDER HEADINGS. The pane used to render the system
 * prompt as one unlabelled monospace block and nothing else — no elements, no
 * parameters, no provenance — so the one thing it did show was also the one
 * thing you could not name. Every fact the registry payload carries is here,
 * each under its own heading.
 *
 * THE USER INSTRUCTION IS NAMED AND NOT SHOWN, on purpose. An agent type has a
 * system prompt; the instruction it receives is COMPOSED PER CALL from the
 * task, the plan and whatever skills were injected, so it belongs to a run and
 * not to a type. Leaving the heading out would suggest the type has no such
 * face; inventing a template here would show a prompt nobody ever sent. It
 * says where the real one is: an LLM event in Runs.
 */

const HEADING_GAP = 8;
const SECTION_GAP = 16;

export function drawAtomDetail(
  ctx: RendererCtx,
  snapshot: GpuRenderSnapshot,
  atom: RegistryType,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  const taxonomy = taxonomyForTier(atom.tier as 1 | 2 | 3);
  ctx.text(ctx.root, atom.name, x + 18, y + 16, { size: 16, weight: '700' });
  ctx.text(
    ctx.root,
    `L${atom.tier} ${snapshot.t(`rank.${taxonomy.rank}`)} · v${atom.version} · ✓${atom.successes}/✗${atom.failures}`,
    x + 18,
    y + 43,
    { size: 10, color: GPU_COLORS.tiers[atom.tier as 1 | 2 | 3] }
  );
  ctx.text(ctx.root, atom.description, x + 18, y + 67, {
    size: 11,
    color: GPU_COLORS.muted,
    width: width - 36,
  });

  const paneTop = y + 130;
  const pane = createScrollPane(ctx.root, {
    x,
    y: paneTop,
    width,
    height: y + height - paneTop,
    scrollY: ctx.detailScrollY,
  });
  const innerWidth = width - 36;
  let cursor = 0;

  const heading = (label: string): void => {
    ctx.text(pane.content, label.toUpperCase(), 18, cursor, {
      size: 9,
      weight: '700',
      color: GPU_COLORS.muted,
      width: innerWidth,
    });
    cursor += 14 + HEADING_GAP;
  };

  const body = (value: string, options: { mono?: boolean; muted?: boolean } = {}): void => {
    const drawn = ctx.text(pane.content, value, 18, cursor, {
      size: 10,
      ...(options.mono ? { mono: true } : {}),
      ...(options.muted ? { color: GPU_COLORS.muted } : {}),
      width: innerWidth,
    });
    cursor += Math.max(12, drawn.height) + SECTION_GAP;
  };

  // Elements first: for a molecule this is what it can actually DO, and for
  // the other ranks its emptiness is the invariant (only L1 holds tools).
  heading(snapshot.t('registry.detailElements'));
  if (atom.tools.length === 0) {
    body(snapshot.t('registry.detailNoTools'), { muted: true });
  } else {
    body(
      atom.tools
        .map((tool) => {
          const element = elementForTool(tool);
          return element ? `${element.symbol} · ${tool}` : tool;
        })
        .join('   '),
      { mono: true }
    );
  }

  heading(snapshot.t('registry.detailParams'));
  body(safeJson(atom.params), { mono: true });

  heading(snapshot.t('registry.detailProvenance'));
  body(`${atom.createdBy} · ${atom.createdAt}`, { mono: true, muted: true });

  heading(snapshot.t('registry.detailPrompt'));
  body(truncate(atom.systemPrompt, 5000), { mono: true });

  heading(snapshot.t('registry.detailInstruction'));
  body(snapshot.t('registry.detailInstructionHint'), { muted: true });

  pane.extend(cursor);
  ctx.detailScrollMax = pane.finish();
  ctx.detailScrollY = Math.min(ctx.detailScrollY, ctx.detailScrollMax);
  pane.content.position.y = -ctx.detailScrollY;
  ctx.detailBounds = new Rectangle(x, y, width, height);
}

/** Parameters are stored JSON; an unserialisable value must not blank the pane. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return '(unserialisable)';
  }
}
