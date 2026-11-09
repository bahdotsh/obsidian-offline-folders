// A Nostr relay inside desktop Obsidian, for a network with no internet.
//
// Devices find each other through a Nostr room: each link's two WebRTC
// connection codes cross a relay. With no internet the public relays are
// out of reach, so no new link could form. This computer can stand in: it
// listens on the local network, and the phones add its address to their
// relays.
//
// It is a forwarder and nothing else. It speaks the part of NIP-01 a room
// uses (REQ, EVENT, CLOSE), forwards only the SDK's signalling kind, stores
// nothing and verifies nothing: what crosses it is sealed to the room code
// and signed, and the SDK's worker refuses anything else. It is bounded, so
// another device on the network cannot make it hold memory without limit.
// Desktop only: it needs Node's http module, which mobile Obsidian has not.

import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import type { Buffer } from "node:buffer";

/** The ephemeral event kind the SDK's NostrSignaller publishes. */
const SIGNAL_KIND = 25912;
const MAX_CLIENTS = 64;
const MAX_SUBSCRIPTIONS = 8;
/** A connection code is under 2 KiB; a frame many times that is not a signal. */
const MAX_FRAME_BYTES = 64 * 1024;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Node's Buffer, loaded when the relay starts: the renderer need not have
// it as a global, and mobile never gets this far.
let NodeBuffer: typeof Buffer;

type Filter = { kinds?: number[]; since?: number; "#t"?: string[] };

function nodeRequire<T>(module: string): T {
  const require = (window as unknown as { require?: (m: string) => T }).require;
  if (!require) throw new Error("a local relay needs desktop Obsidian");
  return require(module);
}

function frame(text: string): Buffer {
  const payload = NodeBuffer.from(text);
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = NodeBuffer.from([0x81, length]);
  } else if (length < 65536) {
    header = NodeBuffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = NodeBuffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return NodeBuffer.concat([header, payload]);
}

function matches(filter: Filter, event: { kind?: number; created_at?: number; tags?: string[][] }) {
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind as number)) return false;
  if (typeof filter.since === "number" && (event.created_at ?? 0) < filter.since) return false;
  if (Array.isArray(filter["#t"])) {
    const topics = (event.tags ?? []).filter((t) => t[0] === "t").map((t) => t[1]);
    if (!filter["#t"].some((t) => topics.includes(t))) return false;
  }
  return true;
}

class Client {
  subscriptions = new Map<string, Filter[]>();
  #buffer = NodeBuffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;

  constructor(
    readonly socket: Socket,
    private relay: LocalRelay,
  ) {
    socket.on("data", (chunk: Buffer) => this.#read(chunk));
    socket.on("close", () => relay.forget(this));
    socket.on("error", () => relay.forget(this));
  }

  send(message: unknown) {
    if (!this.socket.destroyed) this.socket.write(frame(JSON.stringify(message)));
  }

  #read(chunk: Buffer) {
    this.#buffer = NodeBuffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#buffer.length < 2) return;
      const fin = (this.#buffer[0] & 0x80) !== 0;
      const opcode = this.#buffer[0] & 0x0f;
      const masked = (this.#buffer[1] & 0x80) !== 0;
      let length = this.#buffer[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        length = Number(this.#buffer.readBigUInt64BE(2));
        at = 10;
      }
      // A browser always masks, and nothing a room sends is this large.
      if (!masked || length > MAX_FRAME_BYTES) return this.socket.destroy();
      const maskAt = at;
      at += 4;
      if (this.#buffer.length < at + length) return;
      const payload = NodeBuffer.from(this.#buffer.subarray(at, at + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= this.#buffer[maskAt + (i % 4)];
      this.#buffer = this.#buffer.subarray(at + length);
      if (opcode === 0x8) {
        this.socket.end(NodeBuffer.from([0x88, 0]));
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(NodeBuffer.concat([NodeBuffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        this.#fragments.push(payload);
        this.#fragmentBytes += payload.length;
        if (this.#fragmentBytes > MAX_FRAME_BYTES) return this.socket.destroy();
        if (fin) {
          const text = NodeBuffer.concat(this.#fragments).toString("utf8");
          this.#fragments = [];
          this.#fragmentBytes = 0;
          this.#message(text);
        }
      }
    }
  }

  #message(text: string) {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return this.send(["NOTICE", "unreadable message"]);
    }
    if (!Array.isArray(message)) return;
    const [type, ...rest] = message;
    if (type === "REQ") {
      const [id, ...filters] = rest as [string, ...Filter[]];
      if (typeof id !== "string") return;
      if (!this.subscriptions.has(id) && this.subscriptions.size >= MAX_SUBSCRIPTIONS) {
        return this.send(["CLOSED", id, "error: too many subscriptions"]);
      }
      this.subscriptions.set(id, filters);
      this.send(["EOSE", id]);
    } else if (type === "CLOSE") {
      this.subscriptions.delete(rest[0] as string);
    } else if (type === "EVENT") {
      const event = rest[0] as { id?: string; kind?: number };
      if (event?.kind !== SIGNAL_KIND) {
        return this.send(["OK", event?.id ?? "", false, "blocked: this relay carries room signalling only"]);
      }
      this.send(["OK", event.id ?? "", true, ""]);
      this.relay.forward(event);
    }
  }
}

/** A relay on `port`, on every interface. */
export class LocalRelay {
  #server: Server;
  #clients = new Set<Client>();

  private constructor(server: Server) {
    this.#server = server;
  }

  static start(port: number): Promise<LocalRelay> {
    const http = nodeRequire<typeof import("node:http")>("http");
    const crypto = nodeRequire<typeof import("node:crypto")>("crypto");
    NodeBuffer = nodeRequire<typeof import("node:buffer")>("buffer").Buffer;
    const server = http.createServer((_, response) => response.writeHead(426).end());
    const relay = new LocalRelay(server);
    server.on("upgrade", (request: IncomingMessage, socket: Socket) => {
      const key = request.headers["sec-websocket-key"];
      if (!key || relay.#clients.size >= MAX_CLIENTS) return socket.destroy();
      const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      relay.#clients.add(new Client(socket, relay));
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => {
        server.off("error", reject);
        resolve(relay);
      });
    });
  }

  /** The addresses phones on this network can reach it at. */
  static lanUrls(port: number): string[] {
    try {
      const os = nodeRequire<typeof import("node:os")>("os");
      return Object.values(os.networkInterfaces())
        .flat()
        .filter((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))
        .map((i) => `ws://${i!.address}:${port}`);
    } catch {
      return [];
    }
  }

  forget(client: Client) {
    this.#clients.delete(client);
  }

  forward(event: { kind?: number; created_at?: number; tags?: string[][] }) {
    for (const client of this.#clients) {
      for (const [id, filters] of client.subscriptions) {
        if (filters.some((filter) => matches(filter, event))) client.send(["EVENT", id, event]);
      }
    }
  }

  close() {
    for (const client of this.#clients) client.socket.destroy();
    this.#clients.clear();
    this.#server.close();
  }
}
