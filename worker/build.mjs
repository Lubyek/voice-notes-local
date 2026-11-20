import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWorkerBundleDir, writeRootConfig, writeWorkerConfig } from "@cloudflare/build-output-utils";
import { resolveAndParseConfig } from "@cloudflare/config";
import config from "../cloudflare.config.ts";

const root = process.cwd();
const context = { isPreview: false, mode: undefined };
const result = await resolveAndParseConfig(config, context);
if (!result.success) throw result.error;
const { worker, settings } = result.data;
const mainModule = "transcription.mjs";
const bundle = getWorkerBundleDir(root);
await mkdir(bundle, { recursive: true });
const modules = {
  [mainModule]: { type: "esm" }, "summary.mjs": { type: "esm" },
  "shares.mjs": { type: "esm" }, "share-crypto-source.mjs": { type: "esm" },
  "stt-models.mjs": { type: "esm" },
};
const generated = {
  "share-crypto-source.mjs": JSON.stringify(await readFile("desktop/share-crypto.js", "utf8")),
  "stt-models.mjs": JSON.stringify(JSON.parse(await readFile("docs/models.json", "utf8"))),
};
for (const name of Object.keys(modules)) {
  const source = Object.hasOwn(generated, name) ? "export default " + generated[name] + ";"
    : await readFile(name === mainModule ? worker.entrypoint : join("worker", name), "utf8");
  await writeFile(join(bundle, name), source);
}
await writeRootConfig(root, settings, context);
await writeWorkerConfig({ root, config: worker, manifest: {
  type: "complete",
  mainModule,
  modules,
} });
