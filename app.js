const express = require('express');
const Gun = require('gun');
const { createBrowserService } = require('./browserService');
const { createPlaywrightBrowserEngine } = require('./playwrightBrowserEngine');

function createApp({
  browserService = createBrowserService({
    engine: createPlaywrightBrowserEngine()
  }),
  includeGun = true
} = {}) {
  const app = express();

  app.use((req, res, next) => {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }

    next();
  });

  app.use(express.json({ limit: '1mb' }));

  if (includeGun) {
    app.use(Gun.serve);
  }

  app.post('/browser/session', async (req, res, next) => {
    try {
      const state = await browserService.ensureSession(req.body || {});
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.get('/browser/state/:sessionId', async (req, res, next) => {
    try {
      const state = await browserService.getState(req.params.sessionId);
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.get('/browser/frame/:sessionId', async (req, res, next) => {
    try {
      const frame = await browserService.getFrame(req.params.sessionId);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.send(frame);
    } catch (error) {
      next(error);
    }
  });

  app.post('/browser/navigate', async (req, res, next) => {
    try {
      const { sessionId, url } = req.body || {};
      const state = await browserService.navigate(sessionId, url);
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post('/browser/back', async (req, res, next) => {
    try {
      const state = await browserService.goBack((req.body || {}).sessionId);
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post('/browser/forward', async (req, res, next) => {
    try {
      const state = await browserService.goForward((req.body || {}).sessionId);
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post('/browser/reload', async (req, res, next) => {
    try {
      const state = await browserService.reload((req.body || {}).sessionId);
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post('/browser/home', async (req, res, next) => {
    try {
      const state = await browserService.goHome((req.body || {}).sessionId);
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post('/browser/stop', async (req, res, next) => {
    try {
      const state = await browserService.stop((req.body || {}).sessionId);
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post('/browser/input', async (req, res, next) => {
    try {
      const { sessionId, ...payload } = req.body || {};
      const state = await browserService.handleInput(sessionId, payload);
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, next) => {
    const statusCode = error?.statusCode || 500;
    res.status(statusCode).json({
      error: error?.message || 'Onverwachte browserserverfout.'
    });
  });

  return {
    app,
    browserService
  };
}

module.exports = {
  createApp
};
