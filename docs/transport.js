const prefix = "voice-notes:transcript:";
const sampleRate = 16_000;
const sampleLimit = 15 * 60 * sampleRate;
let active = null;
let last = null;
export const needsApiKey = true;

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
  const form = new FormData();
  form.set("model", "assemblyai/universal-3-6-pro");
  form.set("file", waveFile(entry.packets, entry.samples), "recording.wav");
  if (entry.language !== "multi") form.set("language", entry.language);
  const response = await fetch("https://api.proxyapi.ru/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: "Bearer " + entry.apiKey }, body: form,
    credentials: "omit", redirect: "error", signal: AbortSignal.timeout(120000),
  });
  if (response.status === 401 || response.status === 403) throw new ApiError("ProxyAPI отклонил ключ или права доступа.");
  if (response.status === 402) throw new ApiError("На балансе ProxyAPI недостаточно средств.");
  if (!response.ok) throw new ApiError(`ProxyAPI вернул ошибку HTTP ${response.status}.`);
  const { text } = await response.json();
  if (typeof text !== "string") throw new ApiError("ProxyAPI вернул ответ без текста.");
  return text.replace(/\s+/g, " ").trim();
}

function snapshot({ packets, apiKey, ...entry }) {
  return entry;
}

async function finish(entry, interrupted) {
  entry.status = "processing";
  entry.progress = "Расшифровываем через AssemblyAI…";
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
    delete entry.apiKey;
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
    if (!json?.apiKey) throw new ApiError("Введи ключ ProxyAPI.");
    if (active) throw new ApiError("Предыдущая запись ещё обрабатывается.");
    active = {
      id: crypto.randomUUID().replaceAll("-", ""), created_at: new Date().toISOString(),
      status: "recording", language: json.language ?? "multi", apiKey: json.apiKey, duration: 0, text: "", samples: 0, packets: [],
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
