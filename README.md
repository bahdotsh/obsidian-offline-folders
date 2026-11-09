# Offline Folders

Share an Obsidian folder with other devices. Edit together live, keep editing
offline, and merge on reconnect with no conflict copies. Every byte is
end-to-end encrypted with MLS (RFC 9420) and goes device to device. There is
no server.

**Removing someone actually cuts them off.** The other devices move to new
keys on the spot, and the removed device never gets them. The device keeps
what it already had, and nothing written afterwards can reach it.

Offline Folders is a showcase for the
[Offline Protocol SDK](https://github.com/Offline-Protocol/offline-protocol-sdk).
The SDK supplies identity, sessions, groups, encryption, links and storage.
This plugin is about 1,800 lines of TypeScript and CSS on top.

## What you see

| | |
|---|---|
| **Share** | Right-click a folder, choose *Share with Offline Folders*, and you get an invite code. |
| **Join** | On the other device, run *Join with a code*. The owner sees the device's identity and approves it. |
| **Co-edit** | Open the same note on both devices. Edits and cursors appear live. |
| **Go offline** | Edit on both sides while disconnected. On reconnect each note merges, with no "conflict" files. |
| **Remove** | Click remove next to a member. The key epoch goes up on every remaining device. The removed device's panel shows *Access revoked* and *Folder keys held by this device: none*, read from its own engine. |
| **What the network sees** | The panel shows the line you just typed next to the frames that actually crossed the network: ciphertext. |

## How it works

```
Obsidian window (one per vault)                 dedicated worker
 ┌────────────────────────────────────┐          ┌──────────────────────────────┐
 │ editor ── yCollab ── Y.Doc per     │ group    │ Offline Protocol engine       │
 │ vault files ◄──────► shared folder │ messages │ (Rust → wasm)                 │
 │ side panel                         │◄────────►│ identity, MLS groups, OPFS    │
 │ WebRTC carrier ◄── Nostr room code │  frames  │ storage, same-machine links   │
 └────────────────────────────────────┘          └──────────────────────────────┘
```

- **A shared folder is an MLS group.** Its edits are
  [Yjs](https://yjs.dev) updates sent as group messages, so only current
  members can decrypt them. Cursors go as ephemeral group messages: sent
  once and never retried.
- **Inviting a device adds it to the group, and removing one is an MLS
  commit.** The engine sends the commit to the remaining members and a
  removal notice to the removed one. The removed device's engine leaves the
  group and deletes its keys.
- **Devices find each other by room code.** Each device hosts one Nostr room.
  Public relays carry only the sealed WebRTC handshake, never a note. After
  that, frames go device to device. Members exchange room codes inside the
  encrypted group, so every member links to every other, and a folder keeps
  syncing when its owner is away.
- **Windows on the same machine link with no network at all**, over a
  BroadcastChannel inside the engine.
- **Catch-up is by state vector.** When two members link, each says what it
  has and the other sends what is missing. Sends to an unreachable member
  wait in the engine's outbox. An edit made while the plugin was off is
  diffed in from disk at the next start.

The code reads in this order: [`src/main.ts`](src/main.ts) (the events),
[`src/folder.ts`](src/folder.ts) (document and disk),
[`src/editor.ts`](src/editor.ts), [`src/mesh.ts`](src/mesh.ts) and
[`src/engine.ts`](src/engine.ts).

## Build

You need an SDK checkout whose web module is built, and that includes
`OfflineNode.removeFromGroup` (branch `feat/web-remove-member`):

```bash
# In the SDK (needs the wasm32-unknown-unknown target and wasm-bindgen-cli 0.2.105)
bash bindings/web/scripts/build.sh

# Here
npm install
OFFLINE_SDK=/path/to/offline-protocol-sdk npm run build   # default: ../sdk-web-remove-member
npm run install-plugin -- "/path/to/Vault A" "/path/to/Vault B"
```

`npm run typecheck` resolves the SDK's types through the `sdk-path` link that
the build creates, so build once before type checking a fresh clone.

Then enable *Offline Folders* under Settings → Community plugins in each
vault. `dist/` holds `main.js`, `manifest.json`, `styles.css` and
`engine.wasm` (the engine, 6.7 MB, read at start).

To try it on one machine, open two vaults in Obsidian. They link to each
other straight away. To try the network path, use a second machine, or
start a second Obsidian with its own profile so it shares no storage with
the first:

```bash
/Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir=/tmp/obsidian-second
```

## Limits

This is a showcase, not a product.

- **Text notes only** (`.md`, `.txt`, `.canvas`, `.csv`). Images and other
  attachments are not synced.
- **Two devices that create the same new file while apart:** one copy wins.
  Edits to an existing note always merge.
- **A rename** syncs as a delete plus a create.
- **A note deleted while Obsidian is closed comes back** from the other
  devices at the next start. Delete notes with Obsidian open. A missing
  file is not taken as a deletion on purpose: a whole folder renamed while
  Obsidian was closed would otherwise delete every note on every device.
- **Removal can't take back what was already shared.** It stops everything
  after the removal. The removed device keeps its copy as ordinary files.
- **Only the owner can invite and remove**, and the engine enforces it.
- **Tested on macOS and Android.** The whole flow (share, join, live
  co-editing, offline merge, removal) has been run between a Mac and an
  Android 16 phone on the same Wi-Fi. iOS has not been tried. On a phone,
  syncing only happens while Obsidian is open: Android suspends it in the
  background, and it catches up when reopened.
- **Devices link over the same local network.** The carrier is started with
  no STUN or TURN servers, so WebRTC offers only local addresses. Linking
  across networks needs those servers passed to `WebRtcCarrier` (`iceServers`
  in `src/mesh.ts`). Finding each other by room code still needs the
  internet, because the Nostr relays are public servers. Two windows on one
  machine need neither.
