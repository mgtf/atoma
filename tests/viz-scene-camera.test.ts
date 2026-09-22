import { describe, expect, it } from 'vitest';
import {
  SCENE_CAMERA,
  buildSceneCameraFrame,
  clientToRendererPoint,
  interpolateSceneCamera,
  pinSceneCameraTopRight,
  projectScenePoint,
  rendererToClientPoint,
  sceneCameraCssTransform,
  sceneCameraEase,
  sceneCameraForMode,
  sceneCameraRenderTransform,
  unprojectScenePoint,
  visibleSceneLayoutHeight,
  type SceneCamera,
} from '../src/viz/client-gl/scene-camera.js';
import { GPU_LAYOUT, sidebarWidthForViewport } from '../src/viz/client-gl/theme.js';
import {
  FOCUS_SIDEBAR_BUTTON_WIDTH,
  focusRailChromeLayout,
  sidebarLayout,
} from '../src/viz/client-gl/renderer/views/sidebar.js';
import { ADMIN_VIEWS, type ViewName } from '../src/viz/client-gl/store.js';
import { viewFrame } from '../src/viz/client-gl/renderer/view-frame.js';

function matrix3dValues(transform: string): number[] {
  const match = /^matrix3d\((.*)\)$/.exec(transform);
  if (!match) throw new Error(`not a matrix3d: ${transform}`);
  return match[1]!.split(',').map((part) => Number(part.trim()));
}

describe('the global scene camera', () => {
  it('rasterises the same affine projection used by DOM and clicks at every zoom step', () => {
    for (const [width, height] of [[432, 720], [1280, 800], [2560, 1440]] as const) {
      const from = sceneCameraForMode('overview', width, height);
      const to = sceneCameraForMode('focus', width, height);
      for (const progress of [0, 0.17, 0.5, 0.91, 1]) {
        const camera = pinSceneCameraTopRight(
          interpolateSceneCamera(from, to, progress), width, height
        );
        const frame = buildSceneCameraFrame(camera, width, height);
        // Include unequal renderer/DOM sizes, not only the usual 1:1 case.
        const rendererWidth = width * 1.5;
        const rendererHeight = height * 2;
        const m = sceneCameraRenderTransform(frame, rendererWidth, rendererHeight);
        expect(frame.forward[6]).toBe(0);
        expect(frame.forward[7]).toBe(0);
        for (const point of [
          { x: 0, y: 0 },
          { x: rendererWidth / 2, y: rendererHeight / 2 },
          { x: rendererWidth, y: rendererHeight },
        ]) {
          const client = rendererToClientPoint(point, rendererWidth, rendererHeight, frame);
          expect((m.a * point.x + m.c * point.y + m.tx) * width / rendererWidth)
            .toBeCloseTo(client.x, 9);
          expect((m.b * point.x + m.d * point.y + m.ty) * height / rendererHeight)
            .toBeCloseTo(client.y, 9);
          const hit = clientToRendererPoint(client, rendererWidth, rendererHeight, frame);
          expect(hit.x).toBeCloseTo(point.x, 9);
          expect(hit.y).toBeCloseTo(point.y, 9);
        }
      }
    }
  });

  it('publishes the exact homography as one CSS matrix3d', () => {
    const width = 1_280;
    const height = 720;
    const camera = sceneCameraForMode('focus', width, height);
    const frame = buildSceneCameraFrame(camera, width, height);
    const values = matrix3dValues(sceneCameraCssTransform(camera, width, height));
    expect(values).toHaveLength(16);
    expect(values[0]).toBeCloseTo(frame.forward[0], 11);
    expect(values[1]).toBeCloseTo(frame.forward[3], 11);
    expect(values[3]).toBeCloseTo(frame.forward[6], 11);
    expect(values[4]).toBeCloseTo(frame.forward[1], 11);
    expect(values[5]).toBeCloseTo(frame.forward[4], 11);
    expect(values[7]).toBeCloseTo(frame.forward[7], 11);
    expect(values[12]).toBeCloseTo(frame.forward[2], 9);
    expect(values[13]).toBeCloseTo(frame.forward[5], 9);
    expect(values[15]).toBeCloseTo(frame.forward[8], 11);
  });

  it('keeps the complete overview on the exact authored plane', () => {
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;
    for (const { width, height } of [
      { width: 1_280, height: 720 },
      { width: 528, height: 800 },
      { width: 432, height: 800 },
    ]) {
      const camera = sceneCameraForMode('overview', width, height);
      const frame = buildSceneCameraFrame(camera, width, height);
      expect(camera).toMatchObject({ pitchDegrees: 0, yawDegrees: 0, sceneScale: 1 });
      expect(frame.forward).toEqual(identity);
      expect(frame.inverse).toEqual(identity);
      for (const point of [
        { x: 0, y: 0 },
        { x: width, y: 0 },
        { x: width, y: height },
        { x: 0, y: height },
        { x: width * 0.31725, y: height * 0.64275 },
      ]) {
        expect(projectScenePoint(point, width, height, camera)).toEqual(point);
        expect(unprojectScenePoint(point, width, height, camera)).toEqual(point);
      }
      expect(matrix3dValues(sceneCameraCssTransform(camera, width, height))).toEqual([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ]);
    }
  });

  it('moves the optical target from the whole scene to the content column', () => {
    const width = 1_280;
    const height = 720;
    const overview = sceneCameraForMode('overview', width, height);
    const focus = sceneCameraForMode('focus', width, height);
    const contentLeft = sidebarWidthForViewport(width);
    const contentCentre = { x: contentLeft + (width - contentLeft) / 2, y: height / 2 };
    const focusedCentre = projectScenePoint(contentCentre, width, height, focus);
    expect(focusedCentre.x).toBeCloseTo(focus.anchorXRatio * width, 10);
    expect(focusedCentre.y).toBeCloseTo(focus.anchorYRatio * height, 10);

    const overviewContentWidth = projectScenePoint(
      { x: width, y: height / 2 }, width, height, overview
    ).x - projectScenePoint(
      { x: contentLeft, y: height / 2 }, width, height, overview
    ).x;
    const focusContentWidth = projectScenePoint(
      { x: width, y: height / 2 }, width, height, focus
    ).x - projectScenePoint(
      { x: contentLeft, y: height / 2 }, width, height, focus
    ).x;
    expect(focusContentWidth).toBeGreaterThan(overviewContentWidth * 1.015);
    expect(focus.sceneScale).toBeGreaterThan(1);
    expect(focus.pitchDegrees).toBe(0);
    expect(focus.yawDegrees).toBe(0);
  });

  it('covers the top and right viewport edges throughout focus', () => {
    for (const { width, height } of [
      { width: 432, height: 720 },
      { width: 528, height: 800 },
      { width: 1_280, height: 720 },
      { width: 1_728, height: 991 },
      { width: 2_560, height: 1_440 },
      { width: 3_840, height: 2_160 },
    ]) {
      const camera = sceneCameraForMode('focus', width, height);
      const sourceTop = camera.sourceTopRatio * height;
      expect(sourceTop).toBeCloseTo(GPU_LAYOUT.focusTopInset, 10);
      for (const x of [0, width / 2, width]) {
        const top = projectScenePoint({ x, y: sourceTop }, width, height, camera);
        expect(top.y, `${width}x${height} top at x=${x}`).toBeCloseTo(0, 8);
      }

      const croppedHeader = projectScenePoint({ x: width / 2, y: 0 }, width, height, camera);
      expect(croppedHeader.y, `${width}x${height} cropped header`).toBeLessThanOrEqual(0);
      const topRight = projectScenePoint({ x: width, y: sourceTop }, width, height, camera);
      expect(topRight.x, `${width}x${height} top right`).toBeCloseTo(width, 8);
      for (const y of [height / 2, height]) {
        const right = projectScenePoint({ x: width, y }, width, height, camera);
        expect(right.x, `${width}x${height} right at y=${y}`).toBeCloseTo(width, 9);
      }
    }
  });

  it('crops the labelled rail lead so compact icons sit on the guard', () => {
    for (const { width, height } of [
      { width: 528, height: 800 },
      { width: 900, height: 600 },
      { width: 1_024, height: 768 },
      { width: 1_280, height: 720 },
      { width: 1_512, height: 982 },
    ]) {
      const camera = sceneCameraForMode('focus', width, height);
      const rail = sidebarWidthForViewport(width);
      const buttonLeft = Math.max(0, rail - GPU_LAYOUT.sidebarFocusButtonWidth);
      const guard = Math.min(8, buttonLeft);
      const sourceTop = camera.sourceTopRatio * height;
      const projected = projectScenePoint(
        { x: buttonLeft, y: sourceTop },
        width,
        height,
        camera
      );
      expect(projected.x, `${width}x${height}`).toBeCloseTo(guard, 0);
    }
  });

  it('keeps every compact rail button visibly inside focused viewports', () => {
    const allViews: readonly ViewName[] = [
      'projects', 'runs', 'docs', 'registry', 'skills', 'burnin', ...ADMIN_VIEWS,
    ];
    for (const { width, height } of [
      { width: 1_280, height: 720 },
      { width: 528, height: 800 },
      { width: 432, height: 720 },
      { width: 1_920, height: 1_080 },
      { width: 2_560, height: 1_440 },
      { width: 3_840, height: 2_160 },
    ]) {
      const rail = sidebarWidthForViewport(width);
      const camera = sceneCameraForMode('focus', width, height);
      const layoutHeight = unprojectScenePoint(
        { x: 0, y: height }, width, height, camera
      ).y;
      const chrome = focusRailChromeLayout(rail, layoutHeight, true);
      const rows = sidebarLayout(
        allViews,
        chrome.navigationBottom,
        chrome.navigationTop,
        true
      )
        .filter((row) => row.kind !== 'group');
      expect(rows.at(-1)!.y + rows.at(-1)!.height).toBeLessThan(chrome.profile!.y);
      for (const row of rows) {
        for (const point of [
          { x: rail - FOCUS_SIDEBAR_BUTTON_WIDTH, y: row.y },
          { x: rail, y: row.y },
          { x: rail, y: row.y + row.height },
          { x: rail - FOCUS_SIDEBAR_BUTTON_WIDTH, y: row.y + row.height },
        ]) {
          const projected = projectScenePoint(point, width, height, camera);
          expect(projected.x, `${width}x${height} x for ${row.kind}`).toBeGreaterThanOrEqual(0);
          expect(projected.x, `${width}x${height} x for ${row.kind}`).toBeLessThanOrEqual(width);
          expect(projected.y, `${width}x${height} y for ${row.kind}`).toBeGreaterThanOrEqual(0);
          expect(projected.y, `${width}x${height} y for ${row.kind}`).toBeLessThanOrEqual(height);
        }
      }
      for (const [name, rect] of [
        ['crystal', chrome.crystal],
        ['profile', chrome.profile!],
        ['locale', chrome.locale],
        ['fps', chrome.fps],
      ] as const) {
        for (const point of [
          { x: rect.x, y: rect.y },
          { x: rect.x + rect.width, y: rect.y },
          { x: rect.x + rect.width, y: rect.y + rect.height },
          { x: rect.x, y: rect.y + rect.height },
        ]) {
          const projected = projectScenePoint(point, width, height, camera);
          expect(projected.x, `${width}x${height} x for ${name}`).toBeGreaterThanOrEqual(0);
          expect(projected.x, `${width}x${height} x for ${name}`).toBeLessThanOrEqual(width);
          expect(projected.y, `${width}x${height} y for ${name}`).toBeGreaterThanOrEqual(0);
          expect(projected.y, `${width}x${height} y for ${name}`).toBeLessThanOrEqual(height);
        }
      }
    }
  });

  it('resizes the complete content frame continuously throughout camera travel', () => {
    for (const { width, height } of [
      { width: 432, height: 720 },
      { width: 528, height: 800 },
      { width: 1_280, height: 720 },
      { width: 1_728, height: 991 },
      { width: 1_920, height: 1_080 },
      { width: 2_560, height: 1_440 },
      { width: 3_840, height: 2_160 },
    ]) {
      const sidebarWidth = sidebarWidthForViewport(width);
      const overview = sceneCameraForMode('overview', width, height);
      const focus = sceneCameraForMode('focus', width, height);
      const samples = Array.from({ length: 241 }, (_, index) => index / 240);
      const travel = (from: SceneCamera, to: SceneCamera) => samples.map((progress) => {
        const camera = pinSceneCameraTopRight(
          interpolateSceneCamera(from, to, sceneCameraEase(progress)),
          width,
          height
        );
        const layoutHeight = visibleSceneLayoutHeight(
          buildSceneCameraFrame(camera, width, height)
        );
        const frame = viewFrame(width - sidebarWidth, layoutHeight);
        for (const [name, point] of [
          ['left', { x: sidebarWidth + frame.x, y: frame.bottom }],
          ['right', { x: sidebarWidth + frame.x + frame.width, y: frame.bottom }],
        ] as const) {
          const client = projectScenePoint(point, width, height, camera);
          expect(client.x, `${width}x${height} ${name} x at ${progress}`).toBeGreaterThanOrEqual(0.5);
          expect(client.x, `${width}x${height} ${name} x at ${progress}`).toBeLessThanOrEqual(width - 0.5);
          expect(client.y, `${width}x${height} ${name} bottom at ${progress}`).toBeGreaterThanOrEqual(height - 16);
          expect(client.y, `${width}x${height} ${name} bottom at ${progress}`).toBeLessThanOrEqual(height - 8);
        }
        return layoutHeight;
      });
      const zoom = travel(overview, focus);
      const dezoom = travel(focus, overview);
      expect(zoom[0], `${width}x${height} overview height`).toBeCloseTo(height, 8);
      expect(zoom.at(-1), `${width}x${height} focus height`).toBeCloseTo(
        visibleSceneLayoutHeight(buildSceneCameraFrame(focus, width, height)),
        8
      );
      const amplitude = Math.abs(zoom[0]! - zoom.at(-1)!);
      let maximumStep = 0;
      for (let index = 1; index < zoom.length; index += 1) {
        expect(zoom[index]!, `${width}x${height} zoom ${index}`).toBeLessThanOrEqual(
          zoom[index - 1]! + 1e-8
        );
        expect(dezoom[index]!, `${width}x${height} dezoom ${index}`).toBeGreaterThanOrEqual(
          dezoom[index - 1]! - 1e-8
        );
        expect(dezoom[index]!, `${width}x${height} reverse ${index}`).toBeCloseTo(
          zoom[zoom.length - 1 - index]!,
          8
        );
        maximumStep = Math.max(maximumStep, Math.abs(zoom[index]! - zoom[index - 1]!));
      }
      expect(maximumStep, `${width}x${height} largest height step`).toBeLessThanOrEqual(
        amplitude * 0.01 + 1e-6
      );
    }
  });

  it('round-trips pointer rays throughout the travelling shot', () => {
    const width = 1_440;
    const height = 900;
    const overview = sceneCameraForMode('overview', width, height);
    const focus = sceneCameraForMode('focus', width, height);
    for (const progress of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const camera = pinSceneCameraTopRight(
        interpolateSceneCamera(overview, focus, sceneCameraEase(progress)),
        width,
        height
      );
      const sourceTop = camera.sourceTopRatio * height;
      const top = projectScenePoint({ x: width / 2, y: sourceTop }, width, height, camera);
      const topRight = projectScenePoint({ x: width, y: sourceTop }, width, height, camera);
      expect(top.y, `top at t=${progress}`).toBeCloseTo(0, 8);
      expect(topRight.x, `right at t=${progress}`).toBeCloseTo(width, 8);
      for (const point of [
        { x: 0, y: 0 },
        { x: width, y: height },
        { x: 317.25, y: 642.75 },
        { x: width / 2, y: height / 2 },
      ]) {
        const client = projectScenePoint(point, width, height, camera);
        const scene = unprojectScenePoint(client, width, height, camera);
        expect(scene.x, `x at t=${progress}`).toBeCloseTo(point.x, 8);
        expect(scene.y, `y at t=${progress}`).toBeCloseTo(point.y, 8);
      }
    }
    expect(interpolateSceneCamera(overview, focus, 0)).toEqual(overview);
    expect(interpolateSceneCamera(overview, focus, 1)).toEqual(focus);
  });

  it('keeps a portrait overview inside the camera frame after resize', () => {
    const width = 528;
    const height = 800;
    const camera = sceneCameraForMode('overview', width, height);
    for (const point of [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
      { x: 320, y: 180 },
    ]) {
      const client = projectScenePoint(point, width, height, camera);
      expect(client).toEqual(point);
      const scene = unprojectScenePoint(client, width, height, camera);
      expect(scene.x).toBeCloseTo(point.x, 8);
      expect(scene.y).toBeCloseTo(point.y, 8);
    }
  });

  it('keeps renderer resolution separate from the CSS camera plane', () => {
    const renderer = { x: 640, y: 360 };
    const frame = buildSceneCameraFrame(sceneCameraForMode('focus', 640, 360), 640, 360);
    const client = rendererToClientPoint(renderer, 1_280, 720, frame);
    const recovered = clientToRendererPoint(client, 1_280, 720, frame);
    expect(recovered.x).toBeCloseTo(renderer.x, 8);
    expect(recovered.y).toBeCloseTo(renderer.y, 8);
  });

  it('can reduce an arbitrary pose exactly to the neutral plane', () => {
    const flat: SceneCamera = {
      ...SCENE_CAMERA,
      perspectivePx: 1_600,
      pitchDegrees: 0,
      yawDegrees: 0,
      sceneScale: 1,
      targetXRatio: 0.5,
      targetYRatio: 0.5,
      sourceTopRatio: 0,
      anchorXRatio: 0.5,
      anchorYRatio: 0.5,
    };
    const point = { x: 173, y: 421 };
    expect(projectScenePoint(point, 800, 600, flat)).toEqual(point);
    expect(unprojectScenePoint(point, 800, 600, flat)).toEqual(point);
  });
});
