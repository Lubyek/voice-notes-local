import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("Сборка PeopleDo для Omarchy рассчитана на Linux x86_64.");
}

const root = fileURLToPath(new URL("../", import.meta.url));
const electron = process.env.PEOPLEDO_ELECTRON_DIR || "/usr/lib/electron44";
const version = "0.3.1";
const bundle = "PeopleDo-" + version + "-Omarchy-x86_64";
const output = join(root, "desktop-build");
const stage = join(output, bundle);
const resources = join(stage, "runtime", "resources");
const app = join(resources, "app");
const desktopFiles = ["main.cjs", "preload.cjs", "microphone.cjs", "panel.html", "panel.css",
  "panel.js", "local-recordings.js", "summary.js", "workspace.js", "agenda.js", "share-crypto.js", "model-capabilities.js", "native/mic-browser-linux.py"];
const webFiles = ["capture.js", "transport.js", "service-config.js", "models.json"];

await mkdir(stage, { recursive: true });
await cp(electron, join(stage, "runtime"), { recursive: true, dereference: true });
for (const [dir, files] of [["desktop", desktopFiles], ["docs", webFiles]]) {
  for (const file of files) {
    const target = join(app, dir, file);
    await mkdir(join(target, ".."), { recursive: true });
    await cp(join(root, dir, file), target);
  }
}
await writeFile(join(app, "package.json"), JSON.stringify({
  name: "peopledo-transcription", productName: "PeopleDo Transcription",
  version, type: "module", main: "desktop/main.cjs",
}, null, 2) + "\n");
await writeFile(join(stage, "PeopleDo"), `#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")" && pwd -P)"
args=()
if [[ -n "\${DISPLAY:-}" ]]; then args+=(--ozone-platform=x11); fi
exec "$root/runtime/electron" "\${args[@]}" "$@"
`, { mode: 0o755 });
await writeFile(join(stage, "README.txt"), [
  "PeopleDo Transcription " + version,
  "Omarchy / Arch Linux x86_64",
  "",
  "Распакуй архив полностью. Запуск из распакованной папки: ./PeopleDo",
  "Electron включён. Для записи нужен работающий PipeWire / pipewire-pulse,",
  "а для расшифровки и сводки — подключение к интернету.",
  "Архив можно переносить целиком. Текстовая история хранится в профиле приложения.",
  "Исходный звук захватывается только с микрофона и передаётся API для обработки.",
  "",
].join("\n"));

const archVersion = (await readFile(join(stage, "runtime", "version"), "utf8")).trim();
const archive = join(output, bundle + ".tar.zst");
const temporary = archive + ".tmp";
execFileSync("tar", ["--zstd", "-cf", temporary, "-C", output, bundle], { stdio: "inherit" });
await rename(temporary, archive);
console.log("Electron " + archVersion + " · " + archive);
