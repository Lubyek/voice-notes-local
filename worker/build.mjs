import { copyFile, mkdir } from "node:fs/promises";
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
await copyFile(worker.entrypoint, join(bundle, mainModule));
await writeRootConfig(root, settings, context);
await writeWorkerConfig({ root, config: worker, manifest: {
  type: "complete",
  mainModule,
  modules: { [mainModule]: { type: "esm" } },
} });
