// Links between devices. Each device hosts one Nostr room (its own code) and
// joins the rooms of the members it shares folders with, so the devices of a
// folder form a full mesh and keep syncing when the owner is away.
//
// Two windows on the same machine also link over a BroadcastChannel inside
// the engine, with no network at all.

import { NostrSignaller, OfflineNode, WebRtcCarrier } from "./engine";

const JOIN_TIMEOUT_MS = 20_000;
const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

export type RelayState = "connecting" | "listening" | "unreachable";

export class Mesh {
  readonly rtc: WebRtcCarrier;
  signaller: NostrSignaller;
  readonly linked = new Set<string>();
  relay: RelayState = "connecting";

  #node: OfflineNode;
  #room: string;
  #hosted: { close(): void } | null = null;
  #hostRetry: number | null = null;
  #hostRun = 0;
  #joining = new Set<string>();
  #nextTry = new Map<string, { at: number; delay: number }>();
  #closed = false;
  #onChange: () => void;

  // The SDK closes a connection left "disconnected" (an Android WebView can
  // leave one there for good), and keeps a hosted room's relay sockets open
  // across sleep and network changes, so neither needs help here.
  constructor(node: OfflineNode, room: string, relays: string[], onChange: () => void) {
    this.#node = node;
    this.#room = room;
    this.#onChange = onChange;
    this.rtc = new WebRtcCarrier(node);
    this.signaller = new NostrSignaller(node, { relays });
  }

  /**
   * Signals through `relays` from now on: the room is opened again on them,
   * and joins after this use them.
   */
  setRelays(relays: string[]) {
    if (this.#closed) return;
    this.signaller = new NostrSignaller(this.#node, { relays });
    this.#nextTry.clear();
    this.relay = "connecting";
    this.#onChange();
    void this.host();
  }

  /**
   * Answers every device that joins this device's room. Calling it again
   * replaces the room that is open.
   */
  async host() {
    if (this.#closed) return;
    const run = ++this.#hostRun;
    if (this.#hostRetry !== null) clearTimeout(this.#hostRetry);
    this.#hostRetry = null;
    this.#hosted?.close();
    this.#hosted = null;
    try {
      const hosted = await this.signaller.host(this.#room, this.rtc);
      if (run !== this.#hostRun || this.#closed) return hosted.close();
      this.#hosted = hosted;
      this.relay = "listening";
    } catch {
      if (run !== this.#hostRun || this.#closed) return;
      // No relay reachable when the room opened (offline, say). Once open,
      // the SDK keeps it open; until then, try again.
      this.relay = "unreachable";
      this.#hostRetry = window.setTimeout(() => void this.host(), 30_000);
    }
    this.#onChange();
  }

  /**
   * For a device that was asleep: its links died while it slept, and the
   * others dropped them. Closing them now lets it dial again at once, rather
   * than wait for each to time out.
   */
  dropLinks() {
    if (this.#closed) return;
    this.#nextTry.clear();
    this.rtc.close();
  }

  /**
   * Joins `room` unless a join is in flight or it failed recently. Failures
   * back off from five seconds to a minute.
   */
  async connect(room: string) {
    if (this.#closed || room === this.#room || this.#joining.has(room)) return;
    const next = this.#nextTry.get(room);
    if (next && Date.now() < next.at) return;
    this.#joining.add(room);
    this.#onChange();
    try {
      await this.signaller.join(room, this.rtc, { timeoutMs: JOIN_TIMEOUT_MS });
      this.#nextTry.delete(room);
    } catch {
      const delay = Math.min(MAX_RETRY_MS, (next?.delay ?? MIN_RETRY_MS / 2) * 2);
      this.#nextTry.set(room, { at: Date.now() + delay, delay });
    } finally {
      this.#joining.delete(room);
      this.#onChange();
    }
  }

  get joining(): number {
    return this.#joining.size;
  }

  close() {
    this.#closed = true;
    if (this.#hostRetry !== null) clearTimeout(this.#hostRetry);
    this.#hosted?.close();
    this.rtc.close();
  }
}
