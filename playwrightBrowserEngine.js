const { BROWSER_HOME_URL } = require('./browserService');

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
    onError
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

    page.on('framenavigated', async (frame) => {
      if (frame !== page.mainFrame()) return;
      try {
        await emitNavigation(frame.url());
      } catch (error) {
        onError?.(error);
      }
    });

    page.on('load', () => {
      onLoadingChange?.(false);
    });

    page.on('pageerror', (error) => {
      onError?.(error);
    });

    page.on('requestfailed', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        onError?.(request.failure()?.errorText || 'Navigatieverzoek mislukt.');
      }
    });

    page.on('popup', (popup) => {
      popup.close().catch(() => {});
    });

    const navigateHome = async () => {
      onLoadingChange?.(true);
      await page.goto(encodeHomeDocument(sessionId, ++homeVisitId), {
        waitUntil: 'load'
      });
    };

    const navigate = async (url) => {
      onLoadingChange?.(true);
      await page.goto(url, {
        waitUntil: 'load'
      });
    };

    const stepHistory = async (direction) => {
      onLoadingChange?.(true);
      const result = direction === 'back'
        ? await page.goBack({ waitUntil: 'load' })
        : await page.goForward({ waitUntil: 'load' });

      if (!result) {
        onLoadingChange?.(false);
        await emitNavigation();
      }
    };

    return {
      navigateHome,
      navigate,
      goBack: async () => stepHistory('back'),
      goForward: async () => stepHistory('forward'),
      reload: async () => {
        onLoadingChange?.(true);
        await page.reload({ waitUntil: 'load' });
      },
      stop: async () => {
        await page.evaluate(() => window.stop()).catch(() => {});
        onLoadingChange?.(false);
      },
      handleInput: async (payload = {}) => {
        switch (payload.type) {
          case 'resize':
            if (payload.viewportWidth && payload.viewportHeight) {
              await page.setViewportSize({
                width: payload.viewportWidth,
                height: payload.viewportHeight
              });
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
            return;
          case 'dblclick':
            await page.mouse.click(payload.x || 0, payload.y || 0, {
              button: payload.button || 'left',
              clickCount: 2
            });
            return;
          case 'wheel':
            await page.mouse.wheel(payload.deltaX || 0, payload.deltaY || 0);
            return;
          case 'keydown':
            await page.keyboard.press(payload.key);
            return;
          case 'keyup':
            await page.keyboard.up(payload.key);
            return;
          case 'type':
            await page.keyboard.type(payload.text || '');
            return;
          case 'focus':
            await page.bringToFront().catch(() => {});
            return;
          default:
            return;
        }
      },
      getFrame: async () => page.screenshot({
        type: 'png'
      }),
      dispose: async () => {
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
