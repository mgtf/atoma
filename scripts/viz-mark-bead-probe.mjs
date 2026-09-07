/* global window, requestAnimationFrame, OffscreenCanvas */

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
