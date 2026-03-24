const { randomUUID } = require('crypto');

const BROWSER_HOME_URL = 'yoctol://home';
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

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
    viewportHeight: session.viewportHeight
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

  const touch = (session) => {
    session.lastTouchedAt = now();
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
  };

  const handleError = (session, error) => {
    touch(session);
    session.isLoading = false;
    session.lastError = typeof error === 'string' ? error : (error?.message || 'Onbekende browserfout.');
    clearNavigationPhase(session);
  };

  const handleLoadingChange = (session, isLoading) => {
    touch(session);
    session.isLoading = Boolean(isLoading);
    if (!isLoading) {
      clearNavigationPhase(session);
    }
  };

  const createManagedSession = async ({ userKey, sessionScope, viewportWidth, viewportHeight }) => {
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
      viewportWidth,
      viewportHeight,
      navigationPhase: 'replace-current',
      lastTouchedAt: now(),
      remote: null
    };

    session.remote = await engine.createSession({
      sessionId: session.id,
      viewportWidth,
      viewportHeight,
      onNavigation: (payload) => handleNavigation(session, payload),
      onLoadingChange: (isLoading) => handleLoadingChange(session, isLoading),
      onError: (error) => handleError(session, error)
    });

    await session.remote.navigateHome();
    session.isLoading = false;
    clearNavigationPhase(session);

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
    const key = `${userKey}::${sessionScope}`;
    const existingId = sessionIdByKey.get(key);
    const existing = existingId ? sessionsById.get(existingId) : null;

    if (existing) {
      touch(existing);
      if (
        existing.viewportWidth !== viewportWidth
        || existing.viewportHeight !== viewportHeight
      ) {
        existing.viewportWidth = viewportWidth;
        existing.viewportHeight = viewportHeight;
        await existing.remote.handleInput({
          type: 'resize',
          viewportWidth,
          viewportHeight
        });
      }
      return cloneState(existing);
    }

    const session = await createManagedSession({
      userKey,
      sessionScope,
      viewportWidth,
      viewportHeight
    });

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
    return session.remote.getFrame();
  };

  const navigate = async (sessionId, url) => {
    const session = getSession(sessionId);
    touch(session);
    session.lastError = null;
    session.isLoading = true;
    session.navigationPhase = 'replace-current';
    pushEntry(session, createPageEntry(url, url));

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
    pushEntry(session, createHomeEntry());

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
    return cloneState(session);
  };

  const handleInput = async (sessionId, payload = {}) => {
    const session = getSession(sessionId);
    touch(session);

    if (payload.type === 'resize') {
      session.viewportWidth = payload.viewportWidth || session.viewportWidth;
      session.viewportHeight = payload.viewportHeight || session.viewportHeight;
    }

    await session.remote.handleInput(payload);
    return cloneState(session);
  };

  const destroySession = async (sessionId) => {
    const session = sessionsById.get(sessionId);
    if (!session) return;

    sessionsById.delete(sessionId);
    sessionIdByKey.delete(session.key);
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
    destroySession,
    disposeIdleSessions,
    dispose
  };
}

module.exports = {
  BROWSER_HOME_URL,
  DEFAULT_IDLE_TIMEOUT_MS,
  createBrowserService
};
