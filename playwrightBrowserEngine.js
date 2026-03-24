const { BROWSER_HOME_URL } = require('./browserService');

const INTERACTIVE_RENDER_DELAY_MS = 35;
const IDLE_RENDER_DELAY_MS = 180;
const INTERACTIVE_JPEG_QUALITY = 46;
const IDLE_JPEG_QUALITY = 78;
const FRAME_MIME_TYPE = 'image/jpeg';

function createMissingPlaywrightError(error) {
  const message = error?.message || 'Playwright is niet beschikbaar.';
  return new Error(
    `${message} Installeer Playwright in gun-server om de remote browser te gebruiken.`
  );
}

function encodeHomeDocument(sessionId, visitId) {
  const html = `<!doctype html>
<html lang="nl">
  <head>
    <meta charset="utf-8">
    <title>Yoctol Startpagina</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body data-yoctol-home="${sessionId}-${visitId}"></body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}#yoctol-home=${sessionId}-${visitId}`;
}

function normalizeTitle(page, mode) {
  if (mode === 'home') {
    return Promise.resolve('Yoctol Startpagina');
  }

  return page.title().catch(() => '').then((title) => title || page.url());
}

function createPlaywrightBrowserEngine({
  requirePlaywright = () => require('playwright'),
  launchOptions = { headless: true }
} = {}) {
  let browserPromise = null;

  const getBrowser = async () => {
    if (!browserPromise) {
      browserPromise = (async () => {
        try {
          const playwright = requirePlaywright();
          const chromium = playwright.chromium || playwright;
          return chromium.launch(launchOptions);
        } catch (error) {
          throw createMissingPlaywrightError(error);
        }
      })();
    }

    return browserPromise;
  };

  const createSession = async ({
    sessionId,
    viewportWidth,
    viewportHeight,
    onNavigation,
    onLoadingChange,
    onError,
    onFrame
  }) => {
    const browser = await getBrowser();
    const context = await browser.newContext({
      viewport: {
        width: viewportWidth,
        height: viewportHeight
      },
      ignoreHTTPSErrors: true
    });
    const page = await context.newPage();
    let homeVisitId = 0;
    let interactiveRenderTimer = null;
    let idleRenderTimer = null;
    let cachedFrame = null;
    let renderInFlight = null;
    let pendingRenderQuality = null;
    let disposed = false;

    const isHomeTarget = (url) => typeof url === 'string' && url.includes('#yoctol-home=');

    const emitNavigation = async (urlOverride) => {
      const actualUrl = urlOverride || page.url();
      const mode = isHomeTarget(actualUrl) ? 'home' : 'page';
      const title = await normalizeTitle(page, mode);
      onNavigation?.({
        mode,
        url: mode === 'home' ? BROWSER_HOME_URL : actualUrl,
        title
      });
    };

    const clearRenderTimers = () => {
      if (interactiveRenderTimer) {
        clearTimeout(interactiveRenderTimer);
        interactiveRenderTimer = null;
      }
      if (idleRenderTimer) {
        clearTimeout(idleRenderTimer);
        idleRenderTimer = null;
      }
    };

    const renderFrame = async (quality) => {
      if (disposed) return cachedFrame;

      const buffer = await page.screenshot({
        type: 'jpeg',
        quality,
        animations: 'disabled',
        caret: 'hide'
      });

      cachedFrame = {
        buffer,
        mimeType: FRAME_MIME_TYPE
      };
      onFrame?.(cachedFrame);
      return cachedFrame;
    };

    const processRenderQueue = () => {
      if (disposed || renderInFlight || pendingRenderQuality === null) {
        return renderInFlight;
      }

      const quality = pendingRenderQuality;
      pendingRenderQuality = null;

      renderInFlight = renderFrame(quality)
        .catch((error) => {
          onError?.(error);
          return cachedFrame;
        })
        .finally(() => {
          renderInFlight = null;
          if (pendingRenderQuality !== null) {
            processRenderQueue();
          }
        });

      return renderInFlight;
    };

    const queueRender = (quality) => {
      if (disposed) return renderInFlight;
      pendingRenderQuality = Math.max(pendingRenderQuality || 0, quality);
      return processRenderQueue();
    };

    const scheduleInteractiveRender = () => {
      if (disposed) return;
      if (interactiveRenderTimer) {
        clearTimeout(interactiveRenderTimer);
      }
      interactiveRenderTimer = setTimeout(() => {
        interactiveRenderTimer = null;
        queueRender(INTERACTIVE_JPEG_QUALITY);
      }, INTERACTIVE_RENDER_DELAY_MS);
    };

    const scheduleIdleRender = () => {
      if (disposed) return;
      if (idleRenderTimer) {
        clearTimeout(idleRenderTimer);
      }
      idleRenderTimer = setTimeout(() => {
        idleRenderTimer = null;
        queueRender(IDLE_JPEG_QUALITY);
      }, IDLE_RENDER_DELAY_MS);
    };

    page.on('framenavigated', async (frame) => {
      if (frame !== page.mainFrame()) return;
      try {
        await emitNavigation(frame.url());
      } catch (error) {
        onError?.(error);
      }
    });

    page.on('domcontentloaded', () => {
      scheduleInteractiveRender();
      scheduleIdleRender();
    });

    page.on('load', () => {
      onLoadingChange?.(false);
      scheduleIdleRender();
    });

    page.on('pageerror', (error) => {
      onError?.(error);
    });

    page.on('requestfailed', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        onLoadingChange?.(false);
        onError?.(request.failure()?.errorText || 'Navigatieverzoek mislukt.');
      }
    });

    page.on('popup', (popup) => {
      popup.close().catch(() => {});
    });

    const navigateHome = async () => {
      onLoadingChange?.(true);
      await page.goto(encodeHomeDocument(sessionId, ++homeVisitId), {
        waitUntil: 'domcontentloaded'
      });
      scheduleInteractiveRender();
      scheduleIdleRender();
    };

    const navigate = async (url) => {
      onLoadingChange?.(true);
      await page.goto(url, {
        waitUntil: 'domcontentloaded'
      });
      scheduleInteractiveRender();
      scheduleIdleRender();
    };

    const stepHistory = async (direction) => {
      onLoadingChange?.(true);
      const result = direction === 'back'
        ? await page.goBack({ waitUntil: 'domcontentloaded' })
        : await page.goForward({ waitUntil: 'domcontentloaded' });

      if (!result) {
        onLoadingChange?.(false);
        await emitNavigation();
      }

      scheduleInteractiveRender();
      scheduleIdleRender();
    };

    return {
      navigateHome,
      navigate,
      goBack: async () => stepHistory('back'),
      goForward: async () => stepHistory('forward'),
      reload: async () => {
        onLoadingChange?.(true);
        await page.reload({ waitUntil: 'domcontentloaded' });
        scheduleInteractiveRender();
        scheduleIdleRender();
      },
      stop: async () => {
        await page.evaluate(() => window.stop()).catch(() => {});
        onLoadingChange?.(false);
        scheduleIdleRender();
      },
      handleInput: async (payload = {}) => {
        switch (payload.type) {
          case 'resize':
            if (payload.viewportWidth && payload.viewportHeight) {
              await page.setViewportSize({
                width: payload.viewportWidth,
                height: payload.viewportHeight
              });
              scheduleInteractiveRender();
              scheduleIdleRender();
            }
            return;
          case 'move':
            await page.mouse.move(payload.x || 0, payload.y || 0);
            return;
          case 'click':
            await page.mouse.click(payload.x || 0, payload.y || 0, {
              button: payload.button || 'left',
              clickCount: 1
            });
            scheduleInteractiveRender();
            scheduleIdleRender();
            return;
          case 'dblclick':
            await page.mouse.click(payload.x || 0, payload.y || 0, {
              button: payload.button || 'left',
              clickCount: 2
            });
            scheduleInteractiveRender();
            scheduleIdleRender();
            return;
          case 'wheel':
            await page.mouse.wheel(payload.deltaX || 0, payload.deltaY || 0);
            scheduleInteractiveRender();
            scheduleIdleRender();
            return;
          case 'keydown':
            await page.keyboard.press(payload.key);
            scheduleInteractiveRender();
            scheduleIdleRender();
            return;
          case 'keyup':
            await page.keyboard.up(payload.key);
            return;
          case 'type':
            await page.keyboard.insertText(payload.text || '');
            scheduleInteractiveRender();
            scheduleIdleRender();
            return;
          case 'focus':
            await page.bringToFront().catch(() => {});
            return;
          default:
            return;
        }
      },
      ensureFrame: async () => {
        clearRenderTimers();
        if (!cachedFrame && !renderInFlight) {
          return renderFrame(IDLE_JPEG_QUALITY);
        }
        if (renderInFlight) {
          await renderInFlight;
        }
        return cachedFrame;
      },
      getFrame: async () => cachedFrame,
      dispose: async () => {
        disposed = true;
        clearRenderTimers();
        pendingRenderQuality = null;
        await context.close();
      }
    };
  };

  return {
    createSession,
    dispose: async () => {
      if (!browserPromise) return;
      const browser = await browserPromise.catch(() => null);
      browserPromise = null;
      if (browser) {
        await browser.close();
      }
    }
  };
}

module.exports = {
  createPlaywrightBrowserEngine
};
