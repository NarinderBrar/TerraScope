/** Browser integration check. Run the web dev server first, then npm run test:splat. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profile = await mkdtemp(join(tmpdir(), 'terrascope-splat-browser-'));
const port = Number(process.env.CDP_PORT ?? 9336);
const base = process.env.SPLAT_TEST_URL ?? 'http://127.0.0.1:5173';
const screenshotDir = process.env.SPLAT_SCREENSHOTS;
const flags = [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-webgpu',
  '--disable-dev-shm-usage', '--no-first-run', '--window-size=1200,900',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
];
// Native Vulkan avoids SwiftShader's multi-device failures when map and splat
// canvases are alive together. Override for other platforms/backends.
flags.push(...(process.env.SPLAT_CHROME_GPU_FLAGS?.split(' ') ?? [
  '--use-angle=vulkan', '--use-vulkan=native', '--enable-features=Vulkan',
]));
const chrome = spawn(process.env.CHROME ?? '/usr/bin/google-chrome', [...flags, 'about:blank'], { stdio: 'ignore' });
let ws;
try {
  let pages;
  for (let i = 0; i < 60; i++) {
    try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; }
    catch { await delay(250); }
  }
  assert.ok(pages, 'Chrome DevTools did not start');
  ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let next = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (request) {
        clearTimeout(request.timer);
        message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
      }
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression, timeout = 30000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evaluate(expression)) return;
      await delay(200);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  const click = async (label) => {
    assert.ok(await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); button?.click(); return !!button; })()`), `Missing button: ${label}`);
    await delay(150);
  };
  const drag = async (shift = false) => {
    const rect = await evaluate(`(() => { const r = document.querySelector('canvas.map').getBoundingClientRect(); return { x:r.x, y:r.y, w:r.width, h:r.height }; })()`);
    const modifiers = shift ? 8 : 0;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + rect.w * 0.3, y: rect.y + rect.h * 0.3, buttons: 0, modifiers });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x + rect.w * 0.3, y: rect.y + rect.h * 0.3, button: 'left', buttons: 1, clickCount: 1, modifiers });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + rect.w * 0.7, y: rect.y + rect.h * 0.7, buttons: 1, modifiers });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + rect.w * 0.7, y: rect.y + rect.h * 0.7, button: 'left', buttons: 0, clickCount: 1, modifiers });
  };
  await send('Runtime.enable');
  await send('Page.enable');
  if (process.env.SPLAT_FORCE_WEBGL === '1') {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator, 'gpu', { value: undefined });" });
  }
  await send('Page.navigate', { url: `${base}/` });
  await waitFor('document.querySelector("canvas.map")?.width > 300');
  for (const [index, city] of ['Jacksonville', 'New York City'].entries()) {
    await click(city);
    await delay(300);
    await waitFor(`document.querySelector('.urban-prompt')?.textContent.includes(${JSON.stringify(city)})`);
    const before = await evaluate('document.querySelector(".hud-row").textContent');
    if (process.env.SPLAT_FORCE_WEBGL !== '1') {
      if (index === 0) await click('Mark Area');
      await evaluate(`(() => { window.__splatPointerEvents = []; for (const type of ['pointerdown','pointermove','pointerup','lostpointercapture']) document.addEventListener(type, e => window.__splatPointerEvents.push({type:e.type, target:e.target.className, primary:e.isPrimary, buttons:e.buttons}), {capture:true}); })()`);
      await drag(index === 1);
      try {
        await waitFor('!!document.querySelector(".aoi-marquee") && !!document.querySelector(".urban-prompt button")');
      } catch (error) {
        console.error(await evaluate('({events:window.__splatPointerEvents, body:document.body.innerText.slice(0,1000)})'));
        const screenshot = await send('Page.captureScreenshot', { format: 'png' });
        await writeFile('/tmp/terrascope-selection-failure.png', Buffer.from(screenshot.data, 'base64'));
        throw error;
      }
    }
    await click('Switch to 3D Urban View');
    await waitFor('!!document.querySelector(".splat-view-direct.active")');
    assert.equal(await evaluate('document.querySelector(".splat-view-direct").dataset.splatEngine'), 'supersplat');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".map-view-2d")).visibility'), 'visible', 'Keep the entering map visible during 3D loading');
    await waitFor('!document.querySelector(".splat-message[role=status]")', 120000);
    assert.equal(await evaluate('document.querySelector(".splat-message[role=alert]")?.textContent ?? null'), null);
    await delay(2000); // Allow compute pipelines to compile and draw several frames.
    assert.equal(await evaluate('document.querySelector(".splat-message[role=alert]")?.textContent ?? null'), null);
    await waitFor('document.querySelector("[data-map-status]")?.dataset.mapStatus === "ready"', 35000);
    await waitFor('document.querySelector(".splat-view-direct").dataset.ready === "true"');
    await waitFor('Number(getComputedStyle(document.querySelector(".splat-canvas")).opacity) === 1');
    assert.equal(await evaluate('document.querySelector(".splat-map-toggle input").checked'), true);
    await evaluate('document.querySelector(".splat-map-toggle input").click()');
    await waitFor('!document.querySelector("[data-map-status]")');
    await evaluate('document.querySelector(".splat-map-toggle input").click()');
    await waitFor('document.querySelector("[data-map-status]")?.dataset.mapStatus === "ready"');
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
    await waitFor('(() => { const c = document.querySelector(".splat-canvas"); return c.clientWidth > 0 && Math.abs(c.width - c.clientWidth) <= 1 && Math.abs(c.height - c.clientHeight) <= 1; })()');
    await send('Emulation.clearDeviceMetricsOverride');
    await delay(200);
    await click('Reset view');
    assert.ok(await evaluate('(() => { const c = document.querySelector(".splat-canvas"); return c.width >= c.clientWidth && c.height >= c.clientHeight; })()'), 'Splat canvas must render at the displayed resolution');
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(screenshotDir, `${index === 0 ? 'JAX_068' : 'NYC_004'}.png`), Buffer.from(screenshot.data, 'base64'));
      const rect = await evaluate(`(() => { const r = document.querySelector('.splat-canvas').getBoundingClientRect(); return {x:r.x+r.width*.5,y:r.y+r.height*.65}; })()`);
      await send('Input.dispatchMouseEvent', {type:'mouseMoved', x:rect.x, y:rect.y, buttons:0});
      await send('Input.dispatchMouseEvent', {type:'mousePressed', x:rect.x, y:rect.y, button:'left', buttons:1, clickCount:1});
      await send('Input.dispatchMouseEvent', {type:'mouseMoved', x:rect.x+50, y:rect.y-180, buttons:1});
      await send('Input.dispatchMouseEvent', {type:'mouseReleased', x:rect.x+50, y:rect.y-180, button:'left', buttons:0, clickCount:1});
      await delay(400);
      const orbit = await send('Page.captureScreenshot', {format:'png'});
      assert.notEqual(orbit.data, screenshot.data, 'Orbit must change the camera view');
      await writeFile(join(screenshotDir, `${index === 0 ? 'JAX_068' : 'NYC_004'}-orbit.png`), Buffer.from(orbit.data, 'base64'));
      await click('Reset view');
    }
    await click('← Back to Map');
    await waitFor('!document.querySelector(".splat-view-direct")');
    assert.equal(await evaluate('document.querySelector(".hud-row").textContent'), before, 'Map camera changed on return');
    // Close during load, then reopen on the next iteration.
    await click('Switch to 3D Urban View');
    await click('← Back to Map');
    console.log(`${city}: splat + ground map, map toggle, reset, return and cancellation passed`);
  }
  assert.deepEqual(errors, [], 'Browser runtime errors');
} finally {
  ws?.close();
  chrome.kill();
  await delay(500);
  await rm(profile, { recursive: true, force: true });
}
