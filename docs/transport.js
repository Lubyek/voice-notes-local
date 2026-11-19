const prefix = "voice-notes:transcript:";
const sampleRate = 16_000;
const sampleLimit = 15 * 60 * sampleRate;
let active = null;
let last = null;
let worker;

export class ApiError extends Error {}

function transcribe(audio, onProgress) {
  return new Promise((resolve, reject) => {
    worker ??= new Worker(new URL("./whisper-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.progress) onProgress(data.progress);
      else if (data.error) reject(new Error(data.error));
      else resolve(data.text);
    };
    worker.onerror = () => {
      worker.terminate();
      worker = null;
      reject(new Error("Не удалось запустить Whisper в браузере."));
    };
    worker.postMessage(audio, [audio.buffer]);
  });
}

function snapshot({ packets, ...entry }) {
  return entry;
}

async function finish(entry, interrupted) {
  entry.status = "processing";
  const audio = new Float32Array(entry.samples);
  let offset = 0;
  for (const packet of entry.packets) {
    for (let i = 0; i < packet.byteLength; i += 2) audio[offset++] = packet.getInt16(i, true) / 32768;
  }
  delete entry.packets;
  try {
    if (audio.length) entry.text = await transcribe(audio, (progress) => { entry.progress = progress; });
    if (entry.text && /[\p{L}\p{N}]$/u.test(entry.text)) entry.text += ".";
    entry.status = interrupted ? "interrupted" : entry.text ? "saved" : "empty";
  } catch (error) {
    entry.status = "interrupted";
    entry.error = error.message;
  }
  delete entry.progress;
  if (entry.text) {
    try {
      localStorage.setItem(prefix + entry.id, JSON.stringify(entry));
    } catch {
      entry.error = "Текст готов, но браузер не смог сохранить его в историю.";
    }
  }
  last = entry;
  active = null;
}

export async function api(path, { method = "GET", json, body } = {}) {
  const [route, query] = path.split("?");
  if (route === "/state") return { active: active && snapshot(active), last, model: { state: "ready" } };
  if (route === "/recordings") {
    if (method === "GET") {
      const term = (new URLSearchParams(query).get("q") ?? "").toLowerCase();
      const items = Object.keys(localStorage).filter((key) => key.startsWith(prefix))
        .map((key) => JSON.parse(localStorage.getItem(key)))
        .filter((entry) => entry?.text.toLowerCase().includes(term))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((entry) => ({ ...entry, preview: entry.text.slice(0, 150) }));
      return { items };
    }
    if (active) throw new ApiError("Предыдущая запись ещё обрабатывается.");
    active = {
      id: crypto.randomUUID().replaceAll("-", ""), created_at: new Date().toISOString(),
      status: "recording", duration: 0, text: "", samples: 0, packets: [],
    };
    return snapshot(active);
  }

  const [, , id, action, index] = route.split("/");
  if (!action) {
    const entry = active?.id === id ? active : last?.id === id ? last : JSON.parse(localStorage.getItem(prefix + id));
    if (!entry) throw new ApiError("Запись не найдена.");
    return snapshot(entry);
  }
  if (active?.id !== id || active.status !== "recording") return { status: "processing" };
  if (action === "audio") {
    if (Number(index) !== active.packets.length) throw new ApiError("Пропущен фрагмент записи.");
    const samples = Math.min(body.byteLength / 2, sampleLimit - active.samples);
    active.packets.push(new DataView(body, 0, samples * 2));
    active.samples += samples;
    active.duration = active.samples / sampleRate;
    if (active.samples === sampleLimit) void finish(active, false);
  } else if (action === "stop") {
    const entry = active;
    void finish(entry, json?.interrupted);
    return snapshot(entry);
  }
  return { status: active?.status ?? last?.status };
}
