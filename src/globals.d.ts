// The SDK's worker, bundled to a string by esbuild.config.mjs.
declare module "engine-worker" {
  const source: string;
  export default source;
}
