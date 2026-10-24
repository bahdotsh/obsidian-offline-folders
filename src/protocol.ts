// What devices say to each other, inside the SDK's encrypted messages.
//
// Folder traffic rides the folder's MLS group: only current members can read
// it. The join request is the one direct message, sent before the asker is a
// member; it carries nothing from any folder.

import { fromBase64, toBase64 } from "lib0/buffer";

const PREFIX = "offline-folders/1 ";

export interface Member {
  name: string;
  /** The member's own Nostr room, so any member can reach any other. */
  room?: string;
}

export type FolderMessage =
  /** A Yjs update: edits to the folder's notes. */
  | { k: "update"; u: string }
  /** "Here is what I have": answer with what it lacks. */
  | { k: "state"; sv: string }
  /** Cursors and who is editing what. Sent once, never retried. */
  | { k: "presence"; u: string }
  /** A member's name and room. */
  | { k: "hello"; name: string; room: string }
  /** The owner's view of who is in the folder. */
  | { k: "roster"; owner: string; members: Record<string, Member> }
  /** One piece of a message too large to send whole. */
  | { k: "part"; id: string; i: number; n: number; d: string };

export type DirectMessage = { k: "join"; tag: string; name: string; room: string };

export function encode(message: FolderMessage | DirectMessage): string {
  return PREFIX + JSON.stringify(message);
}

export function decode<T>(content: unknown): T | null {
  if (typeof content !== "string" || !content.startsWith(PREFIX)) return null;
  try {
    return JSON.parse(content.slice(PREFIX.length)) as T;
  } catch {
    return null;
  }
}

export const b64 = (bytes: Uint8Array) => toBase64(bytes);
export const unb64 = (text: string) => fromBase64(text);

/** Messages above this are sent in parts; the engine caps a message at 1 MiB. */
export const PART_CHARS = 192 * 1024;

export function split(message: FolderMessage): FolderMessage[] {
  const text = JSON.stringify(message);
  if (text.length <= PART_CHARS) return [message];
  const id = crypto.randomUUID();
  const n = Math.ceil(text.length / PART_CHARS);
  return Array.from({ length: n }, (_, i) => ({
    k: "part" as const,
    id,
    i,
    n,
    d: text.slice(i * PART_CHARS, (i + 1) * PART_CHARS),
  }));
}

/** Reassembles parts per sender; returns the whole message once complete. */
export class Reassembler {
  #pending = new Map<string, { parts: string[]; got: number; at: number }>();

  accept(sender: string, part: Extract<FolderMessage, { k: "part" }>): FolderMessage | null {
    const key = `${sender}/${part.id}`;
    let entry = this.#pending.get(key);
    if (!entry) {
      entry = { parts: new Array(part.n), got: 0, at: Date.now() };
      this.#pending.set(key, entry);
    }
    if (entry.parts[part.i] === undefined) {
      entry.parts[part.i] = part.d;
      entry.got++;
    }
    for (const [k, e] of this.#pending) if (Date.now() - e.at > 10 * 60_000) this.#pending.delete(k);
    if (entry.got < part.n) return null;
    this.#pending.delete(key);
    try {
      return JSON.parse(entry.parts.join("")) as FolderMessage;
    } catch {
      return null;
    }
  }
}

/** Invite codes: the owner's room, a dash, and the folder's tag. */
export function inviteCode(room: string, tag: string) {
  return `${room}-${tag}`;
}

export function parseInvite(code: string): { room: string; tag: string } | null {
  const m = code.trim().toLowerCase().replace(/\s+/g, "").match(/^([a-z0-9]{16})-([a-z0-9]{6})$/);
  return m ? { room: m[1], tag: m[2] } : null;
}

export function newTag(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => alphabet[b % alphabet.length]).join("");
}

export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address;
}
