// Builds the plugin into dist/: main.js, manifest.json, styles.css and the
// engine module (engine.wasm).
//
// The engine runs in a module worker. Obsidian cannot serve a worker file from
// the plugin folder on its own origin, so the SDK's worker is bundled to a
// string here and started from a Blob URL, and its module is read from
// engine.wasm and handed over at start.
//
// OFFLINE_SDK points at an Offline Protocol SDK checkout whose
// bindings/web/pkg has been built (bash bindings/web/scripts/build.sh).
import esbuild from "esbuild";
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";

const sdk = resolve(process.env.OFFLINE_SDK ?? "../sdk-web-remove-member");
const web = `${sdk}/bindings/web`;
const wasm = `${web}/pkg/offline_protocol_web_bg.wasm`;
if (!existsSync(wasm)) {
  console.error(`no engine module at ${wasm}: run bash bindings/web/scripts/build.sh in the SDK`);
  process.exit(1);
}
// For the type checker: @offline-protocol/web resolves through this link.
rmSync("sdk-path", { force: true });
symlinkSync(`${web}/src`, "sdk-path");

const watch = process.argv.includes("--watch");
mkdirSync("dist", { recursive: true });

async function workerSource() {
  const out = await esbuild.build({
    entryPoints: [`${web}/src/worker.js`],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: !watch,
    write: false,
    logLevel: "warning",
  });
  return out.outputFiles[0].text;
}

const engineWorker = {
  name: "engine-worker",
  setup(build) {
    build.onResolve({ filter: /^engine-worker$/ }, () => ({ path: "engine-worker", namespace: "engine-worker" }));
    build.onLoad({ filter: /.*/, namespace: "engine-worker" }, async () => ({
      contents: await workerSource(),
      loader: "text",
    }));
  },
};

const copyAssets = {
  name: "copy-assets",
  setup(build) {
    build.onEnd(() => {
      copyFileSync("manifest.json", "dist/manifest.json");
      copyFileSync("styles.css", "dist/styles.css");
      copyFileSync(wasm, "dist/engine.wasm");
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  outfile: "dist/main.js",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  alias: { "@offline-protocol/web": `${web}/src/index.js` },
  plugins: [engineWorker, copyAssets],
  // index.js falls back to import.meta.url only when no workerUrl is given;
  // this plugin always gives one.
  logOverride: { "empty-import-meta": "silent" },
  sourcemap: watch ? "inline" : false,
  minify: false,
  logLevel: "info",
});
if (watch) await context.watch();
else {
  await context.rebuild();
  await context.dispose();
}
