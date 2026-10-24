// Copies dist/ into a vault's plugin folder: node scripts/install.mjs <vault>...
import { cpSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const vaults = process.argv.slice(2);
if (vaults.length === 0) {
  console.error("usage: npm run install-plugin -- <vault folder> [<vault folder>...]");
  process.exit(1);
}
for (const vault of vaults) {
  const target = join(resolve(vault), ".obsidian", "plugins", "offline-folders");
  mkdirSync(target, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css", "engine.wasm"]) {
    cpSync(join("dist", file), join(target, file));
  }
  console.log(`installed into ${target}`);
}
