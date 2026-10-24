# Demo script (about 3 minutes)

Two laptops side by side on the same Wi-Fi, A and B, each with Obsidian and
the plugin. A has a
folder `Project Notes` with a couple of notes. Open the Offline Folders panel
on both (the folder-lock icon in the ribbon). A third device, C, is optional
for the removal beat.

## 1. Share (20 s)

On A, right-click `Project Notes` and choose *Share with Offline Folders*.
An invite code appears.

> "This folder is now an encrypted group with one member. No account, no
> server. The code just lets another device ask to join."

## 2. Join and approve (30 s)

On B, run *Join with a code* and type the code. On A, a prompt appears:
*B wants to join*, with B's device identity.

> "A approves the device, not an email address. It's a cryptographic
> identity."

Allow. B's folder fills in. The key epoch reads 1 on both panels.

## 3. Edit together (30 s)

Open the same note on both. Type on A; it appears on B with A's cursor and
name. Type on B; it appears on A.

## 4. Pull the plug (45 s)

Turn Wi-Fi off on B. Edit the same note on both, on different lines. Turn
Wi-Fi back on.

> "No 'conflicted copy'. Both edits are just there."

## 5. Show the wire (15 s)

Open *What the network sees* on either panel. The line you just typed sits
above the frames that actually left the machine.

> "That's all the network ever sees."

## 6. Remove someone (40 s)

With C also in the folder: on A, click remove next to C and confirm
*Remove and rotate keys*.

- A and B: the key epoch goes up, with a pulse, and the activity log reads
  *keys rotated, epoch 2 → 3*.
- C: the folder turns red. *Access revoked by A. Folder keys held by this
  device: none.*

Type a new line on A. It appears on B and never on C.

> "Every other tool here shares one password or trusts a server. This is
> MLS: C never got the new keys, so there is nothing to leak."

## Reset between takes

Start each take from fresh vaults. A vault keeps its shared folders in
`.obsidian/plugins/offline-folders/data.json` and its device identity in the
engine's own storage, keyed by that file's `profile`. Deleting `data.json`
gives the vault a new identity and no folders.
