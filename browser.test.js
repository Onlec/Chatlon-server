const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  createBrowserService,
  BROWSER_HOME_URL,
  MAX_VIEWPORT_AREA,
  normalizeViewportSize
} = require('./browserService');
const { createApp } = require('./app');

function openSseStream(url) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      headers: {
        Accept: 'text/event-stream'
      }
    });

    request.on('response', (response) => {
      response.setEncoding('utf8');

      let buffer = '';
      const waiters = [];

      const flushWaiters = () => {
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          const waiter = waiters[index];
          const matched = typeof waiter.pattern === 'string'
            ? buffer.includes(waiter.pattern)
            : waiter.pattern.test(buffer);

          if (matched) {
            waiters.splice(index, 1);
            waiter.resolve(buffer);
          }
        }
      };

      response.on('data', (chunk) => {
        buffer += chunk;
        flushWaiters();
      });

      response.on('error', reject);

      resolve({
        response,
        waitFor(pattern) {
          const matched = typeof pattern === 'string'
            ? buffer.includes(pattern)
            : pattern.test(buffer);

          if (matched) {
            return Promise.resolve(buffer);
          }

          return new Promise((waitResolve) => {
            waiters.push({
              pattern,
              resolve: waitResolve
            });
          });
        },
        close() {
          response.destroy();
          request.destroy();
        }
      });
    });

    request.on('error', reject);
    request.end();
  });
}

function createFakeFrame(label) {
  return {
    buffer: Buffer.from(`frame:${label}`),
    mimeType: 'image/jpeg'
  };
}

function createFakeEngine() {
  const remotes = [];

  return {
    remotes,
    disposed: false,
    async createSession({
      viewportWidth,
      viewportHeight,
      onNavigation,
      onLoadingChange,
      onError,
      onFrame
    }) {
      const history = [];
      let historyIndex = -1;
      let frameCounter = 0;
      let currentFrame = null;

      const emitCurrent = async () => {
        const entry = history[historyIndex];
        if (!entry) return;
        onNavigation?.({ ...entry });
        onLoadingChange?.(false);
      };

      const emitFrame = async (label = 'default') => {
        currentFrame = createFakeFrame(`${label}-${++frameCounter}`);
        onFrame?.(currentFrame);
        return currentFrame;
      };

      const pushEntry = (entry) => {
        history.splice(historyIndex + 1);
        history.push(entry);
        historyIndex = history.length - 1;
      };

      const remote = {
        calls: [],
        inputs: [],
        viewportWidth,
        viewportHeight,
        disposed: false,
        async navigateHome() {
          this.calls.push({ type: 'home' });
          onLoadingChange?.(true);
          pushEntry({
            mode: 'home',
            url: BROWSER_HOME_URL,
            title: 'Yoctol Startpagina'
          });
          await emitCurrent();
          await emitFrame('home');
        },
        async navigate(url) {
          this.calls.push({ type: 'navigate', url });
          onLoadingChange?.(true);
          pushEntry({
            mode: 'page',
            url,
            title: `Title ${url}`
          });
          await emitCurrent();
          await emitFrame('navigate');
        },
        async goBack() {
          this.calls.push({ type: 'back' });
          onLoadingChange?.(true);
          if (historyIndex > 0) {
            historyIndex -= 1;
          }
          await emitCurrent();
          await emitFrame('back');
        },
        async goForward() {
          this.calls.push({ type: 'forward' });
          onLoadingChange?.(true);
          if (historyIndex < history.length - 1) {
            historyIndex += 1;
          }
          await emitCurrent();
          await emitFrame('forward');
        },
        async reload() {
          this.calls.push({ type: 'reload' });
          onLoadingChange?.(true);
          await emitCurrent();
          await emitFrame('reload');
        },
        async stop() {
          this.calls.push({ type: 'stop' });
          onLoadingChange?.(false);
        },
        async handleInput(payload) {
          this.inputs.push(payload);
          if (payload.type === 'resize') {
            this.viewportWidth = payload.viewportWidth;
            this.viewportHeight = payload.viewportHeight;
            await emitFrame('resize');
            return;
          }
          if (payload.type === 'click' || payload.type === 'dblclick' || payload.type === 'wheel' || payload.type === 'keydown' || payload.type === 'type') {
            await emitFrame(payload.type);
          }
        },
        async ensureFrame() {
          if (!currentFrame) {
            await emitFrame('ensure');
          }
          return currentFrame;
        },
        async getFrame() {
          return currentFrame;
        },
        async dispose() {
          this.disposed = true;
        },
        async emitExternalNavigation(url) {
          onLoadingChange?.(true);
          pushEntry({
            mode: 'page',
            url,
            title: `External ${url}`
          });
          await emitCurrent();
          await emitFrame('external');
        },
        emitError(message) {
          onError?.(message);
        }
      };

      remotes.push(remote);
      return remote;
    },
    async dispose() {
      this.disposed = true;
    }
  };
}

test('normalizeViewportSize caps area while preserving orientation', () => {
  const viewport = normalizeViewportSize(1920, 1080);
  assert.ok((viewport.width * viewport.height) <= MAX_VIEWPORT_AREA);
  assert.equal(viewport.width > viewport.height, true);
});

test('browser service reuses sessions per user and isolates users from each other', async () => {
  const engine = createFakeEngine();
  const service = createBrowserService({ engine, autoCleanup: false });

  const aliceOne = await service.ensureSession({
    userKey: 'alice',
    sessionScope: 'browser',
    viewportWidth: 900,
    viewportHeight: 600
  });
  const aliceTwo = await service.ensureSession({
    userKey: 'alice',
    sessionScope: 'browser',
    viewportWidth: 1200,
    viewportHeight: 900
  });
  const bob = await service.ensureSession({
    userKey: 'bob',
    sessionScope: 'browser',
    viewportWidth: 700,
    viewportHeight: 500
  });

  assert.equal(aliceOne.sessionId, aliceTwo.sessionId);
  assert.notEqual(aliceOne.sessionId, bob.sessionId);
  assert.ok((aliceTwo.viewportWidth * aliceTwo.viewportHeight) <= MAX_VIEWPORT_AREA);
  assert.deepEqual(engine.remotes[0].inputs[0], {
    type: 'resize',
    viewportWidth: aliceTwo.viewportWidth,
    viewportHeight: aliceTwo.viewportHeight
  });

  await service.dispose();
});

test('browser service tracks navigation history and cached frame metadata', async () => {
  const engine = createFakeEngine();
  const service = createBrowserService({ engine, autoCleanup: false });

  const session = await service.ensureSession({
    userKey: 'alice',
    sessionScope: 'browser'
  });

  assert.equal(session.frameVersion, 1);
  assert.equal(session.frameMimeType, 'image/jpeg');
  assert.equal(session.hasFreshFrame, true);

  let state = await service.navigate(session.sessionId, 'https://example.com/');
  assert.equal(state.url, 'https://example.com/');
  assert.equal(state.canGoBack, true);
  assert.equal(state.frameVersion, 2);
  assert.equal(state.hasFreshFrame, true);

  state = await service.goHome(session.sessionId);
  assert.equal(state.url, BROWSER_HOME_URL);
  assert.equal(state.frameVersion, 3);

  state = await service.goBack(session.sessionId);
  assert.equal(state.url, 'https://example.com/');
  assert.equal(state.canGoForward, true);
  assert.equal(state.frameVersion, 4);

  state = await service.goForward(session.sessionId);
  assert.equal(state.url, BROWSER_HOME_URL);
  assert.equal(state.frameVersion, 5);

  state = await service.reload(session.sessionId);
  assert.equal(state.url, BROWSER_HOME_URL);
  assert.equal(state.frameVersion, 6);

  await engine.remotes[0].emitExternalNavigation('https://wikipedia.org/');
  state = await service.getState(session.sessionId);
  assert.equal(state.url, 'https://wikipedia.org/');
  assert.equal(state.title, 'External https://wikipedia.org/');
  assert.equal(state.frameVersion, 7);

  await service.dispose();
});

test('focus and move do not stale the frame, while dirty inputs refresh it', async () => {
  const engine = createFakeEngine();
  const service = createBrowserService({ engine, autoCleanup: false });

  const session = await service.ensureSession({
    userKey: 'alice',
    sessionScope: 'browser'
  });

  let state = await service.handleInput(session.sessionId, { type: 'focus' });
  assert.equal(state.frameVersion, 1);
  assert.equal(state.hasFreshFrame, true);

  state = await service.handleInput(session.sessionId, { type: 'move', x: 12, y: 24 });
  assert.equal(state.frameVersion, 1);
  assert.equal(state.hasFreshFrame, true);

  state = await service.handleInput(session.sessionId, {
    type: 'click',
    x: 12,
    y: 24,
    button: 'left'
  });
  assert.equal(state.frameVersion, 2);
  assert.equal(state.hasFreshFrame, true);

  await service.dispose();
});

test('browser service cleans up idle sessions', async () => {
  let currentTime = 0;
  const engine = createFakeEngine();
  const service = createBrowserService({
    engine,
    autoCleanup: false,
    idleTimeoutMs: 1000,
    now: () => currentTime
  });

  const session = await service.ensureSession({
    userKey: 'alice',
    sessionScope: 'browser'
  });

  currentTime = 1500;
  await service.disposeIdleSessions();

  await assert.rejects(
    () => service.getState(session.sessionId),
    /Browsersessie niet gevonden/
  );
  assert.equal(engine.remotes[0].disposed, true);

  await service.dispose();
});

test('browser app exposes cached JPEG frames over HTTP', async () => {
  const engine = createFakeEngine();
  const browserService = createBrowserService({ engine, autoCleanup: false });
  const { app } = createApp({ browserService, includeGun: false });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    let response = await fetch(`${baseUrl}/browser/session`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://chatlon-client.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type'
      }
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://chatlon-client.example');
    assert.match(response.headers.get('access-control-allow-methods'), /POST/);

    response = await fetch(`${baseUrl}/browser/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userKey: 'alice',
        sessionScope: 'browser',
        viewportWidth: 800,
        viewportHeight: 600
      })
    });
    assert.equal(response.status, 200);
    const created = await response.json();
    assert.ok(created.sessionId);
    assert.equal(created.url, BROWSER_HOME_URL);
    assert.equal(created.frameVersion, 1);
    assert.equal(created.frameMimeType, 'image/jpeg');
    assert.equal(created.hasFreshFrame, true);

    response = await fetch(`${baseUrl}/browser/frame/${created.sessionId}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    const frame = Buffer.from(await response.arrayBuffer());
    assert.match(frame.toString(), /^frame:/);

    response = await fetch(`${baseUrl}/browser/frame/${created.sessionId}`);
    assert.equal(response.status, 200);
    const repeatedFrame = Buffer.from(await response.arrayBuffer());
    assert.equal(repeatedFrame.toString(), frame.toString());

    response = await fetch(`${baseUrl}/browser/state/${created.sessionId}`);
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.frameVersion, 1);

    response = await fetch(`${baseUrl}/browser/state/missing-session`);
    assert.equal(response.status, 404);
    const missing = await response.json();
    assert.match(missing.error, /Browsersessie niet gevonden/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await browserService.dispose();
  }
});

test('browser app exposes live browser state over SSE', async () => {
  const engine = createFakeEngine();
  const browserService = createBrowserService({ engine, autoCleanup: false });
  const { app } = createApp({ browserService, includeGun: false });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let stream = null;

  try {
    const createResponse = await fetch(`${baseUrl}/browser/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userKey: 'alice',
        sessionScope: 'browser',
        viewportWidth: 800,
        viewportHeight: 600
      })
    });
    const created = await createResponse.json();

    stream = await openSseStream(`${baseUrl}/browser/events/${created.sessionId}`);
    assert.equal(stream.response.statusCode, 200);
    assert.match(stream.response.headers['content-type'], /text\/event-stream/);

    await stream.waitFor(BROWSER_HOME_URL);

    const navigateResponse = await fetch(`${baseUrl}/browser/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: created.sessionId,
        url: 'https://example.com/'
      })
    });
    assert.equal(navigateResponse.status, 200);

    const payload = await stream.waitFor('https://example.com/');
    assert.match(payload, /"url":"https:\/\/example.com\/"/);
  } finally {
    stream?.close();
    await new Promise((resolve) => server.close(resolve));
    await browserService.dispose();
  }
});
