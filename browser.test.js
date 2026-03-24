const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserService, BROWSER_HOME_URL } = require('./browserService');
const { createApp } = require('./app');

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
      onError
    }) {
      const history = [];
      let historyIndex = -1;

      const emitCurrent = async () => {
        const entry = history[historyIndex];
        if (!entry) return;
        onNavigation?.({ ...entry });
        onLoadingChange?.(false);
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
        },
        async goBack() {
          this.calls.push({ type: 'back' });
          onLoadingChange?.(true);
          if (historyIndex > 0) {
            historyIndex -= 1;
          }
          await emitCurrent();
        },
        async goForward() {
          this.calls.push({ type: 'forward' });
          onLoadingChange?.(true);
          if (historyIndex < history.length - 1) {
            historyIndex += 1;
          }
          await emitCurrent();
        },
        async reload() {
          this.calls.push({ type: 'reload' });
          onLoadingChange?.(true);
          await emitCurrent();
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
          }
        },
        async getFrame() {
          return Buffer.from('frame');
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
    viewportWidth: 1024,
    viewportHeight: 768
  });
  const bob = await service.ensureSession({
    userKey: 'bob',
    sessionScope: 'browser',
    viewportWidth: 700,
    viewportHeight: 500
  });

  assert.equal(aliceOne.sessionId, aliceTwo.sessionId);
  assert.notEqual(aliceOne.sessionId, bob.sessionId);
  assert.equal(aliceTwo.viewportWidth, 1024);
  assert.equal(aliceTwo.viewportHeight, 768);
  assert.deepEqual(engine.remotes[0].inputs[0], {
    type: 'resize',
    viewportWidth: 1024,
    viewportHeight: 768
  });

  await service.dispose();
});

test('browser service tracks navigate, home, back, forward, reload and external page navigation', async () => {
  const engine = createFakeEngine();
  const service = createBrowserService({ engine, autoCleanup: false });

  const session = await service.ensureSession({
    userKey: 'alice',
    sessionScope: 'browser'
  });

  let state = await service.navigate(session.sessionId, 'https://example.com/');
  assert.equal(state.url, 'https://example.com/');
  assert.equal(state.canGoBack, true);

  state = await service.goHome(session.sessionId);
  assert.equal(state.url, BROWSER_HOME_URL);
  assert.equal(state.canGoBack, true);

  state = await service.goBack(session.sessionId);
  assert.equal(state.url, 'https://example.com/');
  assert.equal(state.canGoForward, true);

  state = await service.goForward(session.sessionId);
  assert.equal(state.url, BROWSER_HOME_URL);

  state = await service.reload(session.sessionId);
  assert.equal(state.url, BROWSER_HOME_URL);

  await engine.remotes[0].emitExternalNavigation('https://wikipedia.org/');
  state = await service.getState(session.sessionId);
  assert.equal(state.url, 'https://wikipedia.org/');
  assert.equal(state.title, 'External https://wikipedia.org/');

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

test('browser app exposes the remote browser API over HTTP', async () => {
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

    response = await fetch(`${baseUrl}/browser/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: created.sessionId,
        url: 'https://example.com/'
      })
    });
    assert.equal(response.status, 200);
    const navigated = await response.json();
    assert.equal(navigated.url, 'https://example.com/');

    response = await fetch(`${baseUrl}/browser/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: created.sessionId,
        type: 'click',
        x: 20,
        y: 35,
        button: 'left'
      })
    });
    assert.equal(response.status, 200);

    response = await fetch(`${baseUrl}/browser/frame/${created.sessionId}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const frame = Buffer.from(await response.arrayBuffer());
    assert.equal(frame.toString(), 'frame');

    response = await fetch(`${baseUrl}/browser/state/missing-session`);
    assert.equal(response.status, 404);
    const missing = await response.json();
    assert.match(missing.error, /Browsersessie niet gevonden/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await browserService.dispose();
  }
});
