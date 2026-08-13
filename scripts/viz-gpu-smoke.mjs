/* global document, HTMLButtonElement */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import puppeteer from 'puppeteer';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const port = await freePort();
const server = spawn(
  process.execPath,
  ['dist/viz/server.js', '--host', '127.0.0.1', '--port', String(port)],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);

try {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs`);
      if (response.ok) break;
    } catch {
      // Compiled server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const diagnostics = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warn') {
        diagnostics.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => {
      diagnostics.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        diagnostics.push(`http ${response.status()}: ${response.url()}`);
      }
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.gpu-ui-host[data-gpu-backend]');

    const views = ['Registry', 'Skills', 'Burn-in', 'Launch', 'Runs'];
    for (const label of views) {
      await page.evaluate((name) => {
        const tabs = [...document.querySelectorAll('[role="tab"]')];
        const tab = tabs.find((candidate) => candidate.textContent === name);
        if (!(tab instanceof HTMLButtonElement)) throw new Error(`missing tab ${name}`);
        tab.click();
      }, label);
      await page.waitForFunction(
        (expected) => document.querySelector('[data-viz-live]')?.textContent?.includes(expected),
        {},
        label
      );
    }

    const result = await page.evaluate(() => ({
      canvases: document.querySelectorAll('canvas').length,
      backend: document.querySelector('.gpu-ui-host')?.getAttribute('data-gpu-backend'),
      objects: Number(document.querySelector('.gpu-ui-host')?.getAttribute('data-gpu-objects')),
      hasLaunchTextarea: !!document.querySelector('.gpu-launch-input'),
    }));
    if (
      result.canvases < 2 ||
      !['webgpu', 'webgl'].includes(result.backend ?? '') ||
      result.objects < 20 ||
      diagnostics.length > 0
    ) {
      throw new Error(`GPU smoke failed: ${JSON.stringify({ ...result, diagnostics })}`);
    }
    console.log(
      `viz GPU smoke ok: ${result.canvases} canvases, ${result.backend}, ${result.objects} objects, five views`
    );
  } finally {
    await browser.close();
  }

  const fallbackBrowser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await fallbackBrowser.newPage();
    const diagnostics = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warn') {
        diagnostics.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => {
      diagnostics.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        diagnostics.push(`http ${response.status()}: ${response.url()}`);
      }
    });
    await page.goto(`http://127.0.0.1:${port}/?renderer=webgl`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.gpu-ui-host[data-gpu-backend="webgl"]');
    if (diagnostics.length > 0) {
      throw new Error(`GPU fallback diagnostics: ${JSON.stringify(diagnostics)}`);
    }
    console.log('viz GPU fallback ok: WebGL');
  } finally {
    await fallbackBrowser.close();
  }
} finally {
  server.kill('SIGTERM');
}
