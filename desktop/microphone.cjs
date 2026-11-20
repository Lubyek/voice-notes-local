const { execFile, spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const { join } = require("node:path");

function ownProcess(pid) {
  for (let depth = 0; pid > 1 && depth < 64; depth += 1) {
    if (pid === process.pid) return true;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      return false;
    }
  }
  return false;
}

function muted(node) {
  return node?.info?.params?.Props?.some((properties) => properties.mute === true);
}

function pipeWireCapture(records) {
  const objects = new Map(records.map((record) => [record.id, record]));
  const captures = new Set();
  for (const { type, info } of records) {
    if (type !== "PipeWire:Interface:Link" || info?.state !== "active") continue;
    const input = objects.get(info["input-node-id"]);
    const output = objects.get(info["output-node-id"]);
    if (muted(input) || muted(output)) continue;
    const source = output?.info?.props;
    const stream = input?.info?.props;
    if (!["Audio/Source", "Audio/Source/Virtual"].includes(source?.["media.class"]) ||
        stream?.["media.class"] !== "Stream/Input/Audio") continue;
    const client = objects.get(Number(stream["client.id"]))?.info?.props;
    const pid = Number(stream["application.process.id"] ?? client?.["application.process.id"]);
    if (!ownProcess(pid)) captures.add(String(stream["object.serial"] ?? input.id));
  }
  return captures;
}

function watchPipeWire(report) {
  let pending, timer;
  let closed = false;
  function poll() {
    pending = execFile("pw-dump", [], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (error, data) => {
      if (closed) return;
      let captures = null;
      if (!error) {
        try {
          captures = pipeWireCapture(JSON.parse(data));
        } catch {
          // PipeWire may restart between samples.
        }
      }
      report(captures);
      timer = setTimeout(poll, 350);
    });
  }
  poll();
  return () => {
    closed = true;
    clearTimeout(timer);
    pending?.kill();
  };
}

function watchNative(roots, report, unavailable) {
  const executable = join(roots, process.platform === "win32" ? "mic-windows.exe" : "mic-macos");
  const child = spawn(executable, [String(process.pid)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line === "0") report(new Set());
    else if (line === "1") report(new Set(["native"]));
    else report(null);
  });
  child.stderr.resume();
  child.on("error", unavailable);
  child.on("exit", unavailable);
  return () => {
    lines.close();
    child.kill();
  };
}

function watchBrowserButtons(onChange) {
  if (process.platform !== "linux") return;
  const child = spawn("/usr/bin/python3", [join(__dirname, "native", "mic-browser-linux.py")], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.on("error", () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line === "enabled" || line === "disabled") onChange(line === "enabled");
  });
  return () => {
    lines.close();
    child.kill();
  };
}

function watchMicrophone({ roots, onChange, onError }) {
  let previous = new Set();
  let active = new Set();
  let closed = false;
  let outages = 0;
  function report(sample) {
    if (closed) return;
    if (!sample) {
      previous.clear();
      if (++outages === 4) {
        active.clear();
        onError("Система временно не сообщает состояние микрофона.");
      }
      return;
    }
    // Confirm a new capture twice. A missing stream immediately rearms its next activation.
    const current = new Set([...sample].filter((id) => previous.has(id) || active.has(id)));
    const activated = [...current].some((id) => !active.has(id));
    const deactivated = active.size > 0 && current.size === 0;
    const changed = activated || deactivated || outages >= 4;
    previous = sample;
    active = current;
    outages = 0;
    if (changed) onChange(activated, deactivated);
  }
  const unavailable = () => {
    if (!closed) {
      closed = true;
      onError("Системное обнаружение микрофона недоступно.");
    }
  };
  const stop = process.platform === "linux" ? watchPipeWire(report) : watchNative(roots, report, unavailable);
  return () => {
    closed = true;
    stop();
  };
}

module.exports = { watchBrowserButtons, watchMicrophone };
