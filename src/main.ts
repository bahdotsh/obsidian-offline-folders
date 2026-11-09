// Offline Folders: share an Obsidian folder with other devices, peer to
// peer, end-to-end encrypted, with no server.
//
// The pieces (each file says more):
// - engine.ts   the Offline Protocol node: identity, MLS sessions and groups,
//               WebRTC and same-machine links, durable storage.
// - mesh.ts     which devices to link to, through Nostr room codes.
// - folder.ts   a shared folder as a Yjs document mirrored to the vault.
// - editor.ts   open editors bound to the document, with live cursors.
// - view.ts     the side panel.
//
// A shared folder IS an MLS group. Its edits are group messages, so only
// current members can read them. Inviting a device adds it to the group;
// removing one moves everyone else to a new epoch whose keys it never gets.

import { Menu, Notice, Platform, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, WorkspaceLeaf, debounce, normalizePath } from "obsidian";
import * as Y from "yjs";
import { applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { OfflineNode, RELAYS, startNode, WireFrame } from "./engine";
import { Mesh } from "./mesh";
import { FolderHost, FolderRecord, REMOTE, SharedFolder } from "./folder";
import { collab, EditorBinder } from "./editor";
import { ApproveModal, InviteModal, JoinModal, RemoveModal } from "./modals";
import {
  b64,
  decode,
  DirectMessage,
  encode,
  FolderMessage,
  inviteCode,
  newTag,
  parseInvite,
  Reassembler,
  shortAddress,
  split,
  unb64,
} from "./protocol";
import { PanelActions, PanelFolder, PanelState, PanelView, VIEW_TYPE } from "./view";
import { LocalRelay } from "./relay";

interface Settings {
  deviceName: string;
  /** This vault's account on the node. Two vaults on one machine are two devices. */
  profile: string;
  /** This device's Nostr room: the first half of every invite code it gives. */
  room?: string;
  folders: Record<string, FolderRecord>;
  pendingJoins: { code: string; room: string; tag: string }[];
  /** Nostr relays that carry the sealed handshake when two devices link. */
  relays: string[];
  /** Desktop: run a relay on this computer, for a network with no internet. */
  localRelay: boolean;
  relayPort: number;
}

const RELAY_PORT = 4869;

type EngineEvent = { type: string; [field: string]: unknown };

const INVITE_RETRY_MS = 500;
const INVITE_ATTEMPTS = 120;
/** Away this long, the other devices have dropped this one (the SDK closes a link 15 s after it goes quiet). */
const ASLEEP_MS = 15_000;

export default class OfflineFoldersPlugin extends Plugin implements FolderHost, PanelActions {
  settings!: Settings;
  node: OfflineNode | null = null;
  mesh: Mesh | null = null;
  /** The relay this computer runs, when it runs one. */
  localRelay: LocalRelay | null = null;
  localRelayError: string | null = null;
  folders = new Map<string, SharedFolder>();
  binder!: EditorBinder;

  #status: PanelState["status"] = "starting";
  #error: string | undefined;
  #activity: PanelState["activity"] = [];
  #wire: WireFrame[] = [];
  #lastEdit: PanelState["lastEdit"] = null;
  #epochBumpedAt = new Map<string, number>();
  #asking = new Set<string>();
  #parts = new Reassembler();
  #tick: number | null = null;
  #unloading = false;

  get vault() {
    return this.app.vault;
  }

  // ---- lifecycle ----------------------------------------------------------

  async onload() {
    await this.loadSettings();
    this.binder = new EditorBinder(this.app.workspace, (path) => this.folderFor(path));
    this.registerEditorExtension(collab.of([]));
    this.registerView(VIEW_TYPE, (leaf) => new PanelView(leaf, this));
    this.addRibbonIcon("folder-lock", "Offline Folders", () => this.openPanel());
    this.addSettingTab(new SettingsTab(this));

    this.addCommand({ id: "open-panel", name: "Open the panel", callback: () => this.openPanel() });
    this.addCommand({ id: "join", name: "Join a shared folder with a code", callback: () => this.join() });
    this.addCommand({
      id: "share-current",
      name: "Share the current note's folder",
      checkCallback: (checking) => {
        const parent = this.app.workspace.getActiveFile()?.parent;
        if (!parent || parent.isRoot()) return false;
        if (!checking) void this.shareFolder(parent);
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFolder) || file.isRoot()) return;
        const shared = this.folderFor(file.path + "/x.md");
        if (shared && shared.record.path === file.path && shared.record.owner === this.address) {
          menu.addItem((item) => item.setTitle("Invite a device…").setIcon("user-plus").onClick(() => this.invite(shared.groupId)));
        } else if (!shared) {
          menu.addItem((item) => item.setTitle("Share with Offline Folders").setIcon("folder-lock").onClick(() => this.shareFolder(file)));
        }
      }),
    );

    this.app.workspace.onLayoutReady(() => void this.start());
  }

  async onunload() {
    this.#unloading = true;
    if (this.#tick !== null) clearInterval(this.#tick);
    this.binder.releaseAll();
    for (const folder of this.folders.values()) await folder.close();
    this.mesh?.close();
    this.localRelay?.close();
    await this.node?.stop().catch(() => {});
  }

  async start() {
    try {
      const wasm = await this.vault.adapter.readBinary(normalizePath(`${this.manifest.dir}/engine.wasm`));
      const node = await startNode(this.settings.profile, wasm, (frame) => this.#onFrame(frame));
      // Disabled while starting: a node left running would hold this
      // vault's storage lock, and the next start would wait for it forever.
      if (this.#unloading) {
        await node.stop().catch(() => {});
        return;
      }
      this.node = node;
    } catch (error) {
      this.#failed(error);
      return;
    }
    try {
      await this.#run(this.node);
    } catch (error) {
      // Either the node failed before it was running, or the plugin was
      // disabled while starting and its calls were rejected on purpose.
      if (!this.#unloading) this.#failed(error);
    }
  }

  #failed(error: unknown) {
    this.#status = "failed";
    this.#error = String((error as Error)?.message ?? error);
    new Notice(`Offline Folders could not start: ${this.#error}`);
    this.refreshPanel();
  }

  /** Everything after the node is up: the room, the mesh, the folders, the vault and editor events. */
  async #run(node: OfflineNode) {
    node.addEventListener("event", (e) => this.#onEvent((e as CustomEvent<EngineEvent>).detail));
    node.addEventListener("fatal", (e) => {
      this.#status = "failed";
      this.#error = String((e as CustomEvent).detail);
      this.refreshPanel();
    });
    this.settings.room ??= await node.newRoom();
    await this.saveSettings();

    await this.#startLocalRelay();
    this.mesh = new Mesh(node, this.settings.room, this.relays(), () => this.refreshPanel());
    void this.mesh.host();
    // A phone app sleeps in the background, and its links die with it (the
    // SDK reopens the room's relay sockets itself). Back after long enough
    // that the others dropped it: start the links over now, rather than wait
    // for each to time out.
    let hiddenAt: number | null = null;
    this.registerDomEvent(document, "visibilitychange", () => {
      if (!Platform.isMobile) return;
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (away < ASLEEP_MS) return;
      this.mesh?.dropLinks();
      window.setTimeout(() => this.#maintain(), 500);
    });

    const vaultFolderDir = normalizePath(`${this.manifest.dir}/state`);
    if (!(await this.vault.adapter.exists(vaultFolderDir))) await this.vault.adapter.mkdir(vaultFolderDir);
    for (const record of Object.values(this.settings.folders)) {
      if (record.removed) {
        // Shown in the panel as the engine reports it, not as remembered.
        record.removed.keysHeld = (await node.groupInfo(record.groupId).catch(() => null)) !== null;
        continue;
      }
      await this.#openFolder(record);
    }

    this.registerEvent(this.vault.on("modify", (f) => f instanceof TFile && void this.folderFor(f.path)?.ingest(f)));
    this.registerEvent(this.vault.on("create", (f) => f instanceof TFile && void this.folderFor(f.path)?.ingest(f)));
    this.registerEvent(this.vault.on("delete", (f) => this.folderFor(f.path)?.removed(f.path)));
    this.registerEvent(
      this.vault.on("rename", (f, oldPath) => {
        this.folderFor(oldPath)?.removed(oldPath);
        if (f instanceof TFile) void this.folderFor(f.path)?.ingest(f);
      }),
    );
    const rebind = debounce(() => {
      this.binder.refresh();
      this.refreshPanel();
    }, 50);
    this.registerEvent(this.app.workspace.on("file-open", rebind));
    this.registerEvent(this.app.workspace.on("layout-change", rebind));
    this.registerEvent(this.app.workspace.on("active-leaf-change", rebind));
    this.registerEvent(this.app.workspace.on("editor-change", (editor) => this.#noteEdit(editor.getCursor().line, editor)));

    this.#status = "running";
    this.binder.refresh();
    this.#tick = window.setInterval(() => this.#maintain(), 5000);
    this.#maintain();
    this.refreshPanel();
  }

  // ---- FolderHost ---------------------------------------------------------

  statePath(groupId: string) {
    return normalizePath(`${this.manifest.dir}/state/${groupId.replace(/[^a-zA-Z0-9-]/g, "_")}.ydoc`);
  }

  isBound(folder: SharedFolder, rel: string) {
    return this.binder.isBound(folder, rel);
  }

  send(folder: SharedFolder, update: Uint8Array) {
    this.#sendFolder(folder, { k: "update", u: b64(update) });
  }

  changed(folder: SharedFolder) {
    this.#log(`Synced changes in ${folder.record.name}`, "sync", true);
    this.refreshPanel();
  }

  // ---- sharing, joining, removing ----------------------------------------

  get address() {
    return this.node?.address ?? "";
  }

  folderFor(path: string): SharedFolder | null {
    for (const folder of this.folders.values()) if (folder.contains(path)) return folder;
    return null;
  }

  async shareFolder(folder: TFolder) {
    const node = this.node;
    if (!node) return new Notice("Offline Folders is still starting");
    if (this.folderFor(folder.path + "/x.md")) return new Notice("That folder is already shared");
    for (const f of this.folders.values()) {
      if (f.record.path.startsWith(folder.path + "/")) return new Notice(`It contains a shared folder already: ${f.record.path}`);
    }
    let info: { group_id: string };
    try {
      info = await node.createGroup(folder.name);
    } catch (error) {
      return new Notice(`Could not share ${folder.name}: ${(error as Error).message}`);
    }
    const record: FolderRecord = {
      groupId: info.group_id,
      name: folder.name,
      path: folder.path,
      owner: this.address,
      tag: newTag(),
      members: { [this.address]: { name: this.settings.deviceName, room: this.settings.room } },
    };
    this.settings.folders[record.groupId] = record;
    await this.saveSettings();
    await this.#openFolder(record);
    this.#log(`Shared ${record.name}: an MLS group with you as its only member`, "info");
    this.binder.refresh();
    this.invite(record.groupId);
    this.openPanel();
  }

  invite(groupId: string) {
    const record = this.settings.folders[groupId];
    if (!record?.tag || !this.settings.room) return;
    new InviteModal(this.app, record.name, inviteCode(this.settings.room, record.tag)).open();
  }

  share() {
    const parent = this.app.workspace.getActiveFile()?.parent;
    if (parent && !parent.isRoot() && !this.folderFor(parent.path + "/x.md")) {
      void this.shareFolder(parent);
    } else {
      new Notice(`${Platform.isMobile ? "Long-press" : "Right-click"} a folder in the file explorer and choose “Share with Offline Folders”.`);
    }
  }

  join() {
    new JoinModal(this.app, async (code) => {
      const parsed = parseInvite(code);
      if (!parsed) return new Notice("That isn't an invite code. It looks like xxxxxxxxxxxxxxxx-xxxxxx.");
      if (parsed.room === this.settings.room) return new Notice("That code is this device's own.");
      if (!this.settings.pendingJoins.some((p) => p.tag === parsed.tag)) {
        this.settings.pendingJoins.push({ code: code.trim(), ...parsed });
        await this.saveSettings();
      }
      this.#log(`Asking to join with ${code.trim()}`, "info");
      void this.mesh?.connect(parsed.room);
      // Ask every device already linked: the owner may be one of them.
      for (const peer of this.mesh?.linked ?? []) this.#askToJoin(peer);
      this.openPanel();
    }).open();
  }

  remove(groupId: string, address: string) {
    const record = this.settings.folders[groupId];
    const member = record?.members[address];
    if (!record || !member) return;
    new RemoveModal(this.app, { name: member.name, address }, record.name, async () => {
      const before = record.epoch;
      try {
        await this.node!.removeFromGroup(groupId, address);
      } catch (error) {
        return new Notice(`Could not remove ${member.name}: ${(error as Error).message}`);
      }
      delete record.members[address];
      await this.#refreshEpoch(groupId);
      this.#log(`Removed ${member.name} from ${record.name} · keys rotated, epoch ${before ?? "?"} → ${record.epoch ?? "?"}`, "remove");
      this.#broadcastRoster(record);
      await this.saveSettings();
    }).open();
  }

  async forget(groupId: string) {
    delete this.settings.folders[groupId];
    await this.saveSettings();
    await this.vault.adapter.remove(this.statePath(groupId)).catch(() => {});
    await this.vault.adapter.remove(this.statePath(groupId).replace(/\.ydoc$/, ".disk.json")).catch(() => {});
    this.refreshPanel();
  }

  // ---- engine events -----------------------------------------------------

  #onEvent(event: EngineEvent) {
    switch (event.type) {
      case "neighbor_discovered": {
        const peer = String(event.peer_id);
        this.mesh?.linked.add(peer);
        this.#onLinked(peer);
        break;
      }
      case "neighbor_lost":
        this.mesh?.linked.delete(String(event.peer_id));
        this.refreshPanel();
        break;
      case "secure_session_established":
        this.#askToJoin(String(event.peer_id));
        break;
      case "message_received": {
        const message = decode<DirectMessage>(event.content);
        if (message?.k === "join") this.#onJoinRequest(String(event.sender), message);
        break;
      }
      case "group_message_received": {
        const folder = this.folders.get(String(event.group_id));
        const message = decode<FolderMessage>(event.content);
        if (folder && message) this.#onFolderMessage(folder, String(event.sender), message);
        break;
      }
      case "group_member_added":
        void this.#onMemberAdded(String(event.group_id), String(event.user_id), event.group_name as string | undefined);
        break;
      case "group_member_removed":
        void this.#onMemberRemoved(String(event.group_id), String(event.user_id), String(event.removed_by));
        break;
    }
  }

  #onLinked(peer: string) {
    // Catch up with every folder this peer shares, both ways.
    for (const folder of this.folders.values()) {
      if (folder.record.members[peer]) {
        this.#sendFolder(folder, { k: "state", sv: b64(Y.encodeStateVector(folder.doc)) });
        this.#sendFolder(folder, { k: "hello", name: this.settings.deviceName, room: this.settings.room! });
      }
    }
    this.#askToJoin(peer);
    this.refreshPanel();
  }

  #askToJoin(peer: string) {
    for (const pending of this.settings.pendingJoins) {
      const message: DirectMessage = { k: "join", tag: pending.tag, name: this.settings.deviceName, room: this.settings.room! };
      this.node?.sendMessage(peer, encode(message)).catch(() => {});
    }
  }

  #onJoinRequest(sender: string, request: Extract<DirectMessage, { k: "join" }>) {
    const record = Object.values(this.settings.folders).find((f) => f.tag === request.tag && f.owner === this.address && !f.removed);
    if (!record || record.members[sender]) return;
    const key = `${record.groupId}/${sender}`;
    if (this.#asking.has(key)) return;
    this.#asking.add(key);
    new ApproveModal(this.app, { name: request.name, address: sender }, record.name, async (allow) => {
      if (!allow) {
        this.#log(`Denied ${request.name}`, "info");
        window.setTimeout(() => this.#asking.delete(key), 60_000);
        return;
      }
      this.#log(`Adding ${request.name} to ${record.name}…`, "join");
      const added = await this.#inviteWhenReady(record.groupId, sender);
      this.#asking.delete(key);
      if (!added) return new Notice(`Could not add ${request.name}: their device never sent its key package. Try again once it's linked.`);
      record.members[sender] = { name: request.name, room: request.room };
      const before = record.epoch;
      await this.#refreshEpoch(record.groupId);
      this.#log(`${request.name} joined ${record.name} · epoch ${before ?? "?"} → ${record.epoch ?? "?"}`, "join");
      await this.saveSettings();
      this.#broadcastRoster(record);
    }).open();
  }

  /** The invite fails until the device's key package has arrived over the new session. */
  async #inviteWhenReady(groupId: string, member: string) {
    for (let attempt = 0; attempt < INVITE_ATTEMPTS && !this.#unloading; attempt++) {
      try {
        await this.node!.inviteToGroup(groupId, member);
        return true;
      } catch {
        await sleep(INVITE_RETRY_MS);
      }
    }
    return false;
  }

  async #onMemberAdded(groupId: string, userId: string, groupName?: string) {
    const known = this.settings.folders[groupId];
    if (userId === this.address && (!known || known.removed)) {
      // This device was let in: the folder's notes arrive as its document.
      // A device let back in after a removal starts over in a new folder:
      // its old copy stays where it is as ordinary files, and is never read
      // back into the document, where it could overwrite newer text.
      // The event does not say which request was answered. With one pending
      // it is that one; otherwise the owner's roster names it by its tag.
      if (this.settings.pendingJoins.length === 1) this.settings.pendingJoins = [];
      const info = await this.node!.groupInfo(groupId);
      const name = groupName ?? info?.name ?? "Shared folder";
      const record: FolderRecord = {
        groupId,
        name,
        path: this.#freePath(name),
        owner: "",
        members: { [this.address]: { name: this.settings.deviceName, room: this.settings.room } },
        epoch: info?.epoch,
      };
      for (const m of info?.members ?? []) record.members[m] ??= { name: shortAddress(m) };
      this.settings.folders[groupId] = record;
      await this.saveSettings();
      await this.vault.createFolder(record.path).catch(() => {});
      const folder = await this.#openFolder(record);
      this.#sendFolder(folder, { k: "hello", name: this.settings.deviceName, room: this.settings.room! });
      this.#sendFolder(folder, { k: "state", sv: b64(Y.encodeStateVector(folder.doc)) });
      this.#log(`Joined ${name} · end-to-end encrypted, epoch ${record.epoch ?? "?"}`, "join");
      new Notice(`You joined “${name}”. Its notes are syncing into ${record.path}/`);
      this.binder.refresh();
      this.openPanel();
      return;
    }
    const record = this.settings.folders[groupId];
    if (!record) return;
    record.members[userId] ??= { name: shortAddress(userId) };
    await this.#refreshEpoch(groupId);
    await this.saveSettings();
    this.refreshPanel();
  }

  async #onMemberRemoved(groupId: string, userId: string, removedBy: string) {
    const record = this.settings.folders[groupId];
    if (!record) return;
    const by = record.members[removedBy]?.name ?? shortAddress(removedBy);
    if (userId === this.address) {
      record.removed = { by, at: Date.now(), keysHeld: true };
      const folder = this.folders.get(groupId);
      if (folder) {
        this.binder.release(folder);
        await folder.close({ forget: true });
        this.folders.delete(groupId);
      }
      // The engine left the MLS group when it processed the removal; ask it.
      record.removed.keysHeld = (await this.node!.groupInfo(groupId).catch(() => null)) !== null;
      await this.saveSettings();
      this.#log(`${by} removed this device from ${record.name}. Its keys are gone from here.`, "remove");
      new Notice(`${by} removed this device from “${record.name}”. Your copy stays as ordinary files; nothing new can reach it.`, 10_000);
      this.openPanel();
      return;
    }
    const name = record.members[userId]?.name ?? shortAddress(userId);
    delete record.members[userId];
    const before = record.epoch;
    await this.#refreshEpoch(groupId);
    if (record.owner !== this.address) this.#log(`${by} removed ${name} from ${record.name} · keys rotated, epoch ${before ?? "?"} → ${record.epoch ?? "?"}`, "remove");
    await this.saveSettings();
    this.refreshPanel();
  }

  #onFolderMessage(folder: SharedFolder, sender: string, message: FolderMessage) {
    const record = folder.record;
    switch (message.k) {
      case "part": {
        const whole = this.#parts.accept(sender, message);
        if (whole) this.#onFolderMessage(folder, sender, whole);
        return;
      }
      case "update":
        Y.applyUpdate(folder.doc, unb64(message.u), REMOTE);
        return;
      case "state": {
        const diff = Y.encodeStateAsUpdate(folder.doc, unb64(message.sv));
        if (diff.length > 2) this.#sendFolder(folder, { k: "update", u: b64(diff) });
        return;
      }
      case "presence":
        applyAwarenessUpdate(folder.awareness, unb64(message.u), "remote");
        this.refreshPanel();
        return;
      case "hello": {
        const known = record.members[sender];
        record.members[sender] = { name: message.name, room: message.room };
        if (!known || known.name !== message.name || known.room !== message.room) void this.saveSettings();
        if (record.owner === this.address) this.#broadcastRoster(record);
        this.refreshPanel();
        return;
      }
      case "roster": {
        if (record.owner && sender !== record.owner) return;
        record.owner = message.owner;
        for (const [address, member] of Object.entries(message.members)) {
          if (address === this.address) continue;
          record.members[address] = { ...record.members[address], ...member };
        }
        for (const address of Object.keys(record.members)) {
          if (address !== this.address && !message.members[address]) delete record.members[address];
        }
        if (message.tag) this.settings.pendingJoins = this.settings.pendingJoins.filter((p) => p.tag !== message.tag);
        void this.saveSettings();
        this.refreshPanel();
        return;
      }
    }
  }

  // ---- sending -------------------------------------------------------------

  #sendFolder(folder: SharedFolder, message: FolderMessage) {
    const node = this.node;
    if (!node || folder.record.removed) return;
    const others = Object.keys(folder.record.members).some((m) => m !== this.address);
    if (!others) return;
    const ephemeral = message.k === "presence";
    for (const part of split(message)) {
      node.sendGroupMessage(folder.groupId, encode(part), { ephemeral }).catch(() => {
        // Ephemeral presence with no live link is simply dropped; reliable
        // sends are queued by the engine and retried.
      });
    }
  }

  #broadcastRoster(record: FolderRecord) {
    const folder = this.folders.get(record.groupId);
    if (!folder) return;
    this.#sendFolder(folder, { k: "roster", owner: record.owner, members: record.members, tag: record.tag });
  }

  // ---- folders -------------------------------------------------------------

  async #openFolder(record: FolderRecord) {
    const folder = new SharedFolder(record, this, { address: this.address, name: this.settings.deviceName });
    folder.awareness.on("update", ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
      if (origin !== "local") return this.refreshPanel();
      const changed = [...added, ...updated, ...removed];
      this.#sendFolder(folder, { k: "presence", u: b64(encodeAwarenessUpdate(folder.awareness, changed)) });
    });
    this.folders.set(record.groupId, folder);
    await folder.load();
    await folder.reconcile();
    void this.#refreshEpoch(record.groupId);
    return folder;
  }

  #freePath(name: string) {
    const clean = name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Shared folder";
    let path = normalizePath(clean);
    for (let n = 2; this.vault.getAbstractFileByPath(path); n++) path = normalizePath(`${clean} (${n})`);
    return path;
  }

  async #refreshEpoch(groupId: string) {
    const record = this.settings.folders[groupId];
    if (!record || !this.node) return;
    const info = await this.node.groupInfo(groupId).catch(() => null);
    if (!info) return;
    if (record.epoch !== undefined && info.epoch !== record.epoch) this.#epochBumpedAt.set(groupId, Date.now());
    record.epoch = info.epoch;
    if (!record.owner && info.members.length) {
      // Until a roster arrives, the folder's owner is unknown; the members are not.
      for (const m of info.members) record.members[m] ??= { name: shortAddress(m) };
    }
    this.refreshPanel();
  }

  /** Every few seconds: link to members that are not linked. */
  #maintain() {
    const mesh = this.mesh;
    if (!mesh) return;
    for (const pending of this.settings.pendingJoins) void mesh.connect(pending.room);
    for (const record of Object.values(this.settings.folders)) {
      if (record.removed) continue;
      for (const [address, member] of Object.entries(record.members)) {
        if (address === this.address || mesh.linked.has(address) || !member.room) continue;
        // One side dials: the lower address. The other waits, then dials too
        // if nothing arrives; the engine keeps one link per device either way.
        if (this.address < address || (this.#unlinkedSince(address) ?? 0) > 30_000) void mesh.connect(member.room);
      }
    }
  }

  #unlinkedSeen = new Map<string, number>();
  #unlinkedSince(address: string) {
    if (!this.#unlinkedSeen.has(address)) this.#unlinkedSeen.set(address, Date.now());
    return Date.now() - this.#unlinkedSeen.get(address)!;
  }

  // ---- panel ---------------------------------------------------------------

  state(): PanelState {
    const linked = this.mesh?.linked ?? new Set<string>();
    const folders: PanelFolder[] = Object.values(this.settings.folders).map((record) => {
      const folder = this.folders.get(record.groupId);
      const editing = new Map<string, string[]>();
      if (folder) {
        for (const [, state] of folder.awareness.getStates()) {
          const user = state.user as { address?: string } | undefined;
          if (user?.address) editing.set(user.address, (state.open as string[]) ?? []);
        }
      }
      return {
        groupId: record.groupId,
        name: record.name,
        path: record.path,
        isOwner: record.owner === this.address,
        epoch: record.epoch ?? null,
        epochBumpedAt: this.#epochBumpedAt.get(record.groupId) ?? 0,
        removed: record.removed ? { by: record.removed.by, at: record.removed.at, keysHeld: record.removed.keysHeld ?? true } : undefined,
        members: Object.entries(record.members)
          .map(([address, m]) => ({
            address,
            name: m.name,
            you: address === this.address,
            owner: address === record.owner,
            online: linked.has(address),
            editing: (address === this.address ? (folder ? this.binder.openNotes(folder) : []) : editing.get(address)) ?? [],
          }))
          .sort((a, b) => Number(b.owner) - Number(a.owner) || Number(b.you) - Number(a.you) || a.name.localeCompare(b.name)),
      };
    });
    return {
      status: this.#status,
      error: this.#error,
      self: { name: this.settings.deviceName, address: this.address },
      linked: linked.size,
      relay: this.mesh?.relay ?? "connecting",
      joining: this.mesh?.joining ?? 0,
      folders,
      pendingJoins: this.settings.pendingJoins.map((p) => p.code),
      activity: this.#activity,
      wire: this.#wire,
      lastEdit: this.#lastEdit,
    };
  }

  refreshPanel = debounce(() => {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) (leaf.view as PanelView).render();
  }, 120);

  async openPanel() {
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf) this.app.workspace.revealLeaf(leaf);
  }

  #log(text: string, kind: PanelState["activity"][number]["kind"], coalesce = false) {
    const last = this.#activity[this.#activity.length - 1];
    if (coalesce && last?.text === text && Date.now() - last.at < 10_000) {
      last.at = Date.now();
    } else {
      this.#activity.push({ at: Date.now(), text, kind });
      if (this.#activity.length > 50) this.#activity.shift();
    }
    this.refreshPanel();
  }

  #onFrame(frame: WireFrame) {
    this.#wire.push(frame);
    if (this.#wire.length > 40) this.#wire.shift();
    this.refreshPanel();
  }

  #noteEdit(line: number, editor: { getLine(n: number): string }) {
    const file = this.app.workspace.getActiveFile();
    if (!file || !this.folderFor(file.path)) return;
    const text = editor.getLine(line).trim();
    if (text) this.#lastEdit = { at: Date.now(), text: text.length > 60 ? `${text.slice(0, 60)}…` : text };
  }

  // ---- settings --------------------------------------------------------------

  async loadSettings() {
    const data = (await this.loadData()) ?? {};
    this.settings = {
      deviceName: data.deviceName ?? defaultDeviceName(),
      profile: data.profile ?? `vault-${crypto.randomUUID()}`,
      room: data.room,
      folders: data.folders ?? {},
      pendingJoins: data.pendingJoins ?? [],
      relays: Array.isArray(data.relays) ? data.relays : [...RELAYS],
      localRelay: data.localRelay ?? false,
      relayPort: data.relayPort ?? RELAY_PORT,
    };
    await this.saveSettings();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---- relays ---------------------------------------------------------------

  /** The relays this device signals through: its list, and its own relay if it runs one. */
  relays(): string[] {
    const own = this.localRelay ? [`ws://127.0.0.1:${this.settings.relayPort}`] : [];
    return [...new Set([...this.settings.relays, ...own])];
  }

  async #startLocalRelay() {
    this.localRelay?.close();
    this.localRelay = null;
    this.localRelayError = null;
    if (!this.settings.localRelay || !Platform.isDesktopApp) return;
    try {
      this.localRelay = await LocalRelay.start(this.settings.relayPort);
    } catch (error) {
      this.localRelayError = String((error as Error)?.message ?? error);
      new Notice(`Offline Folders could not run a relay on port ${this.settings.relayPort}: ${this.localRelayError}`);
    }
  }

  /** After the relay settings change: restart this computer's relay if needed, and signal through the new list. */
  async applyRelays() {
    await this.saveSettings();
    if (this.#unloading) return;
    await this.#startLocalRelay();
    this.mesh?.setRelays(this.relays());
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(private plugin: OfflineFoldersPlugin) {
    super(plugin.app, plugin);
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Device name")
      .setDesc("What other members see. Your identity is the device address below; the name is only a label.")
      .addText((t) =>
        t.setValue(this.plugin.settings.deviceName).onChange(async (v) => {
          this.plugin.settings.deviceName = v.trim() || defaultDeviceName();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl).setName("Device address").setDesc(this.plugin.address || "starting…");

    new Setting(containerEl).setName("Linking devices").setHeading();
    new Setting(containerEl)
      .setName("Relays")
      .setDesc(
        "Nostr relays that carry the sealed handshake when two devices link, one per line. Notes never cross them. " +
          "Devices link only through a relay they both list. With no internet, list a relay on your own network, " +
          "such as one a computer runs below.",
      )
      .addTextArea((t) => {
        t.inputEl.rows = 4;
        t.inputEl.style.width = "100%";
        t.setValue(this.plugin.settings.relays.join("\n"));
        t.inputEl.addEventListener("blur", async () => {
          const urls = t.getValue().split(/\s+/).map((u) => u.trim()).filter(Boolean);
          const bad = urls.filter((u) => !/^wss?:\/\/[^\s/]+/.test(u));
          if (bad.length) return new Notice(`Not a relay address: ${bad.join(", ")}. Use ws:// or wss://.`);
          if (urls.join("\n") === this.plugin.settings.relays.join("\n")) return;
          this.plugin.settings.relays = urls;
          await this.plugin.applyRelays();
        });
      });
    if (!Platform.isDesktopApp) return;
    new Setting(containerEl)
      .setName("Run a relay on this computer")
      .setDesc(
        "For a network with no internet. It carries only the sealed handshake, stores nothing, " +
          "and runs while Obsidian is open. Add its address to the relays on your other devices.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.localRelay).onChange(async (on) => {
          this.plugin.settings.localRelay = on;
          await this.plugin.applyRelays();
          this.display();
        }),
      );
    if (!this.plugin.settings.localRelay) return;
    new Setting(containerEl).setName("Relay port").addText((t) =>
      t.setValue(String(this.plugin.settings.relayPort)).onChange(
        debounce(async (v: string) => {
          const port = Number(v);
          if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
          this.plugin.settings.relayPort = port;
          await this.plugin.applyRelays();
          this.display();
        }, 800, true),
      ),
    );
    const urls = LocalRelay.lanUrls(this.plugin.settings.relayPort);
    new Setting(containerEl)
      .setName("Address for your other devices")
      .setDesc(
        this.plugin.localRelayError
          ? `Not running: ${this.plugin.localRelayError}`
          : urls.length
            ? urls.join("  or  ")
            : "This computer has no network address right now.",
      );
  }
}

function defaultDeviceName() {
  try {
    const os = (window as unknown as { require?: (m: string) => { hostname(): string } }).require?.("os");
    const host = os?.hostname().replace(/\.local$/, "");
    if (host) return host;
  } catch {
    // Mobile has no os module.
  }
  return "Obsidian device";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
