/* global document, getComputedStyle */

/** Exercise Chrome's touch/pointer arbitration on the actual Pixi controls. */
export async function assertMobileProjects(page, projectId) {
  let targetId = `project.select.${projectId}`;
  // Two run rows already overflow this height; no large fixture is needed.
  await page.setViewport({ width: 390, height: 600, deviceScaleFactor: 2 });
  await page.waitForFunction(() => globalThis.__ATOMA_GPU__?.app.screen.width === 390);
  const settled = () => page.waitForFunction(() =>
    document.querySelector('.gpu-scene-camera')?.getAttribute('data-scene-camera-motion') === 'settled');
  await page.waitForFunction((id) => document.querySelector('.gpu-project-form--run') ||
    globalThis.__ATOMA_GPU__?.hitTargets().some(t => t.id === id), {}, targetId);
  await settled();
  const spot = () => page.evaluate((id) => {
    const handle = globalThis.__ATOMA_GPU__;
    const row = handle.hitTargets().find(t => t.id === id);
    if (!row) throw new Error(`Missing mobile target: ${id}`);
    return handle.projectRendererPoint(row.x + row.width / 2, row.y + row.height / 2);
  }, targetId);
  // Select through the canvas if the caller has not already opened a project.
  if (!(await page.$('.gpu-project-form--run'))) {
    const point = await spot();
    await page.mouse.click(point.x, point.y);
    await page.waitForSelector('.gpu-project-form--run');
  }
  await settled();
  await page.waitForFunction(() => globalThis.__ATOMA_GPU__?.hitTargets().some(t => t.id.startsWith('project.run.')));
  targetId = await page.evaluate(() => globalThis.__ATOMA_GPU__.hitTargets().find(t => t.id.startsWith('project.run.')).id);
  const rail = await page.evaluate(() => {
    const handle = globalThis.__ATOMA_GPU__;
    return {
      width: getComputedStyle(document.documentElement).getPropertyValue('--gpu-sidebar').trim(),
      targets: handle.hitTargets().filter(t => t.id.startsWith('nav.')),
    };
  });
  if (!rail.width.includes('56px') || rail.targets.length < 3 ||
      rail.targets.some(t => t.width > 44 || t.x < 0 || t.x + t.width > 56)) {
    throw new Error(`Mobile rail escaped its compact column: ${JSON.stringify(rail)}`);
  }
  const before = await spot();
  const canvasAtStart = await page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.classList.contains('gpu-ui-canvas'), before);
  if (!canvasAtStart || before.y < 140 || before.y > 580) {
    throw new Error(`Mobile swipe must start on a visible project control: ${JSON.stringify(before)}`);
  }
  const cdp = await page.createCDPSession();
  try {
    // Enable native touch delivery without reloading the authenticated fixture.
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x: before.x, y: before.y, id: 1 }],
    });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x: before.x, y: before.y - step * 10, id: 1 }],
      });
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(({ id, y }) => {
      const handle = globalThis.__ATOMA_GPU__;
      const row = handle.hitTargets().find(t => t.id === id);
      return row && handle.projectRendererPoint(row.x + row.width / 2, row.y + row.height / 2).y < y - 20;
    }, {}, { id: targetId, y: before.y });
    if (!(await page.$('.gpu-project-form--run'))) {
      throw new Error('Mobile drag activated a run row and left the project form');
    }
    console.log('Mobile projects ok: compact rail, native touch scroll, no accidental row activation');
  } finally {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await cdp.detach();
  }
}
