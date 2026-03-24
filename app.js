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
