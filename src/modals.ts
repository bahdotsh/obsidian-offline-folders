import { App, Modal, Notice, Setting } from "obsidian";
import { shortAddress } from "./protocol";

export class InviteModal extends Modal {
  constructor(app: App, private folder: string, private code: string) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(`Invite a device to “${this.folder}”`);
    contentEl.addClass("off-modal");
    contentEl.createEl("p", {
      text: "Give this code to the other device by any means: say it, paste it, message it. It only lets the device ask to join. You approve every device yourself.",
    });
    const code = contentEl.createDiv({ cls: "off-code", text: this.code });
    code.setAttr("aria-label", "Invite code");
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Copy code")
        .setCta()
        .onClick(async () => {
          await navigator.clipboard.writeText(this.code);
          new Notice("Invite code copied");
        }),
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}

export class JoinModal extends Modal {
  constructor(app: App, private onJoin: (code: string) => void) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText("Join a shared folder");
    contentEl.addClass("off-modal");
    contentEl.createEl("p", { text: "Paste the invite code the folder's owner gave you. They'll be asked to approve this device." });
    let value = "";
    new Setting(contentEl).setName("Invite code").addText((t) => {
      t.setPlaceholder("xxxxxxxxxxxxxxxx-xxxxxx").onChange((v) => (value = v));
      t.inputEl.addClass("off-code-input");
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });
    const submit = () => {
      this.close();
      this.onJoin(value);
    };
    new Setting(contentEl).addButton((b) => b.setButtonText("Ask to join").setCta().onClick(submit));
  }
  onClose() {
    this.contentEl.empty();
  }
}

export class ApproveModal extends Modal {
  #answered = false;
  constructor(
    app: App,
    private who: { name: string; address: string },
    private folder: string,
    private answer: (allow: boolean) => void,
  ) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(`${this.who.name} wants to join “${this.folder}”`);
    contentEl.addClass("off-modal");
    const id = contentEl.createDiv({ cls: "off-identity" });
    id.createSpan({ text: "Device identity " });
    id.createEl("code", { text: this.who.address });
    contentEl.createEl("p", {
      text: "Allow only a device you recognise. Once in, it can read and edit every note in this folder, and it gets the folder's keys.",
    });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Deny").onClick(() => this.#reply(false)))
      .addButton((b) => b.setButtonText("Allow").setCta().onClick(() => this.#reply(true)));
  }
  #reply(allow: boolean) {
    this.#answered = true;
    this.answer(allow);
    this.close();
  }
  onClose() {
    if (!this.#answered) this.answer(false);
    this.contentEl.empty();
  }
}

export class RemoveModal extends Modal {
  constructor(
    app: App,
    private who: { name: string; address: string },
    private folder: string,
    private onRemove: () => void,
  ) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(`Remove ${this.who.name} from “${this.folder}”?`);
    contentEl.addClass("off-modal");
    const list = contentEl.createEl("ul");
    list.createEl("li", { text: "Every other device moves to new encryption keys right away (a new MLS epoch)." });
    list.createEl("li", { text: `${this.who.name} (${shortAddress(this.who.address)}) never gets those keys: nothing written from now on can reach it or be read by it.` });
    list.createEl("li", { text: "It keeps the notes it already has, as ordinary files. Removal can't take back what was already shared." });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Remove and rotate keys")
          .setWarning()
          .onClick(() => {
            this.close();
            this.onRemove();
          }),
      );
  }
  onClose() {
    this.contentEl.empty();
  }
}
