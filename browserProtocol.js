const CLIENT_BINARY_OPCODE = {
  MOVE: 0x01,
  WHEEL: 0x02,
  CLICK: 0x03,
  DBLCLICK: 0x04
};

const SERVER_BINARY_OPCODE = {
  FRAME: 0x20
};

const FRAME_MIME_CODE = {
  JPEG: 0x01
};

function createProtocolError(message) {
  const error = new Error(message);
  error.code = 'BROWSER_PROTOCOL_ERROR';
  return error;
}

function normalizeBinaryPayload(data) {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  throw createProtocolError('Unsupported browser binary payload.');
}

function mapButtonCode(button) {
  if (button === 0) return 'left';
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  throw createProtocolError(`Unknown browser mouse button: ${button}`);
}

function decodeInputPacket(data) {
  const buffer = normalizeBinaryPayload(data);
  if (buffer.length < 3) {
    throw createProtocolError('Browser input packet is too short.');
  }

  const opcode = buffer.readUInt8(0);
  const payloadLength = buffer.readUInt16LE(1);
  const expectedTotalLength = payloadLength + 3;

  if (buffer.length !== expectedTotalLength) {
    throw createProtocolError('Browser input packet length mismatch.');
  }

  if (opcode === CLIENT_BINARY_OPCODE.MOVE) {
    if (payloadLength !== 4) {
      throw createProtocolError('MOVE packet has an invalid payload length.');
    }

    return {
      type: 'move',
      x: buffer.readUInt16LE(3),
      y: buffer.readUInt16LE(5)
    };
  }

  if (opcode === CLIENT_BINARY_OPCODE.WHEEL) {
    if (payloadLength !== 4) {
      throw createProtocolError('WHEEL packet has an invalid payload length.');
    }

    return {
      type: 'wheel',
      deltaX: buffer.readInt16LE(3),
      deltaY: buffer.readInt16LE(5)
    };
  }

  if (opcode === CLIENT_BINARY_OPCODE.CLICK || opcode === CLIENT_BINARY_OPCODE.DBLCLICK) {
    if (payloadLength !== 5) {
      throw createProtocolError('CLICK packet has an invalid payload length.');
    }

    return {
      type: opcode === CLIENT_BINARY_OPCODE.CLICK ? 'click' : 'dblclick',
      x: buffer.readUInt16LE(3),
      y: buffer.readUInt16LE(5),
      button: mapButtonCode(buffer.readUInt8(7))
    };
  }

  throw createProtocolError(`Unknown browser input opcode: ${opcode}`);
}

function encodeFramePacket(frame) {
  const mimeCode = frame?.frameMimeType === 'image/jpeg' ? FRAME_MIME_CODE.JPEG : null;
  if (!frame?.buffer || mimeCode === null) {
    throw createProtocolError('Unsupported browser frame payload.');
  }

  const header = Buffer.allocUnsafe(6);
  header.writeUInt8(SERVER_BINARY_OPCODE.FRAME, 0);
  header.writeUInt32LE(frame.frameVersion >>> 0, 1);
  header.writeUInt8(mimeCode, 5);
  return Buffer.concat([header, frame.buffer]);
}

module.exports = {
  CLIENT_BINARY_OPCODE,
  SERVER_BINARY_OPCODE,
  FRAME_MIME_CODE,
  createProtocolError,
  decodeInputPacket,
  encodeFramePacket
};
