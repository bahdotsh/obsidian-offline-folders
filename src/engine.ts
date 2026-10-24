// Starts the Offline Protocol node for this vault.
//
// The SDK's engine runs in a module worker. Obsidian serves plugin files from
// another origin than the app's own, so the worker is started from a Blob URL
// (same origin as the app, which is what OPFS storage and the tab carrier
// need) and the engine module is read from the plugin folder and handed over.

import { OfflineNode, WebRtcCarrier, NostrSignaller } from "@offline-protocol/web";
import workerSource from "engine-worker";

export { OfflineNode, WebRtcCarrier, NostrSignaller };

/** Scopes traffic, storage and the same-machine channel to this plugin. */
export const APP_ID = "obsidian-offline-folders";

/**
 * Public Nostr relays carry only the WebRTC handshake, sealed to the room
 * code. Notes never touch them: once two devices are linked, every byte goes
 * device to device.
 */
export const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

/** A frame seen on a WebRTC link: what the network actually carries. */
export interface WireFrame {
  dir: "out" | "in";
  length: number;
  head: Uint8Array;
  at: number;
}

export async function startNode(
  profile: string,
  wasm: ArrayBuffer,
  onFrame: (frame: WireFrame) => void,
): Promise<OfflineNode> {
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  try {
    const node = await OfflineNode.start({ appId: APP_ID, profile, workerUrl, wasm });
    tapFrames(node, onFrame);
    return node;
  } finally {
    URL.revokeObjectURL(workerUrl);
  }
}

// Every carrier the page owns (WebRTC) passes its bytes through these two
// calls, so a copy of each frame's first bytes is what the wire view shows.
// Links between windows on the same machine run inside the worker and are
// not seen here.
function tapFrames(node: OfflineNode, onFrame: (frame: WireFrame) => void) {
  const seen = (dir: "out" | "in", bytes: Uint8Array) =>
    onFrame({ dir, length: bytes.length, head: bytes.slice(0, 48), at: Date.now() });
  const openLink = node.openLink.bind(node);
  node.openLink = (carrier) =>
    openLink({
      send: (bytes) => {
        seen("out", bytes);
        carrier.send(bytes);
      },
      close: () => carrier.close(),
    });
  const linkReceived = node.linkReceived.bind(node);
  node.linkReceived = (link, bytes) => {
    seen("in", bytes);
    return linkReceived(link, bytes);
  };
}
