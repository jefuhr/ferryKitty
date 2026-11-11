// startFakeAisServer({ onSubscribe }) listens only on 127.0.0.1:0 and returns
// { url, connections, send(message), sendRaw(bytesOrString), close() }. send
// serializes JSON as a text frame; sendRaw sends strings as text and bytes as
// binary. Both broadcast to live clients. Each connection exposes frames
// [{ text, masked }], send, sendRaw, drop(), and silent() (suppress outbound
// frames). onSubscribe receives decoded client JSON and its connection. close
// destroys all clients and awaits HTTP shutdown; tests must always call it.
import http from "node:http";
import { createHash } from "node:crypto";

function frame(payload, opcode) {
  const bytes = Buffer.from(payload);
  const extra = bytes.length < 126 ? 0 : bytes.length <= 65535 ? 2 : 8;
  const header = Buffer.alloc(2 + extra);
  header[0] = 0x80 | opcode;
  header[1] = extra === 0 ? bytes.length : extra === 2 ? 126 : 127;
  if (extra === 2) header.writeUInt16BE(bytes.length, 2);
  if (extra === 8) header.writeBigUInt64BE(BigInt(bytes.length), 2);
  return Buffer.concat([header, bytes]);
}

export async function startFakeAisServer({ onSubscribe = () => {} } = {}) {
  const connections = [];
  const sockets = new Set();
  const server = http.createServer((_request, response) => { response.writeHead(426); response.end(); });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.headers.upgrade?.toLowerCase() !== "websocket" || !request.headers["sec-websocket-key"]) {
      socket.destroy(); return;
    }
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let silent = false, pending = Buffer.alloc(0), fragments = [], fragmentOpcode = null;
    const connection = {
      frames: [],
      send(message) { this.sendRaw(JSON.stringify(message)); },
      sendRaw(data) {
        if (silent || socket.destroyed) return;
        const payload = typeof data === "string" ? Buffer.from(data) : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        socket.write(frame(payload, typeof data === "string" ? 1 : 2));
      },
      drop() { socket.destroy(); },
      silent(value = true) { silent = value; },
      get closed() { return socket.destroyed; }
    };
    connections.push(connection);
    function consume(chunk) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const opcode = pending[0] & 15, final = Boolean(pending[0] & 0x80), masked = Boolean(pending[1] & 0x80);
        let length = pending[1] & 127, offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2); offset = 4;
        } else if (length === 127) {
          if (pending.length < 10) return;
          const wide = pending.readBigUInt64BE(2);
          if (wide > 1048576n) { socket.destroy(); return; }
          length = Number(wide); offset = 10;
        }
        if (length > 1048576) { socket.destroy(); return; }
        if (pending.length < offset + (masked ? 4 : 0) + length) return;
        const mask = masked ? pending.subarray(offset, offset + 4) : null;
        if (masked) offset += 4;
        const payload = Buffer.from(pending.subarray(offset, offset + length));
        pending = pending.subarray(offset + length);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (!masked) { socket.destroy(); return; }
        if (opcode === 8) { socket.end(frame(payload, 8)); return; }
        if (opcode === 9) { if (!silent) socket.write(frame(payload, 10)); continue; }
        if (opcode === 10) continue;
        if (opcode === 1 || opcode === 2) { fragments = []; fragmentOpcode = opcode; }
        else if (opcode !== 0 || fragmentOpcode === null) { socket.destroy(); return; }
        fragments.push(payload);
        if (!final) continue;
        const complete = Buffer.concat(fragments);
        if (fragmentOpcode === 1) {
          const text = complete.toString("utf8");
          connection.frames.push({ text, masked });
          let subscription;
          try { subscription = JSON.parse(text); } catch { subscription = null; }
          if (subscription !== null) onSubscribe(subscription, connection);
        }
        fragments = []; fragmentOpcode = null;
      }
    }
    socket.on("data", consume);
    if (head.length) consume(head);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  let closing;
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    connections,
    send(message) { for (const connection of connections) connection.send(message); },
    sendRaw(data) { for (const connection of connections) connection.sendRaw(data); },
    close() {
      closing ??= new Promise((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => error ? reject(error) : resolve());
      });
      return closing;
    }
  };
}
