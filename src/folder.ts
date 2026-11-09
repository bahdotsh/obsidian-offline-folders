// One shared folder: a Yjs document mirrored to the vault's files.
//
// The document holds one Y.Text per note, keyed by its path inside the
// folder. Edits flow three ways:
// - an open editor is bound to its Y.Text (editor.ts), so keystrokes are
//   document edits and remote edits appear in place, cursors and all;
// - a note that is not open is written to disk when a remote edit lands;
// - a change on disk to a note that is not open (another app, a sync tool,
//   a file created in the folder) is diffed into the document.
// The document is saved in the plugin folder after every change, so a device
// that restarts offline still holds everything it had.

import { normalizePath, TAbstractFile, TFile, TFolder, Vault } from "obsidian";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { Member } from "./protocol";

/** Edits that arrived from another device. Never sent back out. */
export const REMOTE = Symbol("remote");
/** Edits read from disk. */
export const DISK = Symbol("disk");

const SYNCED_EXTENSIONS = new Set(["md", "txt", "canvas", "csv"]);

export interface FolderRecord {
  groupId: string;
  name: string;
  path: string;
  owner: string;
  /** Owner only: the tag in this folder's invite code. */
  tag?: string;
  members: Record<string, Member>;
  epoch?: number;
  removed?: { by: string; at: number; keysHeld?: boolean };
}

export interface FolderHost {
  vault: Vault;
  statePath(groupId: string): string;
  isBound(folder: SharedFolder, rel: string): boolean;
  send(folder: SharedFolder, update: Uint8Array): void;
  changed(folder: SharedFolder): void;
}

const COLORS = ["#e5484d", "#3e63dd", "#30a46c", "#f76b15", "#8e4ec6", "#12a594", "#d6409f", "#ffb224"];

export function colorFor(address: string) {
  let h = 0;
  for (const c of address) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export class SharedFolder {
  readonly doc = new Y.Doc();
  readonly files = this.doc.getMap<Y.Text>("files");
  readonly awareness: Awareness;
  /** Remote edits waiting to be written to notes that are not open. */
  #dirty = new Set<string>();
  #flushTimer: number | null = null;
  #saveTimer: number | null = null;
  #outbox: Uint8Array[] = [];
  #sendTimer: number | null = null;
  /** What this plugin last wrote to each path, so its own write is not read back as an edit. */
  #written = new Map<string, string>();
  /**
   * A fingerprint of each note as this plugin last saw it on disk, saved
   * beside the document. At start it tells an edit made while the plugin
   * was off (the file changed) from a file Obsidian never got to save
   * (the file did not change, and the document is ahead of it).
   */
  #seen = new Map<string, string>();
  /** Paths this plugin is deleting because another device did. */
  #deleting = new Set<string>();
  #closed = false;
  lastRemoteAt = 0;

  constructor(
    readonly record: FolderRecord,
    readonly host: FolderHost,
    self: { address: string; name: string },
  ) {
    this.awareness = new Awareness(this.doc);
    const color = colorFor(self.address);
    this.awareness.setLocalStateField("user", { name: self.name, color, colorLight: `${color}33`, address: self.address });

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.#scheduleSave();
      if (origin !== REMOTE) {
        this.#outbox.push(update);
        this.#sendTimer ??= window.setTimeout(() => this.#sendOut(), 40);
      }
    });
    this.files.observeDeep((events, txn) => {
      if (txn.origin !== REMOTE) return;
      this.lastRemoteAt = Date.now();
      for (const event of events) {
        if (event.target === this.files) {
          for (const key of (event as Y.YMapEvent<Y.Text>).keysChanged) this.#dirty.add(key);
        } else if (typeof event.path[0] === "string") {
          this.#dirty.add(event.path[0]);
        }
      }
      this.#flushTimer ??= window.setTimeout(() => this.flush(), 150);
      host.changed(this);
    });
  }

  get groupId() {
    return this.record.groupId;
  }

  /** The note's path inside the folder, or null for a path outside it. */
  rel(path: string): string | null {
    const root = this.record.path + "/";
    if (!path.startsWith(root)) return null;
    const rel = path.slice(root.length);
    const ext = (rel.split(".").pop() ?? "").toLowerCase();
    return SYNCED_EXTENSIONS.has(ext) ? rel : null;
  }

  contains(path: string) {
    return path === this.record.path || path.startsWith(this.record.path + "/");
  }

  abs(rel: string) {
    return normalizePath(`${this.record.path}/${rel}`);
  }

  async load() {
    const adapter = this.host.vault.adapter;
    const path = this.host.statePath(this.groupId);
    if (await adapter.exists(path)) {
      Y.applyUpdate(this.doc, new Uint8Array(await adapter.readBinary(path)), DISK);
    }
    try {
      const seen = JSON.parse(await adapter.read(this.#seenPath())) as Record<string, string>;
      for (const [rel, print] of Object.entries(seen)) this.#seen.set(rel, print);
    } catch {
      // None yet (a folder from an older version, or a new one): every
      // difference at start is then read as an edit on disk, as before.
    }
  }

  /**
   * Brings the document and the folder into agreement at start: a note
   * edited while the plugin was off is an edit, and a note the document has
   * that the folder lacks is written out.
   */
  async reconcile() {
    const folder = this.host.vault.getAbstractFileByPath(this.record.path);
    if (!(folder instanceof TFolder)) await this.host.vault.createFolder(this.record.path).catch(() => {});
    const seen = new Set<string>();
    for (const file of this.host.vault.getFiles()) {
      const rel = this.rel(file.path);
      if (rel === null) continue;
      seen.add(rel);
      const text = await this.host.vault.read(file);
      const doc = this.files.get(rel)?.toString();
      if (doc !== undefined && doc !== text && this.#seen.get(rel) === fingerprint(text)) {
        // The file is as this plugin last saw it, so the document is ahead:
        // Obsidian was closed before it saved the latest edits. Reading the
        // file in would delete them, here and on every other device.
        this.#dirty.add(rel);
        continue;
      }
      this.#see(rel, text);
      this.setText(rel, text, DISK);
    }
    for (const rel of this.files.keys()) if (!seen.has(rel)) this.#dirty.add(rel);
    await this.flush();
  }

  /** Reads a note from disk into the document, unless it is this plugin's own write. */
  async ingest(file: TFile) {
    const rel = this.rel(file.path);
    if (rel === null) return;
    const text = await this.host.vault.read(file);
    this.#see(rel, text);
    if (this.host.isBound(this, rel)) return;
    if (this.#written.get(file.path) === text) return;
    this.#written.delete(file.path);
    this.setText(rel, text, DISK);
  }

  /** The note's Y.Text, created from `initial` when the document has none. */
  text(rel: string, initial: string): Y.Text {
    let text = this.files.get(rel);
    if (!text) {
      this.doc.transact(() => {
        text = new Y.Text(initial);
        this.files.set(rel, text);
      }, DISK);
    }
    return text!;
  }

  setText(rel: string, value: string, origin: unknown) {
    this.doc.transact(() => {
      const text = this.files.get(rel);
      if (!text) {
        this.files.set(rel, new Y.Text(value));
        return;
      }
      applyDiff(text, value);
    }, origin);
  }

  removed(path: string) {
    const rel = this.rel(path);
    if (rel === null) return;
    if (this.#seen.delete(rel)) this.#scheduleSave();
    if (this.#deleting.delete(path)) return;
    if (this.files.has(rel)) this.doc.transact(() => this.files.delete(rel), DISK);
  }

  /** Writes remote edits to every note that is not open in an editor. */
  async flush() {
    this.#flushTimer = null;
    const vault = this.host.vault;
    for (const rel of [...this.#dirty]) {
      this.#dirty.delete(rel);
      if (this.#closed || this.host.isBound(this, rel)) continue;
      const path = this.abs(rel);
      const existing = vault.getAbstractFileByPath(path);
      const text = this.files.get(rel);
      if (!text) {
        if (existing instanceof TFile) {
          this.#deleting.add(path);
          await vault.trash(existing, false);
        }
        continue;
      }
      const value = text.toString();
      if (existing instanceof TFile) {
        if ((await vault.read(existing)) === value) continue;
        this.#written.set(path, value);
        this.#see(rel, value);
        await vault.modify(existing, value);
      } else if (!existing) {
        await ensureParent(vault, path);
        this.#written.set(path, value);
        this.#see(rel, value);
        await vault.create(path, value);
      }
    }
  }

  /** Marks a note for writing once its editor closes, as it may have missed edits on disk. */
  markDirty(rel: string) {
    this.#dirty.add(rel);
    this.#flushTimer ??= window.setTimeout(() => this.flush(), 150);
  }

  #sendOut() {
    this.#sendTimer = null;
    if (this.#outbox.length === 0) return;
    const update = Y.mergeUpdates(this.#outbox);
    this.#outbox = [];
    this.host.send(this, update);
  }

  #scheduleSave() {
    if (this.#saveTimer !== null) return;
    this.#saveTimer = window.setTimeout(() => {
      this.#saveTimer = null;
      void this.save();
    }, 800);
  }

  async save() {
    if (this.#closed) return;
    const adapter = this.host.vault.adapter;
    await adapter.writeBinary(this.host.statePath(this.groupId), toArrayBuffer(Y.encodeStateAsUpdate(this.doc)));
    await adapter.write(this.#seenPath(), JSON.stringify(Object.fromEntries(this.#seen)));
  }

  #see(rel: string, text: string) {
    const print = fingerprint(text);
    if (this.#seen.get(rel) === print) return;
    this.#seen.set(rel, print);
    this.#scheduleSave();
  }

  #seenPath() {
    return this.host.statePath(this.groupId).replace(/\.ydoc$/, ".disk.json");
  }

  /** Stops syncing. The notes stay where they are, as ordinary files. */
  async close({ forget = false } = {}) {
    if (!forget) {
      if (this.#sendTimer !== null) this.#sendOut();
      await this.save();
    }
    this.#closed = true;
    for (const timer of [this.#flushTimer, this.#saveTimer, this.#sendTimer]) if (timer !== null) clearTimeout(timer);
    this.awareness.destroy();
    if (forget) {
      await this.host.vault.adapter.remove(this.host.statePath(this.groupId)).catch(() => {});
      await this.host.vault.adapter.remove(this.#seenPath()).catch(() => {});
    }
  }
}

/** Replaces the text with `next` by its smallest single edit: the common prefix and suffix stay. */
export function applyDiff(text: Y.Text, next: string) {
  const prev = text.toString();
  if (prev === next) return;
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  // Never split a surrogate pair: back off to the start of the character.
  if (start > 0 && isHighSurrogate(prev.charCodeAt(start - 1))) start--;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--;
    endNext--;
  }
  if (endPrev < prev.length && isLowSurrogate(prev.charCodeAt(endPrev))) {
    endPrev++;
    endNext++;
  }
  if (endPrev > start) text.delete(start, endPrev - start);
  if (endNext > start) text.insert(start, next.slice(start, endNext));
}

/** A note's length and FNV-1a hash: enough to tell whether a file changed. */
function fingerprint(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${text.length}:${h.toString(16)}`;
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

async function ensureParent(vault: Vault, path: string) {
  const parent = path.split("/").slice(0, -1).join("/");
  if (parent && !vault.getAbstractFileByPath(parent)) await vault.createFolder(parent).catch(() => {});
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function isFile(file: TAbstractFile): file is TFile {
  return file instanceof TFile;
}
