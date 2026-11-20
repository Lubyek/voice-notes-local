import { cp, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const arch = process.argv[2] || process.arch;
const { platform } = process;
if (!["darwin", "win32"].includes(platform)) throw new Error("Собирай на macOS или Windows.");
if (!["x64", "arm64"].includes(arch) || (platform === "win32" && arch !== process.arch)) {
  throw new Error("Неподдерживаемая архитектура сборки.");
}
const output = resolve(root, "desktop-build", platform + "-" + arch);
const sources = join(output, "sources");
const native = join(output, "native");
const call = (tool, args, options = {}) => execFileSync(tool, args, {
  cwd: root, stdio: "inherit", ...options,
});
const mac = platform === "darwin";
await mkdir(native, { recursive: true });
await mkdir(join(sources, "desktop"), { recursive: true });
await mkdir(join(sources, "docs"), { recursive: true });

const helper = join(native, mac ? "mic-macos" : "mic-windows.exe");
if (mac) {
  call("xcrun", ["clang", "-Wall", "-Wextra", "-O2", "-arch", arch === "x64" ? "x86_64" : "arm64",
    "-mmacosx-version-min=14.2", "-framework", "CoreAudio", join(root, "desktop/native/mic-macos.c"), "-o", helper]);
} else {
  call("cl.exe", ["/nologo", "/std:c++17", "/EHsc", "/W4", "/O2", "/MT", join(root, "desktop/native/mic-windows.cpp"),
    "/Fo:" + join(native, "mic-windows.obj"), "/Fe:" + helper, "ole32.lib", "uuid.lib"], { cwd: native });
}

const desktopFiles = ["main.cjs", "preload.cjs", "microphone.cjs", "panel.html", "panel.css", "panel.js"];
const webFiles = ["capture.js", "transport.js", "service-config.js"];
for (const [directory, files] of [["desktop", desktopFiles], ["docs", webFiles]]) {
  await Promise.all(files.map((name) => cp(join(root, directory, name), join(sources, directory, name))));
}
await writeFile(join(sources, "package.json"), JSON.stringify({
  name: "peopledo-transcription", productName: "PeopleDo Transcription", version: "0.1.0",
  type: "module", main: "desktop/main.cjs",
}));

const name = "PeopleDo Transcription";
const args = [
  "--yes", "--package=@electron/packager@20.3.0", "--", "electron-packager", sources, name,
  "--platform=" + platform, "--arch=" + arch, "--electron-version=44.11.5", "--out=" + output,
  "--extra-resource=" + helper, "--asar", "--overwrite", "--app-bundle-id=do.ppl.transcription",
];
if (mac) args.push("--extend-info=" + join(root, "desktop/Info.plist"));
if (mac) {
  call("npx", args);
  const bundle = join(output, name + "-" + platform + "-" + arch, name + ".app");
  call("codesign", ["--force", "--deep", "--sign", "-", bundle]);
  call("codesign", ["--verify", "--deep", "--strict", bundle]);
  const info = join(bundle, "Contents/Info.plist");
  call("/usr/libexec/PlistBuddy", ["-c", "Print :NSMicrophoneUsageDescription", info]);
  call("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", bundle, join(output, "PeopleDo-macOS-" + arch + ".zip")]);
} else {
  // Windows requires the .cmd launcher to be run by cmd.exe.
  const command = ['npx.cmd', ...args.map((arg) => '"' + arg.replaceAll('"', '""') + '"')].join(" ");
  call("cmd.exe", ["/d", "/s", "/c", '"' + command + '"'], { windowsVerbatimArguments: true });
  const dirname = name + "-" + platform + "-" + arch;
  call("tar.exe", ["-a", "-cf", join(output, "PeopleDo-Windows-" + arch + ".zip"), "-C", output, dirname]);
}
