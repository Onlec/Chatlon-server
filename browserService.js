const { randomUUID } = require('crypto');

const BROWSER_HOME_URL = 'yoctol://home';
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const DEFAULT_FRAME_MIME_TYPE = 'image/jpeg';
const MAX_VIEWPORT_AREA = 640000;
const DIRTY_INPUT_TYPES = new Set([
  'resize',
  'click',
  'dblclick',
  'wheel',
  'keydown',
  'type',
  'paste'
]);

function createHomeEntry() {
  return {
    mode: 'home',
    url: BROWSER_HOME_URL,
    title: 'Yoctol Startpagina'
  };
}

function createPageEntry(url, title) {
  return {
    mode: 'page',
    url,
    title: title || url
  };
}

function normalizeViewportSize(rawWidth, rawHeight) {
  const width = Math.max(1, Math.floor(Number(rawWidth) || DEFAULT_VIEWPORT.width));
  const height = Math.max(1, Math.floor(Number(rawHeight) || DEFAULT_VIEWPORT.height));
  const area = width * height;

  if (area <= MAX_VIEWPORT_AREA) {
    return { width, height };
  }

  const scale = Math.sqrt(MAX_VIEWPORT_AREA / area);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale))
  };
}

function cloneState(session) {
  const currentEntry = session.history[session.historyIndex] || createHomeEntry();
  return {
    sessionId: session.id,
    url: currentEntry.url,
    title: currentEntry.title || currentEntry.url,
    canGoBack: session.historyIndex > 0,
    canGoForward: session.historyIndex < session.history.length - 1,
    isLoading: Boolean(session.isLoading),
    lastError: session.lastError,
    viewportWidth: session.viewportWidth,
    viewportHeight: session.viewportHeight,
    frameVersion: session.frameVersion,
    frameMimeType: session.frameMimeType,
    hasFreshFrame: session.hasFreshFrame
  };
}

function createError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createBrowserService({
  engine,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  cleanupIntervalMs = 60 * 1000,
  autoCleanup = true,
  now = () => Date.now()
}) {
  if (!engine || typeof engine.createSession !== 'function') {
    throw new Error('createBrowserService requires an engine with createSession().');
  }

  const sessionsById = new Map();
  const sessionIdByKey = new Map();
  const pendingSessionPromisesByKey = new Map();

  const touch = (session) => {
    session.lastTouchedAt = now();
  };

  const publishState = (session) => {
    const snapshot = cloneState(session);
    for (const listener of session.listeners) {
      try {
        listener(snapshot);
      } catch {}
    }
    return snapshot;
  };

  const publishFrame = (session) => {
    if (!session.lastFrame) {
      return null;
    }

    for (const listener of session.frameListeners) {
      try {
        listener(session.lastFrame);
      } catch {}
    }

    return session.lastFrame;
  };

  const markFrameStale = (session) => {
    session.hasFreshFrame = false;
  };

  const updateCurrentEntry = (session, payload) => {
    const entry = payload.mode === 'home'
      ? createHomeEntry()
      : createPageEntry(payload.url, payload.title);

    session.history[session.historyIndex] = entry;
  };

  const pushEntry = (session, entry) => {
    session.history = [...session.history.slice(0, session.historyIndex + 1), entry];
    session.historyIndex = session.history.length - 1;
  };

  const getSession = (sessionId) => {
    const session = sessionsById.get(sessionId);
    if (!session) {
      throw createError('Browsersessie niet gevonden.', 404);
    }
    return session;
  };

  const clearNavigationPhase = (session) => {
    session.navigationPhase = null;
  };

  const syncViewport = async (session, viewport) => {
    if (
      session.viewportWidth === viewport.width
      && session.viewportHeight === viewport.height
    ) {
      return;
    }

    session.viewportWidth = viewport.width;
    session.viewportHeight = viewport.height;
    markFrameStale(session);
    publishState(session);
    await session.remote.handleInput({
      type: 'resize',
      viewportWidth: viewport.width,
      viewportHeight: viewport.height
    });
  };

  const handleFrame = (session, frame) => {
    touch(session);
    session.frameVersion += 1;
    session.frameMimeType = frame.mimeType || DEFAULT_FRAME_MIME_TYPE;
    session.hasFreshFrame = true;
    session.lastFrame = {
      frameVersion: session.frameVersion,
      frameMimeType: session.frameMimeType,
      buffer: frame.buffer
    };
    publishFrame(session);
    publishState(session);
  };

  const handleNavigation = (session, payload) => {
    touch(session);
    session.lastError = null;

    if (session.navigationPhase === 'replace-current') {
      updateCurrentEntry(session, payload);
      return;
    }

    pushEntry(
      session,
      payload.mode === 'home'
        ? createHomeEntry()
        : createPageEntry(payload.url, payload.title)
    );
    session.navigationPhase = 'replace-current';
    publishState(session);
  };

  const handleError = (session, error) => {
    touch(session);
    session.isLoading = false;
    session.lastError = typeof error === 'string' ? error : (error?.message || 'Onbekende browserfout.');
    clearNavigationPhase(session);
    publishState(session);
  };

  const handleLoadingChange = (session, isLoading) => {
    touch(session);
    session.isLoading = Boolean(isLoading);
    if (isLoading) {
      markFrameStale(session);
      publishState(session);
      return;
    }
    clearNavigationPhase(session);
    publishState(session);
  };

  const createManagedSession = async ({
    userKey,
    sessionScope,
    viewportWidth,
    viewportHeight
  }) => {
    const normalizedViewport = normalizeViewportSize(viewportWidth, viewportHeight);
    const homeEntry = createHomeEntry();
    const session = {
      id: randomUUID(),
      key: `${userKey}::${sessionScope}`,
      userKey,
      sessionScope,
      history: [homeEntry],
      historyIndex: 0,
      isLoading: true,
      lastError: null,
      viewportWidth: normalizedViewport.width,
      viewportHeight: normalizedViewport.height,
      navigationPhase: 'replace-current',
      lastTouchedAt: now(),
      frameVersion: 0,
      frameMimeType: DEFAULT_FRAME_MIME_TYPE,
      hasFreshFrame: false,
      listeners: new Set(),
      frameListeners: new Set(),
      lastFrame: null,
      remote: null
    };

    session.remote = await engine.createSession({
      sessionId: session.id,
      viewportWidth: normalizedViewport.width,
      viewportHeight: normalizedViewport.height,
      onNavigation: (payload) => handleNavigation(session, payload),
      onLoadingChange: (isLoading) => handleLoadingChange(session, isLoading),
      onError: (error) => handleError(session, error),
      onFrame: (frame) => handleFrame(session, frame)
    });

    await session.remote.navigateHome();
    await session.remote.ensureFrame();
    session.isLoading = false;
    clearNavigationPhase(session);
    publishState(session);

    sessionsById.set(session.id, session);
    sessionIdByKey.set(session.key, session.id);

    return session;
  };

  const ensureSession = async ({
    userKey = 'guest',
    sessionScope = 'browser',
    viewportWidth = DEFAULT_VIEWPORT.width,
    viewportHeight = DEFAULT_VIEWPORT.height
  } = {}) => {
    const normalizedViewport = normalizeViewportSize(viewportWidth, viewportHeight);
    const key = `${userKey}::${sessionScope}`;
    const existingId = sessionIdByKey.get(key);
    const existing = existingId ? sessionsById.get(existingId) : null;

    if (existing) {
      touch(existing);
      await syncViewport(existing, normalizedViewport);
      return cloneState(existing);
    }

    const pendingSession = pendingSessionPromisesByKey.get(key);
    if (pendingSession) {
      const session = await pendingSession;
      touch(session);
      await syncViewport(session, normalizedViewport);
      return cloneState(session);
    }

    const sessionPromise = createManagedSession({
      userKey,
      sessionScope,
      viewportWidth: normalizedViewport.width,
      viewportHeight: normalizedViewport.height
    });
    pendingSessionPromisesByKey.set(key, sessionPromise);

    let session;
    try {
      session = await sessionPromise;
    } finally {
      if (pendingSessionPromisesByKey.get(key) === sessionPromise) {
        pendingSessionPromisesByKey.delete(key);
      }
    }

    return cloneState(session);
  };

  const getState = async (sessionId) => {
    const session = getSession(sessionId);
    touch(session);
    return cloneState(session);
  };

  const getFrame = async (sessionId) => {
    const session = getSession(sessionId);
    touch(session);
    return session.lastFrame || session.remote.getFrame();
  };

  const navigate = async (sessionId, url) => {
    const session = getSession(sessionId);
    touch(session);
    session.lastError = null;
    session.isLoading = true;
    session.navigationPhase = 'replace-current';
    markFrameStale(session);
    pushEntry(session, createPageEntry(url, url));
    publishState(session);

    try {
      await session.remote.navigate(url);
    } catch (error) {
      handleError(session, error);
    }

    return cloneState(session);
  };

  const goHome = async (sessionId) => {
    const session = getSession(sessionId);
    touch(session);
    session.lastError = null;
    session.isLoading = true;
    session.navigationPhase = 'replace-current';
    markFrameStale(session);
    pushEntry(session, createHomeEntry());
    publishState(session);

    try {
      await session.remote.navigateHome();
    } catch (error) {
      handleError(session, error);
    }

    return cloneState(session);
  };

  const goBack = async (sessionId) => {
    const session = getSession(sessionId);
    if (session.historyIndex === 0) {
      return cloneState(session);
    }

    touch(session);
    session.lastError = null;
    session.isLoading = true;
    session.historyIndex -= 1;
    session.navigationPhase = 'replace-current';
    markFrameStale(session);
    publishState(session);

    try {
      await session.remote.goBack();
    } catch (error) {
      handleError(session, error);
    }

    return cloneState(session);
  };

  const goForward = async (sessionId) => {
    const session = getSession(sessionId);
    if (session.historyIndex >= session.history.length - 1) {
      return cloneState(session);
    }

    touch(session);
    session.lastError = null;
    session.isLoading = true;
    session.historyIndex += 1;
    session.navigationPhase = 'replace-current';
    markFrameStale(session);
    publishState(session);

    try {
      await session.remote.goForward();
    } catch (error) {
      handleError(session, error);
    }

    return cloneState(session);
  };

  const reload = async (sessionId) => {
    const session = getSession(sessionId);
    touch(session);
    session.lastError = null;
    session.isLoading = true;
    session.navigationPhase = 'replace-current';
    markFrameStale(session);
    publishState(session);

    try {
      await session.remote.reload();
    } catch (error) {
      handleError(session, error);
    }

    return cloneState(session);
  };

  const stop = async (sessionId) => {
    const session = getSession(sessionId);
    touch(session);
    session.isLoading = false;
    clearNavigationPhase(session);
    await session.remote.stop();
    return publishState(session);
  };

  const handleInput = async (sessionId, payload = {}) => {
    const session = getSession(sessionId);
    touch(session);

    let nextPayload = payload;

    if (payload.type === 'resize') {
      const normalizedViewport = normalizeViewportSize(
        payload.viewportWidth || session.viewportWidth,
        payload.viewportHeight || session.viewportHeight
      );
      session.viewportWidth = normalizedViewport.width;
      session.viewportHeight = normalizedViewport.height;
      nextPayload = {
        ...payload,
        viewportWidth: normalizedViewport.width,
        viewportHeight: normalizedViewport.height
      };
    }

    if (DIRTY_INPUT_TYPES.has(nextPayload.type)) {
      markFrameStale(session);
    }

    publishState(session);
    await session.remote.handleInput(nextPayload);
    return cloneState(session);
  };

  const subscribeState = (sessionId, listener) => {
    const session = getSession(sessionId);
    touch(session);
    session.listeners.add(listener);
    return {
      state: cloneState(session),
      unsubscribe: () => {
        session.listeners.delete(listener);
      }
    };
  };

  const subscribeFrames = (sessionId, listener) => {
    const session = getSession(sessionId);
    touch(session);
    session.frameListeners.add(listener);
    return {
      frame: session.lastFrame,
      unsubscribe: () => {
        session.frameListeners.delete(listener);
      }
    };
  };

  const destroySession = async (sessionId) => {
    const session = sessionsById.get(sessionId);
    if (!session) return;

    sessionsById.delete(sessionId);
    sessionIdByKey.delete(session.key);
    session.listeners.clear();
    session.frameListeners.clear();
    await session.remote.dispose();
  };

  const disposeIdleSessions = async () => {
    const expiredIds = [];
    for (const [sessionId, session] of sessionsById.entries()) {
      if ((now() - session.lastTouchedAt) >= idleTimeoutMs) {
        expiredIds.push(sessionId);
      }
    }

    await Promise.all(expiredIds.map((sessionId) => destroySession(sessionId)));
  };

  let cleanupTimer = null;
  if (autoCleanup) {
    cleanupTimer = setInterval(() => {
      disposeIdleSessions().catch(() => {});
    }, cleanupIntervalMs);

    if (typeof cleanupTimer.unref === 'function') {
      cleanupTimer.unref();
    }
  }

  const dispose = async () => {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }

    const sessionIds = [...sessionsById.keys()];
    await Promise.all(sessionIds.map((sessionId) => destroySession(sessionId)));

    if (typeof engine.dispose === 'function') {
      await engine.dispose();
    }
  };

  return {
    ensureSession,
    getState,
    getFrame,
    navigate,
    goHome,
    goBack,
    goForward,
    reload,
    stop,
    handleInput,
    subscribeState,
    subscribeFrames,
    destroySession,
    disposeIdleSessions,
    dispose
  };
}

module.exports = {
  BROWSER_HOME_URL,
  DEFAULT_IDLE_TIMEOUT_MS,
  MAX_VIEWPORT_AREA,
  normalizeViewportSize,
  createBrowserService
};
