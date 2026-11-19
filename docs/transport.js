import { transcriptionEndpoint } from "./service-config.js";

const prefix = "voice-notes:transcript:";
const sampleRate = 16_000;
const sampleLimit = 15 * 60 * sampleRate;
let active = null;
let last = null;

export class ApiError extends Error {}

function waveFile(packets, samples) {
  const header = new DataView(new ArrayBuffer(44));
  const write = (offset, value) => {
    for (let i = 0; i < value.length; i++) header.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, "RIFF");
  header.setUint32(4, 36 + samples * 2, true);
  write(8, "WAVEfmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  write(36, "data");
  header.setUint32(40, samples * 2, true);
  return new Blob([header, ...packets], { type: "audio/wav" });
}

async function transcribe(entry) {
  if (!transcriptionEndpoint) throw new ApiError("Сервер расшифровки ещё не подключён.");
  const url = new URL(transcriptionEndpoint);
  url.searchParams.set("model", entry.model);
  if (entry.language !== "multi") url.searchParams.set("language", entry.language);
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "audio/wav" },
    body: waveFile(entry.packets, entry.samples), credentials: "omit",
    redirect: "error", signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok) throw new ApiError((typeof result.error === "string" ? result.error : result.error?.message) || `Ошибка расшифровки HTTP ${response.status}.`);
  const { text } = result;
  if (typeof text !== "string") throw new ApiError("Сервис расшифровки вернул ответ без текста.");
  return text.replace(/\s+/g, " ").trim();
}

function snapshot({ packets, ...entry }) {
  return entry;
}

async function finish(entry, interrupted) {
  entry.status = "processing";
  entry.progress = "Расшифровываем запись…";
  try {
    if (!interrupted && entry.samples >= sampleRate / 8) entry.text = await transcribe(entry);
    if (entry.text && /[\p{L}\p{N}]$/u.test(entry.text)) entry.text += ".";
    entry.status = interrupted ? "interrupted" : entry.text ? "saved" : "empty";
  } catch (error) {
    entry.status = "interrupted";
    entry.error = error instanceof ApiError ? error.message : "Не удалось получить ответ от ProxyAPI.";
  } finally {
    delete entry.progress;
    delete entry.packets;
  }
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
  if (route === "/state") return { active: active && snapshot(active), last, model: transcriptionEndpoint ? { state: "ready" } : { state: "error", error: "Сервер расшифровки ещё не подключён." } };
  if (route === "/recordings/clear" && method === "POST") {
    if (active) throw new ApiError("Дождись завершения записи.");
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
    last = null;
    return { ok: true };
  }
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
      status: "recording", model: json.model, language: json?.language ?? "multi", duration: 0, text: "", samples: 0, packets: [],
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
