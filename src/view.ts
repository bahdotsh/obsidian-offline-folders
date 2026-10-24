// The side panel: who is in each shared folder, whether they are reachable,
// the folder's key epoch, and what the network actually carries.

import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type { WireFrame } from "./engine";
import type { RelayState } from "./mesh";
import { shortAddress } from "./protocol";
import { colorFor } from "./folder";

export const VIEW_TYPE = "offline-folders-panel";

export interface PanelMember {
  address: string;
  name: string;
  online: boolean;
  you: boolean;
  owner: boolean;
  editing: string[];
}

export interface PanelFolder {
  groupId: string;
  name: string;
  path: string;
  isOwner: boolean;
  epoch: number | null;
  epochBumpedAt: number;
  members: PanelMember[];
  removed?: { by: string; at: number; keysHeld: boolean };
}

export interface PanelState {
  status: "starting" | "running" | "failed";
  error?: string;
  self: { name: string; address: string };
  linked: number;
  relay: RelayState;
  joining: number;
  folders: PanelFolder[];
  pendingJoins: string[];
  activity: { at: number; text: string; kind: "join" | "remove" | "sync" | "info" }[];
  wire: WireFrame[];
  lastEdit: { at: number; text: string } | null;
}

export interface PanelActions {
  state(): PanelState;
  invite(groupId: string): void;
  remove(groupId: string, address: string): void;
  forget(groupId: string): void;
  join(): void;
  share(): void;
}

export class PanelView extends ItemView {
  #wireOpen = false;

  constructor(leaf: WorkspaceLeaf, private actions: PanelActions) {
    super(leaf);
  }
  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "Offline Folders";
  }
  getIcon() {
    return "folder-lock";
  }
  async onOpen() {
    this.render();
  }

  render() {
    const s = this.actions.state();
    const root = this.contentEl;
    root.empty();
    root.addClass("off-panel");

    const device = root.createDiv({ cls: "off-device" });
    const top = device.createDiv({ cls: "off-device-top" });
    top.createSpan({ cls: "off-device-name", text: s.self.name });
    if (s.self.address) {
      const addr = top.createEl("code", { cls: "off-addr", text: shortAddress(s.self.address) });
      addr.setAttr("aria-label", `This device's identity: ${s.self.address}`);
    }
    const net = device.createDiv({ cls: "off-net" });
    if (s.status === "starting") net.setText("Starting the encrypted node…");
    else if (s.status === "failed") net.createSpan({ cls: "off-bad", text: `The node stopped: ${s.error ?? "unknown error"}` });
    else {
      const linked = net.createSpan({ cls: s.linked ? "off-pill off-good" : "off-pill" });
      linked.setText(s.linked === 1 ? "1 device linked" : `${s.linked} devices linked`);
      const relay = net.createSpan({ cls: "off-pill" });
      relay.setText(
        s.relay === "listening" ? "reachable by code" : s.relay === "connecting" ? "opening room…" : "no relay: same-machine only",
      );
      relay.setAttr(
        "aria-label",
        "Nostr relays carry only the sealed WebRTC handshake. Notes go device to device.",
      );
      if (s.joining) net.createSpan({ cls: "off-pill", text: `connecting to ${s.joining}…` });
    }

    const actions = root.createDiv({ cls: "off-actions" });
    button(actions, "folder-plus", "Share a folder", () => this.actions.share());
    button(actions, "log-in", "Join with a code", () => this.actions.join());

    for (const code of s.pendingJoins) {
      const card = root.createDiv({ cls: "off-card off-pending" });
      card.createDiv({ cls: "off-card-title", text: "Waiting for approval" });
      card.createDiv({ cls: "off-muted", text: `Asked to join with ${code}. The owner's device shows a prompt when it links to this one.` });
    }

    for (const f of s.folders) this.#folder(root, f);

    if (s.folders.length === 0 && s.pendingJoins.length === 0) {
      const empty = root.createDiv({ cls: "off-empty" });
      empty.createEl("p", { text: "Nothing shared yet." });
      empty.createEl("p", {
        cls: "off-muted",
        text: "Right-click a folder and choose “Share with Offline Folders”, or join one with a code from another device.",
      });
    }

    if (s.activity.length) {
      root.createDiv({ cls: "off-section", text: "Activity" });
      const list = root.createDiv({ cls: "off-activity" });
      for (const a of s.activity.slice(-8).reverse()) {
        const row = list.createDiv({ cls: `off-act off-act-${a.kind}` });
        row.createSpan({ cls: "off-time", text: time(a.at) });
        row.createSpan({ text: a.text });
      }
    }

    const wire = root.createEl("details", { cls: "off-wire" });
    wire.open = this.#wireOpen;
    wire.addEventListener("toggle", () => (this.#wireOpen = wire.open));
    wire.createEl("summary", { text: "What the network sees" });
    if (s.lastEdit) {
      const plain = wire.createDiv({ cls: "off-wire-plain" });
      plain.createSpan({ cls: "off-wire-label", text: "you typed" });
      plain.createSpan({ text: s.lastEdit.text });
    }
    if (s.wire.length === 0) {
      wire.createDiv({
        cls: "off-muted",
        text: "No WebRTC frames yet. Windows on the same machine link inside the engine and are not shown here.",
      });
    }
    for (const frame of s.wire.slice(-10).reverse()) {
      const row = wire.createDiv({ cls: "off-frame" });
      row.createSpan({ cls: "off-frame-dir", text: frame.dir === "out" ? "↑" : "↓" });
      row.createSpan({ cls: "off-frame-len", text: `${frame.length} B` });
      row.createSpan({ cls: "off-frame-hex", text: hex(frame.head) });
    }
  }

  #folder(root: HTMLElement, f: PanelFolder) {
    const card = root.createDiv({ cls: f.removed ? "off-card off-revoked" : "off-card" });
    const head = card.createDiv({ cls: "off-card-head" });
    const title = head.createDiv({ cls: "off-card-title" });
    const icon = title.createSpan();
    setIcon(icon, f.removed ? "lock" : "folder-sync");
    title.createSpan({ text: f.name });
    if (f.isOwner && !f.removed) {
      button(head, "user-plus", "Invite", () => this.actions.invite(f.groupId), "off-small");
    }

    if (f.removed) {
      card.createDiv({ cls: "off-revoked-text", text: `Access revoked by ${f.removed.by}.` });
      const keys = card.createDiv({ cls: "off-keys" });
      keys.createSpan({ text: "Folder keys held by this device: " });
      keys.createEl("strong", { text: f.removed.keysHeld ? "still present" : "none" });
      card.createDiv({
        cls: "off-muted",
        text: "The others moved to a new key epoch this device was never given. Notes here stay as ordinary local files; nothing new can reach them.",
      });
      button(card, "trash", "Forget", () => this.actions.forget(f.groupId), "off-small");
      return;
    }

    const meta = card.createDiv({ cls: "off-meta" });
    const epoch = meta.createSpan({ cls: "off-epoch" });
    if (Date.now() - f.epochBumpedAt < 6000) epoch.addClass("off-epoch-bump");
    const key = epoch.createSpan();
    setIcon(key, "key-round");
    epoch.createSpan({ text: f.epoch === null ? "key epoch …" : `key epoch ${f.epoch}` });
    epoch.setAttr("aria-label", "MLS epoch: advances every time membership changes. A removed device never holds a later epoch's keys.");
    meta.createSpan({ cls: "off-muted", text: `${f.path}/` });

    const members = card.createDiv({ cls: "off-members" });
    for (const m of f.members) {
      const row = members.createDiv({ cls: "off-member" });
      const dot = row.createSpan({ cls: m.online || m.you ? "off-dot off-online" : "off-dot" });
      dot.style.setProperty("--off-color", colorFor(m.address));
      const who = row.createDiv({ cls: "off-who" });
      const name = who.createDiv({ cls: "off-name" });
      name.createSpan({ text: m.name });
      if (m.you) name.createSpan({ cls: "off-tag", text: "you" });
      if (m.owner) name.createSpan({ cls: "off-tag", text: "owner" });
      const sub = who.createDiv({ cls: "off-sub" });
      sub.createEl("code", { text: shortAddress(m.address) });
      if (m.editing.length) sub.createSpan({ text: ` · editing ${m.editing.map(base).join(", ")}` });
      else if (!m.you && !m.online) sub.createSpan({ text: " · not linked" });
      if (f.isOwner && !m.you) {
        const remove = row.createEl("button", { cls: "off-icon-btn off-danger" });
        setIcon(remove, "user-minus");
        remove.setAttr("aria-label", `Remove ${m.name} and rotate the folder's keys`);
        remove.addEventListener("click", () => this.actions.remove(f.groupId, m.address));
      }
    }
  }
}

function button(parent: HTMLElement, icon: string, label: string, onClick: () => void, cls = "") {
  const b = parent.createEl("button", { cls: `off-btn ${cls}` });
  const i = b.createSpan();
  setIcon(i, icon);
  b.createSpan({ text: label });
  b.addEventListener("click", onClick);
  return b;
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const base = (rel: string) => rel.split("/").pop()!.replace(/\.md$/, "");
const hex = (bytes: Uint8Array) => Array.from(bytes.slice(0, 20), (b) => b.toString(16).padStart(2, "0")).join(" ") + " …";
