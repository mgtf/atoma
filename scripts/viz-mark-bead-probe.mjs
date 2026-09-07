/* global document, window, requestAnimationFrame, cancelAnimationFrame, OffscreenCanvas, createImageBitmap */

/** Read the actual live refraction input, never re-render or pin the crystal:
 * a settled pose concealed the mask's stale on-screen transform. */
export async function assertLiveMarkBead(page) {
  const counts = await page.evaluate(async () => {
    const handle = window.__ATOMA_GPU__;
    handle.pinMarkElapsedMs(null);
    handle.setMarkBeadVisible(true);
    const renderer = handle.app.renderer;
    const render = renderer.render;
    let capture = null;
    renderer.render = function (options, ...rest) {
      const result = render.call(this, options, ...rest);
      if (options.container?.label === 'mark-behind-glass') {
        const interior = options.container.children.find((child) => child.label === 'mark-interior');
        const core = interior.children.find((child) => child.label === 'mark-core');
        // Save the bead position from THIS capture, which runs at a lower
        // cadence than the shell. Reading its next pose would test stale UVs.
        capture = { target: options.target, x: core.x / 28, y: core.y / 28 };
      }
      return result;
    };
    const samples = [];
    try {
      for (let sample = 0; sample < 3; sample += 1) {
        capture = null;
        for (let frame = 0; frame < 12; frame += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        if (!capture) throw new Error('The live crystal did not capture its interior');
        // Passing a Texture reads the rendered bytes; passing its Container
        // would perform a new pass and could repair the bug under test.
        const image = renderer.extract.canvas(capture.target);
        const { width, height } = image;
        // Pixi's pooled 2D extraction context omits willReadFrequently and
        // emits a browser performance warning after repeated readbacks. Own
        // this diagnostic-only context so the normal smoke stays noise-free.
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        const { data: pixels } = ctx.getImageData(0, 0, width, height);
        const cx = Math.round(capture.x * width);
        const cy = Math.round(capture.y * height);
        const radius = Math.ceil(width / 28);
        let bright = 0;
        for (let y = Math.max(0, cy - radius); y < Math.min(height, cy + radius); y += 1) {
          for (let x = Math.max(0, cx - radius); x < Math.min(width, cx + radius); x += 1) {
            const i = (y * width + x) * 4;
            if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) >= 180) bright += 1;
          }
        }
        samples.push(bright);
      }
    } finally {
      renderer.render = render;
    }
    return samples;
  });
  if (counts.some((count) => count < 20)) {
    throw new Error(`Live crystal lost its bead in the refraction input: bright pixels ${counts.join(', ')}`);
  }
  console.log(`viz live crystal bead: bright pixels ${counts.join(', ')}`);
}

/** Compare the actual composed page, excluding the crystal's own footprint. */
async function assertVisibleCompactCaustics(page) {
  const compact = await page.evaluate(() => document.querySelector('.gpu-scene-camera')
    ?.getAttribute('data-scene-camera-mode') === 'focus');
  if (!compact) return;
  const bounds = await page.evaluate(() => {
    const h = window.__ATOMA_GPU__;
    h.app.stop();
    // Freeze simulation, but keep presenting: WebGL discards its drawing
    // buffer between frames, so a stopped canvas is not a readable screenshot.
    const paint = () => {
      h.app.render();
      h.causticProbeFrame = requestAnimationFrame(paint);
    };
    paint();
    const field = h.app.stage.children.flatMap((child) => child.children ?? [])
      .find((child) => child.label === 'far-field');
    if (!field) throw new Error('Missing compact caustic receiver');
    // A headless page screenshot can preserve invalid zero-alpha RGB that
    // the desktop window compositor drops. Read the receiver through an
    // ordinary transparent 2D canvas as well: visible light needs coverage.
    const captureAlpha = () => {
      const rendered = h.app.renderer.extract.canvas({ target: h.app.stage, frame: h.app.screen });
      const canvas = new OffscreenCanvas(rendered.width, rendered.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(rendered, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const litAlpha = captureAlpha();
    field.renderable = false;
    let darkAlpha;
    try {
      darkAlpha = captureAlpha();
    } finally {
      field.renderable = true;
    }
    let coveredLight = 0;
    for (let i = 3; i < litAlpha.length; i += 4) {
      if (litAlpha[i] - darkAlpha[i] >= 12) coveredLight += 1;
    }
    if (coveredLight < 12) throw new Error('Caustic light has no compositable alpha coverage');
    const target = h.hitTargets().find((entry) => entry.id === 'brand.crystal');
    if (!target) throw new Error('Missing crystal canvas target');
    const a = h.projectRendererPoint(target.x, target.y);
    const b = h.projectRendererPoint(target.x + target.width, target.y + target.height);
    return { left: a.x, top: a.y, right: b.x, bottom: b.y };
  });
  const setReceiver = (renderable) => page.evaluate((value) => {
    const h = window.__ATOMA_GPU__;
    const field = h.app.stage.children.flatMap((child) => child.children ?? [])
      .find((child) => child.label === 'far-field');
    if (!field) throw new Error('Missing compact caustic receiver');
    field.renderable = value;
    h.app.render();
  }, renderable);
  try {
    const lit = await page.screenshot({ encoding: 'base64' });
    await setReceiver(false);
    const dark = await page.screenshot({ encoding: 'base64' });
    const changed = await page.evaluate(async ({ lit, dark, bounds }) => {
      const pixels = async (encoded) => {
        const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        return context.getImageData(0, 0, canvas.width, canvas.height);
      };
      const a = await pixels(lit);
      const b = await pixels(dark);
      const scale = a.width / window.innerWidth;
      let changed = 0;
      for (let y = Math.max(0, Math.floor((bounds.top - 80) * scale));
        y < Math.min(a.height, (bounds.bottom + 80) * scale); y += 1) {
        for (let x = Math.max(0, Math.floor((bounds.left - 80) * scale));
          x < Math.min(a.width, (bounds.right + 80) * scale); x += 1) {
          if (x / scale >= bounds.left - 2 && x / scale <= bounds.right + 2 &&
              y / scale >= bounds.top - 2 && y / scale <= bounds.bottom + 2) continue;
          const i = (y * a.width + x) * 4;
          if (Math.max(a.data[i] - b.data[i], a.data[i + 1] - b.data[i + 1],
            a.data[i + 2] - b.data[i + 2]) >= 12) changed += 1;
        }
      }
      return changed / (scale * scale);
    }, { lit, dark, bounds });
    if (changed < 12) throw new Error(`Caustics hidden behind compact crystal: ${changed} visible pixels`);
    console.log(`viz compact caustics: ${changed.toFixed(0)} visible pixels outside crystal`);
  } finally {
    await setReceiver(true);
    await page.evaluate(() => {
      const h = window.__ATOMA_GPU__;
      cancelAnimationFrame(h.causticProbeFrame);
      delete h.causticProbeFrame;
      h.app.start();
    });
  }
}

/** A real pointer must light the retained compact mark in both camera poses. */
export async function assertPointerLitMark(page, measureFrames = null) {
  let frameStats = null;
  const mark = await page.evaluate(() => {
    const handle = window.__ATOMA_GPU__;
    const find = (node, label) => node.label === label ? node :
      (node.children ?? []).map((child) => find(child, label)).find(Boolean);
    const container = find(handle.app.stage, 'atoma-mark');
    if (!container) throw new Error('No retained crystal for pointer probe');
    const beadVisible = handle.markBeadVisible();
    handle.pinMarkElapsedMs(0);
    handle.setMarkBeadVisible(false);
    return { x: container.x + 14, y: container.y + 14, beadVisible };
  });
  const read = () => page.evaluate(() => {
    const handle = window.__ATOMA_GPU__;
    const find = (node, label) => node.label === label ? node :
      (node.children ?? []).map((child) => find(child, label)).find(Boolean);
    const shell = find(handle.app.stage, 'mark-shell-front');
    const field = find(handle.app.stage, 'far-field');
    const cast = window.__ATOMA_MARK_CAUSTIC__;
    const uniforms = field?.shader.resources.farFieldUniforms.uniforms;
    const positions = field?.geometry.getBuffer('aPosition').data;
    const screen = handle.app.screen;
    const coverage = positions ? (positions[2] - positions[0]) * (positions[5] - positions[1]) : 0;
    const point = uniforms ? handle.projectRendererPoint(
      uniforms.uCaustic0[0], uniforms.uCaustic0[1]
    ) : null;
    return {
      lamp: Array.from(shell.shader.resources.markUniforms.uniforms.uLamp),
      cast: cast?.points ?? [],
      energy: Math.max(0, ...(cast?.optics ?? []).map((optics) => optics.intensity)),
      fieldVisible: field?.visible ?? false,
      scenery: uniforms?.uScenery,
      halo: uniforms ? Math.max(...[0, 1, 2, 3].map((i) => uniforms[`uMark${i}`][2])) : 0,
      coverage,
      // The packer may reverse triangle winding, so compare to its three corners.
      projectionError: point && cast ? Math.min(...cast.points.slice(0, 3)
        .map((corner) => Math.hypot(point.x - corner.x, point.y - corner.y))) : null,
      width: screen.width, height: screen.height,
    };
  });
  try {
    for (const dx of [0, 6]) {
      const client = await page.evaluate(({ x, y }) =>
        window.__ATOMA_GPU__.projectRendererPoint(x, y), { x: mark.x + dx, y: mark.y });
      await page.mouse.move(client.x, client.y);
      await page.waitForFunction(() => window.__ATOMA_MARK_CAUSTIC__?.points.length === 12,
        { polling: 'raf', timeout: 10_000 });
      // The bounded CPU trace runs at 30 Hz. Let it consume this pointer revision.
      await page.evaluate(async () => {
        for (let i = 0; i < 8; i += 1) await new Promise(requestAnimationFrame);
      });
      const lit = await read();
      if (lit.lamp[3] < 0.6 || (dx === 0 && Math.hypot(lit.lamp[0], lit.lamp[1]) > 0.02) ||
          (dx > 0 && lit.lamp[0] < 0.1) || lit.energy < 0.001 || !lit.fieldVisible ||
          lit.scenery !== 0 || lit.halo !== 0 || lit.coverage <= 0 || lit.coverage >= 0.5 ||
          lit.projectionError === null || lit.projectionError > 0.1) {
        throw new Error(`Compact crystal lost pointer lighting: ${JSON.stringify(lit)}`);
      }
      if (dx === 6) await assertVisibleCompactCaustics(page);
      if (dx === 0 && measureFrames) frameStats = await measureFrames(page);
    }
    await page.mouse.move(1200, 750);
    await page.waitForFunction(() => !window.__ATOMA_MARK_CAUSTIC__,
      { polling: 'raf', timeout: 10_000 });
    const idle = await read();
    if (idle.fieldVisible || idle.lamp[3] !== 0 || idle.coverage !== 0) {
      throw new Error(`Compact crystal kept idle receiver work: ${JSON.stringify(idle)}`);
    }
    console.log('viz compact crystal: pointer lamp + caustics follow camera; idle receiver detached' +
      (frameStats ? `; lit ${frameStats.meanMs.toFixed(2)}ms mean/${frameStats.p95Ms.toFixed(2)}ms P95` : ''));
  } finally {
    await page.evaluate((beadVisible) => {
      window.__ATOMA_GPU__.pinMarkElapsedMs(null);
      window.__ATOMA_GPU__.setMarkBeadVisible(beadVisible);
    }, mark.beadVisible);
  }
}
