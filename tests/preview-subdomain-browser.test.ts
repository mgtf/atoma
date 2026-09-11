import { it, expect } from 'vitest';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { previewResponseHeaders } from '../src/preview/gateway.js';
import { PREVIEW_BROWSER_SANDBOX } from '../src/contracts/preview.js';
import { serializeCookie } from '../src/auth/sessions.js';

it('isolates a same-site preview in a real HTTPS browser while preserving local storage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atoma-preview-tls-'));
  const key = join(root, 'key.pem');
  const cert = join(root, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=atoma.test'], { stdio: 'ignore' });
  let origin = '';
  let appRequests = 0;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    if (req.headers.host?.startsWith('atoma.test:')) {
      appRequests++;
      if (req.url === '/') res.setHeader('set-cookie', serializeCookie('atoma_session', 'trusted', { secure: true }));
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html');
        res.end(`<iframe sandbox="${PREVIEW_BROWSER_SANDBOX}" src="https://g1.previews.atoma.test:${req.headers.host.split(':')[1]}"></iframe>`);
      } else res.end(req.headers.cookie ?? '');
      return;
    }
    res.writeHead(200, { ...previewResponseHeaders({ visualizerOrigin: origin, allowedHosts: [] }),
      'content-type': 'text/html' });
    res.end(`<!doctype html><title>Preview</title><button id="export">Export JSON</button>
      <script>document.querySelector('#export').onclick = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify({checks: [200]})], {type: 'application/json'}));
        a.download = 'checks.json'; a.click();
      };</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  origin = `https://atoma.test:${address.port}`;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--no-proxy-server',
    '--ignore-certificate-errors', '--host-resolver-rules=MAP atoma.test 127.0.0.1, MAP g1.previews.atoma.test 127.0.0.1'] });
  try {
    const page = await browser.newPage();
    const session = await page.createCDPSession();
    await session.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: root });
    await page.goto(origin);
    const frameElement = await page.waitForSelector('iframe');
    const frame = await frameElement!.contentFrame();
    await frame.waitForSelector('#export');
    await frame.click('#export');
    await expect.poll(() => existsSync(join(root, 'checks.json')), { timeout: 5000 }).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'checks.json'), 'utf8'))).toEqual({ checks: [200] });
    await page.goto(`https://g1.previews.atoma.test:${address.port}`);
    const before = appRequests;
    const result = await page.evaluate(async (appOrigin) => {
      const visible = document.cookie;
      document.cookie = '__Host-atoma_session=forged; Domain=atoma.test; Path=/; Secure';
      let domainBlocked = false;
      try { document.domain = 'atoma.test'; } catch { domainBlocked = true; }
      localStorage.setItem('preview', 'works');
      let requestBlocked = false;
      try { await fetch(appOrigin + '/mutation', { method: 'POST', credentials: 'include' }); }
      catch { requestBlocked = true; }
      return { visible, domainBlocked, requestBlocked, stored: localStorage.getItem('preview') };
    }, origin);
    expect(result).toEqual({ visible: '', domainBlocked: true, requestBlocked: true, stored: 'works' });
    expect(appRequests).toBe(before);
    await page.goto(origin + '/cookies');
    expect(await page.evaluate(() => document.body.textContent)).toBe('__Host-atoma_session=trusted');
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
