const Gun = require('gun');
const { createApp } = require('./app');
const { attachBrowserSocket } = require('./browserSocket');

async function startServer({ port = Number(process.env.PORT) || 5050 } = {}) {
  const { app, browserService } = createApp();

  const server = app.listen(port, () => {
    console.log(`Gun server running on port ${port}`);
  });
  const browserSocket = attachBrowserSocket(null, {
    browserService,
    noServer: true
  });

  const gun = Gun({
    web: server,
    ws: {
      noServer: true,
      path: '/gun'
    }
  });
  const gunSocketServer = gun?._?.root?.opt?.ws?.web;

  server.prependListener('upgrade', (req, socket, head) => {
    if (browserSocket.handleUpgrade(req, socket, head)) {
      return;
    }

    if (gunSocketServer?.shouldHandle?.(req)) {
      gunSocketServer.handleUpgrade(req, socket, head, (client) => {
        gunSocketServer.emit('connection', client, req);
      });
    }
  });

  const originalClose = server.close.bind(server);
  server.close = (callback) => originalClose(async (error) => {
    await browserSocket.close().catch(() => {});
    await browserService.dispose().catch(() => {});
    if (typeof callback === 'function') {
      callback(error);
    }
  });

  return {
    app,
    server,
    browserService,
    browserSocket
  };
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  startServer
};
