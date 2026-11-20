const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { join } = require("node:path");

function watchMicrophone({ roots, onState, onError }) {
  const executable = join(roots, process.platform === "win32" ? "mic-windows.exe" : "mic-macos");
  const child = spawn(executable, [String(process.pid)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  let previous;
  let stable;
  let closed = false;
  let outages = 0;
  lines.on("line", (line) => {
    if (line !== "0" && line !== "1") {
      previous = undefined;
      if (++outages === 4) {
        stable = undefined;
        onError("Система временно не сообщает состояние микрофона.");
      }
      return;
    }
    outages = 0;
    const value = line === "1";
    if (previous === value && stable !== value) {
      stable = value;
      onState(value);
    }
    previous = value;
  });
  // Discard native diagnostics so process information never reaches the UI or service.
  child.stderr.resume();
  const unavailable = () => {
    if (!closed) {
      closed = true;
      onError("Системное обнаружение микрофона недоступно.");
    }
  };
  child.on("error", unavailable);
  child.on("exit", unavailable);
  return () => {
    closed = true;
    lines.close();
    child.kill();
  };
}

module.exports = { watchMicrophone };
