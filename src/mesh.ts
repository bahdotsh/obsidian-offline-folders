// Links between devices. Each device hosts one Nostr room (its own code) and
// joins the rooms of the members it shares folders with, so the devices of a
// folder form a full mesh and keep syncing when the owner is away.
//
// Two windows on the same machine also link over a BroadcastChannel inside
// the engine, with no network at all.

import { NostrSignaller, OfflineNode, RELAYS, WebRtcCarrier } from "./engine";

const JOIN_TIMEOUT_MS = 20_000;
const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

export type RelayState = "connecting" | "listening" | "unreachable";

export class Mesh {
  readonly rtc: WebRtcCarrier;
  readonly signaller: NostrSignaller;
  readonly linked = new Set<string>();
  relay: RelayState = "connecting";

  #node: OfflineNode;
  #room: string;
  #hosted: { close(): void } | null = null;
  #hostRetry: number | null = null;
  #joining = new Set<string>();
  #nextTry = new Map<string, { at: number; delay: number }>();
  #closed = false;
  #onChange: () => void;

  constructor(node: OfflineNode, room: string, onChange: () => void) {
    this.#node = node;
    this.#room = room;
    this.#onChange = onChange;
    this.rtc = new WebRtcCarrier(node);
    this.signaller = new NostrSignaller(node, { relays: RELAYS });
  }

  /** Answers every device that joins this device's room. */
  async host() {
    if (this.#closed) return;
    try {
      this.#hosted = await this.signaller.host(this.#room, this.rtc);
      this.relay = "listening";
    } catch {
      // No relay reachable (offline, say). Same-machine links still work;
      // try again later.
      this.relay = "unreachable";
      this.#hostRetry = window.setTimeout(() => this.host(), 30_000);
    }
    this.#onChange();
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
