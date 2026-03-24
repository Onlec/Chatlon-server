const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const {
  createBrowserService,
  BROWSER_HOME_URL,
  MAX_VIEWPORT_AREA,
  normalizeViewportSize
} = require('./browserService');
const { createPlaywrightBrowserEngine } = require('./playwrightBrowserEngine');
const { createApp } = require('./app');
const { attachBrowserSocket } = require('./browserSocket');
const {
  CLIENT_BINARY_OPCODE,
  FRAME_MIME_CODE,
  SERVER_BINARY_OPCODE
} = require('./browserProtocol');

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
          if (payload.type === 'click' || payload.type === 'dblclick' || payload.type === 'wheel' || payload.type === 'keydown' || payload.type === 'type' || payload.type === 'paste') {
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

function createClickPacket(x, y, buttonCode) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt8(CLIENT_BINARY_OPCODE.CLICK, 0);
  buffer.writeUInt16LE(5, 1);
  buffer.writeUInt16LE(x, 3);
  buffer.writeUInt16LE(y, 5);
  buffer.writeUInt8(buttonCode, 7);
  return buffer;
}

function createInvalidPacket() {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt8(0xff, 0);
  buffer.writeUInt16LE(1, 1);
  buffer.writeUInt8(0, 3);
  return buffer;
}

function parseFramePacket(buffer) {
  return {
    opcode: buffer.readUInt8(0),
    frameVersion: buffer.readUInt32LE(1),
    mimeCode: buffer.readUInt8(5),
    payload: buffer.subarray(6).toString()
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakePlaywrightModule() {
  const page = {
    handlers: new Map(),
    bindings: new Map(),
    currentUrl: 'about:blank',
    currentTitle: '',
    viewport: null,
    screenshotCount: 0,
    mainFrameRef: {
      url() {
        return page.currentUrl;
      }
    },
    on(eventName, handler) {
      const handlers = this.handlers.get(eventName) || [];
      handlers.push(handler);
      this.handlers.set(eventName, handlers);
    },
    async emit(eventName, ...args) {
      for (const handler of this.handlers.get(eventName) || []) {
        await handler(...args);
      }
    },
    async exposeBinding(name, handler) {
      this.bindings.set(name, handler);
    },
    async addInitScript() {},
    mainFrame() {
      return this.mainFrameRef;
    },
    url() {
      return this.currentUrl;
    },
    async title() {
      return this.currentTitle;
    },
    async screenshot() {
      this.screenshotCount += 1;
      return Buffer.from(`shot:${this.screenshotCount}`);
    },
    async goto(url) {
      this.currentUrl = url;
      this.currentTitle = url.includes('#yoctol-home=') ? 'Yoctol Startpagina' : url;
      await this.emit('framenavigated', this.mainFrameRef);
      await this.emit('domcontentloaded');
      await this.emit('load');
      return { url };
    },
    async goBack() {
      return null;
    },
    async goForward() {
      return null;
    },
    async reload() {
      await this.emit('domcontentloaded');
      await this.emit('load');
      return { url: this.currentUrl };
    },
    async evaluate() {},
    async setViewportSize(viewport) {
      this.viewport = viewport;
    },
    mouse: {
      async move() {},
      async click() {},
      async wheel() {}
    },
    keyboard: {
      async press() {},
      async up() {},
      async insertText() {}
    },
    async bringToFront() {}
  };

  const context = {
    page,
    async newPage() {
      return page;
    },
    async close() {}
  };

  const browser = {
    async newContext(options) {
      page.viewport = options.viewport;
      return context;
    },
    on() {},
    isConnected() {
      return true;
    },
    async close() {}
  };

  return {
    page,
    chromium: {
      async launch() {
        return browser;
      }
    }
  };
}

function openBrowserSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages = [];
    const waiters = [];

    const flushWaiters = (message) => {
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        try {
          if (waiter.matcher(message)) {
            waiters.splice(index, 1);
            waiter.resolve(message);
          }
        } catch (error) {
          waiters.splice(index, 1);
          waiter.reject(error);
        }
      }
    };

    socket.on('open', () => {
      resolve({
        socket,
        messages,
        waitFor(matcher) {
          const existing = messages.find(matcher);
          if (existing) {
            return Promise.resolve(existing);
          }

          return new Promise((waitResolve, waitReject) => {
            waiters.push({
              matcher,
              resolve: waitResolve,
              reject: waitReject
            });
          });
        },
        close() {
          socket.close();
        }
      });
    });

    socket.on('message', (data) => {
      const message = (typeof data === 'string')
        ? { kind: 'text', data: JSON.parse(data) }
        : { kind: 'binary', data: Buffer.from(data) };
      messages.push(message);
      flushWaiters(message);
    });

    socket.on('error', reject);
  });
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

test('browser service deduplicates concurrent session boot for the same key', async () => {
  const engine = createFakeEngine();
  const originalCreateSession = engine.createSession.bind(engine);
  let releaseCreateSession;
  const createSessionGate = new Promise((resolve) => {
    releaseCreateSession = resolve;
  });

  engine.createSession = async (options) => {
    await createSessionGate;
    return originalCreateSession(options);
  };

  const service = createBrowserService({ engine, autoCleanup: false });

  const firstSessionPromise = service.ensureSession({
    userKey: 'alice',
    sessionScope: 'browser',
    viewportWidth: 800,
    viewportHeight: 600
  });
  const secondSessionPromise = service.ensureSession({
    userKey: 'alice',
    sessionScope: 'browser',
    viewportWidth: 1024,
    viewportHeight: 768
  });

  releaseCreateSession();

  const [firstSession, secondSession] = await Promise.all([
    firstSessionPromise,
    secondSessionPromise
  ]);

  assert.equal(firstSession.sessionId, secondSession.sessionId);
  assert.equal(engine.remotes.length, 1);
  assert.deepEqual(engine.remotes[0].inputs[0], {
    type: 'resize',
    viewportWidth: secondSession.viewportWidth,
    viewportHeight: secondSession.viewportHeight
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

  state = await service.handleInput(session.sessionId, {
    type: 'paste',
    text: 'hunter2'
  });
  assert.equal(state.frameVersion, 3);
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

test('playwright browser engine rerenders when the page changes without input', async () => {
  const fakePlaywright = createFakePlaywrightModule();
  const frames = [];
  const engine = createPlaywrightBrowserEngine({
    requirePlaywright: () => fakePlaywright,
    interactiveRenderDelayMs: 5,
    idleRenderDelayMs: 10,
    observedChangeRenderDelayMs: 5
  });

  const session = await engine.createSession({
    sessionId: 'session-1',
    viewportWidth: 800,
    viewportHeight: 600,
    onNavigation() {},
    onLoadingChange() {},
    onError(error) {
      throw error;
    },
    onFrame(frame) {
      frames.push(frame.buffer.toString());
    }
  });

  await session.navigateHome();
  await wait(30);
  const baselineFrameCount = frames.length;

  const pageChangeBinding = fakePlaywright.page.bindings.get('__chatlonPageChanged');
  assert.equal(typeof pageChangeBinding, 'function');

  await pageChangeBinding({
    page: fakePlaywright.page,
    frame: fakePlaywright.page.mainFrame()
  });
  await wait(30);

  assert.ok(frames.length > baselineFrameCount);

  await session.dispose();
  await engine.dispose();
});

test('browser socket streams session state and binary JPEG frames', async () => {
  const engine = createFakeEngine();
  const browserService = createBrowserService({ engine, autoCleanup: false });
  const { app } = createApp({ browserService, includeGun: false });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const browserSocket = attachBrowserSocket(server, { browserService });
  const address = server.address();
  const baseUrl = `ws://127.0.0.1:${address.port}/browser/socket`;

  let client = null;

  try {
    client = await openBrowserSocket(baseUrl);
    client.socket.send(JSON.stringify({
      type: 'session.ensure',
      payload: {
        userKey: 'alice',
        sessionScope: 'browser',
        viewportWidth: 800,
        viewportHeight: 600
      }
    }));

    const readyMessage = await client.waitFor((message) => (
      message.kind === 'text' && message.data.type === 'session.ready'
    ));
    assert.equal(readyMessage.data.payload.state.url, BROWSER_HOME_URL);
    assert.equal(readyMessage.data.payload.state.frameVersion, 1);

    const frameMessage = await client.waitFor((message) => message.kind === 'binary');
    const frame = parseFramePacket(frameMessage.data);
    assert.equal(frame.opcode, SERVER_BINARY_OPCODE.FRAME);
    assert.equal(frame.frameVersion, 1);
    assert.equal(frame.mimeCode, FRAME_MIME_CODE.JPEG);
    assert.match(frame.payload, /^frame:/);
  } finally {
    client?.close();
    await browserSocket.close();
    await new Promise((resolve) => server.close(resolve));
    await browserService.dispose();
  }
});

test('browser socket handles commands and binary pointer input', async () => {
  const engine = createFakeEngine();
  const browserService = createBrowserService({ engine, autoCleanup: false });
  const { app } = createApp({ browserService, includeGun: false });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const browserSocket = attachBrowserSocket(server, { browserService });
  const address = server.address();
  const baseUrl = `ws://127.0.0.1:${address.port}/browser/socket`;

  let client = null;

  try {
    client = await openBrowserSocket(baseUrl);
    client.socket.send(JSON.stringify({
      type: 'session.ensure',
      payload: {
        userKey: 'alice',
        sessionScope: 'browser',
        viewportWidth: 800,
        viewportHeight: 600
      }
    }));

    await client.waitFor((message) => (
      message.kind === 'text' && message.data.type === 'session.ready'
    ));

    client.socket.send(JSON.stringify({
      type: 'browser.command',
      payload: {
        action: 'navigate',
        url: 'https://example.com/'
      }
    }));

    const navigateState = await client.waitFor((message) => (
      message.kind === 'text'
      && message.data.type === 'browser.state'
      && message.data.payload.url === 'https://example.com/'
    ));
    assert.equal(navigateState.data.payload.canGoBack, true);

    client.socket.send(createClickPacket(24, 32, 0));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(engine.remotes[0].inputs.at(-1), {
      type: 'click',
      x: 24,
      y: 32,
      button: 'left'
    });
  } finally {
    client?.close();
    await browserSocket.close();
    await new Promise((resolve) => server.close(resolve));
    await browserService.dispose();
  }
});

test('browser socket reports invalid binary packets without dropping the session', async () => {
  const engine = createFakeEngine();
  const browserService = createBrowserService({ engine, autoCleanup: false });
  const { app } = createApp({ browserService, includeGun: false });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const browserSocket = attachBrowserSocket(server, { browserService });
  const address = server.address();
  const baseUrl = `ws://127.0.0.1:${address.port}/browser/socket`;

  let client = null;

  try {
    client = await openBrowserSocket(baseUrl);
    client.socket.send(JSON.stringify({
      type: 'session.ensure',
      payload: {
        userKey: 'alice',
        sessionScope: 'browser',
        viewportWidth: 800,
        viewportHeight: 600
      }
    }));

    const readyMessage = await client.waitFor((message) => (
      message.kind === 'text' && message.data.type === 'session.ready'
    ));
    const sessionId = readyMessage.data.payload.state.sessionId;

    client.socket.send(createInvalidPacket());

    const errorMessage = await client.waitFor((message) => (
      message.kind === 'text' && message.data.type === 'browser.error'
    ));
    assert.match(errorMessage.data.payload.message, /Unknown browser input opcode/);

    const state = await browserService.getState(sessionId);
    assert.equal(state.url, BROWSER_HOME_URL);
  } finally {
    client?.close();
    await browserSocket.close();
    await new Promise((resolve) => server.close(resolve));
    await browserService.dispose();
  }
});

test('closing a browser socket only removes listeners and keeps the session alive', async () => {
  const engine = createFakeEngine();
  const browserService = createBrowserService({ engine, autoCleanup: false });
  const { app } = createApp({ browserService, includeGun: false });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const browserSocket = attachBrowserSocket(server, { browserService });
  const address = server.address();
  const baseUrl = `ws://127.0.0.1:${address.port}/browser/socket`;

  let client = null;

  try {
    client = await openBrowserSocket(baseUrl);
    client.socket.send(JSON.stringify({
      type: 'session.ensure',
      payload: {
        userKey: 'alice',
        sessionScope: 'browser',
        viewportWidth: 800,
        viewportHeight: 600
      }
    }));

    const readyMessage = await client.waitFor((message) => (
      message.kind === 'text' && message.data.type === 'session.ready'
    ));
    const sessionId = readyMessage.data.payload.state.sessionId;

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const state = await browserService.getState(sessionId);
    assert.equal(state.sessionId, sessionId);
    assert.equal(engine.remotes[0].disposed, false);
  } finally {
    await browserSocket.close();
    await new Promise((resolve) => server.close(resolve));
    await browserService.dispose();
  }
});
