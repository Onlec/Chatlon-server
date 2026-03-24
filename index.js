const Gun = require('gun');
const { createApp } = require('./app');

async function startServer({ port = Number(process.env.PORT) || 5050 } = {}) {
  const { app, browserService } = createApp();

  const server = app.listen(port, () => {
    console.log(`Gun server running on port ${port}`);
  });

  Gun({ web: server });

  const originalClose = server.close.bind(server);
  server.close = (callback) => originalClose(async (error) => {
    await browserService.dispose().catch(() => {});
    if (typeof callback === 'function') {
      callback(error);
    }
  });

  return {
    app,
    server,
    browserService
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
