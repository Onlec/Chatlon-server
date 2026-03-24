const WebSocket = require('ws');
const { decodeInputPacket, encodeFramePacket } = require('./browserProtocol');

function createSocketMessage(type, payload = {}, requestId) {
  const message = { type, payload };
  if (requestId) {
    message.requestId = requestId;
  }
  return JSON.stringify(message);
}

function attachBrowserSocket(server, { browserService, path = '/browser/socket', noServer = false } = {}) {
  if (!server && !noServer) {
    throw new Error('attachBrowserSocket requires an HTTP server.');
  }
  if (!browserService) {
    throw new Error('attachBrowserSocket requires a browserService instance.');
  }

  const socketServer = noServer
    ? new WebSocket.Server({ noServer: true, path })
    : new WebSocket.Server({ server, path });

  socketServer.on('connection', (socket) => {
    let disposed = false;
    let currentSessionId = null;
    let stateSubscription = null;
    let frameSubscription = null;

    const unsubscribe = () => {
      stateSubscription?.unsubscribe?.();
      frameSubscription?.unsubscribe?.();
      stateSubscription = null;
      frameSubscription = null;
    };

    const sendText = (type, payload = {}, requestId) => {
      if (disposed || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send(createSocketMessage(type, payload, requestId));
    };

    const sendError = (error, requestId) => {
      sendText('browser.error', {
        code: error?.code || 'BROWSER_SOCKET_ERROR',
        message: error?.message || 'Onverwachte browsersocketfout.',
        recoverable: true
      }, requestId);
    };

    const sendFrame = (frame) => {
      if (disposed || socket.readyState !== WebSocket.OPEN || !frame?.buffer) {
        return;
      }

      socket.send(encodeFramePacket(frame), { binary: true });
    };

    const bindSession = (sessionId) => {
      unsubscribe();
      currentSessionId = sessionId;
      stateSubscription = browserService.subscribeState(sessionId, (state) => {
        sendText('browser.state', state);
      });
      frameSubscription = browserService.subscribeFrames(sessionId, (frame) => {
        sendFrame(frame);
      });
      return {
        state: stateSubscription.state,
        frame: frameSubscription.frame
      };
    };

    const requireSession = () => {
      if (!currentSessionId) {
        const error = new Error('Browsersessie nog niet geïnitialiseerd.');
        error.code = 'BROWSER_SESSION_REQUIRED';
        throw error;
      }

      return currentSessionId;
    };

    const handleTextMessage = async (message) => {
      const { requestId, type, payload = {} } = message || {};

      if (type === 'session.ensure') {
        const state = await browserService.ensureSession(payload);
        const snapshot = bindSession(state.sessionId);
        sendText('session.ready', { state: snapshot.state }, requestId);
        if (snapshot.frame) {
          sendFrame(snapshot.frame);
        }
        return;
      }

      if (type === 'browser.command') {
        const sessionId = requireSession();

        switch (payload.action) {
          case 'navigate':
            await browserService.navigate(sessionId, payload.url);
            return;
          case 'back':
            await browserService.goBack(sessionId);
            return;
          case 'forward':
            await browserService.goForward(sessionId);
            return;
          case 'reload':
            await browserService.reload(sessionId);
            return;
          case 'home':
            await browserService.goHome(sessionId);
            return;
          case 'stop':
            await browserService.stop(sessionId);
            return;
          default: {
            const error = new Error(`Onbekende browseractie: ${payload.action}`);
            error.code = 'BROWSER_COMMAND_INVALID';
            throw error;
          }
        }
      }

      if (type === 'browser.input.resize') {
        await browserService.handleInput(requireSession(), {
          type: 'resize',
          viewportWidth: payload.viewportWidth,
          viewportHeight: payload.viewportHeight
        });
        return;
      }

      if (type === 'browser.input.focus') {
        await browserService.handleInput(requireSession(), { type: 'focus' });
        return;
      }

      if (type === 'browser.input.key') {
        await browserService.handleInput(requireSession(), {
          type: payload.action === 'up' ? 'keyup' : 'keydown',
          key: payload.key
        });
        return;
      }

      if (type === 'browser.input.text') {
        await browserService.handleInput(requireSession(), {
          type: 'type',
          text: payload.text || ''
        });
        return;
      }

      if (type === 'browser.input.paste') {
        await browserService.handleInput(requireSession(), {
          type: 'paste',
          text: payload.text || ''
        });
        return;
      }

      const error = new Error(`Onbekend browserbericht: ${type}`);
      error.code = 'BROWSER_MESSAGE_INVALID';
      throw error;
    };

    socket.on('message', async (data) => {
      const isTextMessage = typeof data === 'string';

      try {
        if (!isTextMessage) {
          const decoded = decodeInputPacket(data);
          await browserService.handleInput(requireSession(), decoded);
          return;
        }

        const message = JSON.parse(data);
        await handleTextMessage(message);
      } catch (error) {
        sendError(error, (() => {
          try {
            if (!isTextMessage) {
              return undefined;
            }
            const parsed = JSON.parse(data);
            return parsed.requestId;
          } catch {
            return undefined;
          }
        })());
      }
    });

    socket.on('error', () => {});

    socket.on('close', () => {
      disposed = true;
      unsubscribe();
      socket.removeAllListeners('message');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
    });
  });

  return {
    socketServer,
    handleUpgrade(req, socket, head) {
      if (!socketServer.shouldHandle(req)) {
        return false;
      }

      socketServer.handleUpgrade(req, socket, head, (client) => {
        socketServer.emit('connection', client, req);
      });
      return true;
    },
    close: () => new Promise((resolve) => {
      for (const client of socketServer.clients) {
        try {
          client.terminate();
        } catch {}
      }
      socketServer.close(() => resolve());
    })
  };
}

module.exports = {
  attachBrowserSocket
};
