// Binds open editors to their note's Y.Text, so typing is a CRDT edit and
// other devices' edits and cursors appear live.
//
// One compartment is registered in every editor. Binding a note puts
// y-codemirror's yCollab extension in it; unbinding empties it. Obsidian can
// show another note in the same editor, so bindings are re-checked whenever
// the open notes change.

import { Compartment, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MarkdownView, Workspace } from "obsidian";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import type { SharedFolder } from "./folder";

export const collab = new Compartment();

interface Binding {
  folder: SharedFolder;
  rel: string;
  path: string;
  /** What the compartment holds while bound; a fresh editor state drops it. */
  extension: Extension;
}

export class EditorBinder {
  #bound = new Map<EditorView, Binding>();

  constructor(
    private workspace: Workspace,
    private folderFor: (path: string) => SharedFolder | null,
  ) {}

  isBound(folder: SharedFolder, rel: string) {
    for (const b of this.#bound.values()) if (b.folder === folder && b.rel === rel) return true;
    return false;
  }

  /** Who is open where, for the panel. */
  openNotes(folder: SharedFolder): string[] {
    return [...this.#bound.values()].filter((b) => b.folder === folder).map((b) => b.rel);
  }

  refresh() {
    const live = new Set<EditorView>();
    for (const leaf of this.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (!cm) continue;
      live.add(cm);
      const path = view.file?.path ?? null;
      const folder = path ? this.folderFor(path) : null;
      const rel = folder && path ? folder.rel(path) : null;
      const current = this.#bound.get(cm);
      if (current && current.path === path && current.folder === folder) {
        if (collab.get(cm.state) === current.extension) continue;
        // Obsidian gave the editor a new state for the same note (a reload,
        // say), which emptied the compartment: bind again.
        this.#bound.delete(cm);
      } else if (current) this.#unbind(cm, current);
      if (folder && rel && path) this.#bind(cm, folder, rel, path);
    }
    for (const [cm, binding] of this.#bound) if (!live.has(cm)) this.#unbind(cm, binding);
    this.#publishOpen();
  }

  /** Unbinds every editor showing a note of `folder` (it was removed or stopped). */
  release(folder: SharedFolder) {
    for (const [cm, binding] of this.#bound) if (binding.folder === folder) this.#unbind(cm, binding);
  }

  releaseAll() {
    for (const [cm, binding] of this.#bound) this.#unbind(cm, binding);
  }

  #bind(cm: EditorView, folder: SharedFolder, rel: string, path: string) {
    const ytext = folder.text(rel, cm.state.doc.toString());
    const value = ytext.toString();
    // yCollab expects the editor and the text to start equal; the document
    // is the truth, as it holds every device's edits.
    if (cm.state.doc.toString() !== value) {
      cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: value } });
    }
    const undoManager = new Y.UndoManager(ytext);
    const extension = yCollab(ytext, folder.awareness, { undoManager });
    cm.dispatch({ effects: collab.reconfigure(extension) });
    this.#bound.set(cm, { folder, rel, path, extension });
  }

  #unbind(cm: EditorView, binding: Binding) {
    this.#bound.delete(cm);
    try {
      cm.dispatch({ effects: collab.reconfigure([]) });
    } catch {
      // The editor is gone.
    }
    // Its own saves were skipped while bound; make sure the file is current.
    binding.folder.markDirty(binding.rel);
  }

  // Each folder's presence says which note this device has open there.
  #publishOpen() {
    const byFolder = new Map<SharedFolder, string[]>();
    for (const b of this.#bound.values()) byFolder.set(b.folder, [...(byFolder.get(b.folder) ?? []), b.rel]);
    for (const [folder, notes] of byFolder) folder.awareness.setLocalStateField("open", notes);
  }

  clearOpen(folders: Iterable<SharedFolder>) {
    for (const folder of folders) {
      if (!this.openNotes(folder).length) folder.awareness.setLocalStateField("open", []);
    }
  }
}
