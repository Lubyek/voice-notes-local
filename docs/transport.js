import { serviceOrigin } from "./service-config.js?v=call";

const desktop = globalThis.location?.protocol === "peopledo:";
const prefix = "voice-notes:transcript:";
const sampleRate = 16_000;
const sampleLimit = 15 * 60 * sampleRate;
const minSamples = sampleRate / 8;
export const supportsCall = true;
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

async function post(path, body, type, timeout) {
  const target = desktop
    ? "peopledo://app/api" + path
    : new URL(path, serviceOrigin);
  const response = await fetch(target, {
    method: "POST", headers: { "Content-Type": type }, body, credentials: "omit",
    redirect: "error", signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new ApiError(result.error || `Ошибка обработки HTTP ${response.status}.`);
  }
  return response;
}

async function transcribe(packets, samples, language) {
  const query = new URLSearchParams({ language });
  const response = await post("/transcribe?" + query, waveFile(packets, samples), "audio/wav", 35_000);
  const { text } = await response.json();
  if (typeof text !== "string") throw new ApiError("Grok STT вернул ответ без текста.");
  return text.trim();
}

async function clean(entry) {
  const response = await post("/cleanup", entry.text, "text/plain;charset=UTF-8", 50_000);
  const stream = response.body.pipeThrough(new TextDecoderStream());
  let buffer = "";
  let stopReason;
  for await (const chunk of stream) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end).trimEnd();
      buffer = buffer.slice(end + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        if (stopReason === "stop" && entry.cleaned?.trim()) return;
        throw new ApiError("DeepSeek не закончил очистку текста.");
      }
      const { choices, error } = JSON.parse(data);
      if (error) throw new ApiError("DeepSeek прервал очистку текста.");
      const choice = choices?.[0];
      if (choice?.delta?.content) entry.cleaned = (entry.cleaned ?? "") + choice.delta.content;
      if (choice?.finish_reason) stopReason = choice.finish_reason;
    }
  }
  if (stopReason !== "stop" || !entry.cleaned?.trim()) {
    throw new ApiError("DeepSeek не закончил очистку текста.");
  }
}

function submit(entry) {
  const { packets, chunkSamples, voiced, fragments } = entry.audio;
  Object.assign(entry.audio, { packets: [], chunkSamples: 0, quietSamples: 0, voiced: false });
  if (!voiced || chunkSamples < minSamples) return;

  const fragment = { done: false };
  fragments.push(fragment);
  fragment.result = transcribe(packets, chunkSamples, entry.language).then(
    (text) => { fragment.text = text; },
    (error) => { fragment.error = error instanceof ApiError ? error.message : "Нет ответа от Grok STT."; },
  ).then(() => {
    fragment.done = true;
    const firstPending = fragments.findIndex((part) => !part.done);
    const ready = firstPending < 0 ? fragments : fragments.slice(0, firstPending);
    entry.text = ready.map((part) => part.text).filter(Boolean).join(" ");
  });
}

function addPacket(entry, buffer) {
  const audio = entry.audio;
  const samples = Math.min(buffer.byteLength / 2, sampleLimit - audio.samples);
  const view = new DataView(buffer, 0, samples * 2);
  let energy = 0;
  for (let offset = 0; offset < view.byteLength; offset += 2) {
    energy += view.getInt16(offset, true) ** 2;
  }
  const speech = Math.sqrt(energy / samples) >= 100;
  // Keep a short lead-in before speech. Prefer a pause, with a cap for continuous speech.
  if (!audio.voiced && !speech) {
    audio.packets = [];
    audio.chunkSamples = 0;
  }
  audio.packets.push(view);
  audio.samples += samples;
  audio.chunkSamples += samples;
  audio.voiced ||= speech;
  audio.quietSamples = speech ? 0 : audio.quietSamples + samples;
  entry.duration = audio.samples / sampleRate;
  if ((audio.chunkSamples >= 3 * sampleRate && audio.quietSamples >= sampleRate / 2)
      || audio.chunkSamples >= 8 * sampleRate) submit(entry);
  if (audio.samples === sampleLimit) void finish(entry, false);
}

function snapshot({ audio, ...entry }) {
  return entry;
}

async function finish(entry, interrupted) {
  entry.status = "processing";
  entry.progress = "Grok STT завершает расшифровку…";
  submit(entry);
  const { fragments } = entry.audio;
  await Promise.all(fragments.map((fragment) => fragment.result));

  const fragmentError = fragments.find((fragment) => fragment.error)?.error;
  entry.status = interrupted || fragmentError ? "interrupted" : entry.text ? "saved" : "empty";
  if (fragmentError) entry.error = "Часть аудио не распознана. " + fragmentError;
  if (entry.status === "saved") {
    entry.status = "processing";
    entry.progress = "DeepSeek очищает текст…";
    try {
      await clean(entry);
      entry.cleaned = entry.cleaned.trim();
    } catch (error) {
      delete entry.cleaned;
      entry.error = error instanceof ApiError ? error.message : "Нет ответа от DeepSeek.";
    }
    entry.status = "saved";
  }

  delete entry.progress;
  delete entry.audio;
  if (entry.text && !desktop) {
    try {
      localStorage.setItem(prefix + entry.id, JSON.stringify(entry));
    } catch {
      const message = "Браузер не смог сохранить текст в историю.";
      entry.error = [entry.error, message].filter(Boolean).join(" ");
    }
  }
  last = entry;
  active = null;
}

export async function api(path, { method = "GET", json, body } = {}) {
  const [route, query] = path.split("?");
  if (route === "/state") return { active: active && snapshot(active), last, model: { state: "ready" } };
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
        .filter((entry) => entry && (entry.text.toLowerCase().includes(term) || entry.cleaned?.toLowerCase().includes(term)))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((entry) => ({ ...entry, preview: (entry.cleaned ?? entry.text).slice(0, 150) }));
      return { items };
    }
    if (active) throw new ApiError("Предыдущая запись ещё обрабатывается.");
    active = {
      id: crypto.randomUUID().replaceAll("-", ""), created_at: new Date().toISOString(),
      status: "recording", language: json?.language ?? "multi", demo: json?.demo === true, duration: 0, text: "",
      audio: { samples: 0, chunkSamples: 0, quietSamples: 0, sequence: 0, voiced: false, packets: [], fragments: [] },
    };
    return snapshot(active);
  }

  const [, , id, action, index] = route.split("/");
  if (!action) {
    const entry = active?.id === id ? active : last?.id === id ? last : JSON.parse(localStorage.getItem(prefix + id));
    if (!entry) throw new ApiError("Запись не найдена.");
    return snapshot(entry);
  }
  if (active?.id !== id) return { status: last?.status ?? "processing" };
  if (active.status === "paused" && action === "resume") {
    active.status = "recording";
    return snapshot(active);
  }
  if (action === "stop" && (active.status === "recording" || active.status === "paused")) {
    void finish(active, json?.interrupted);
    return snapshot(active);
  }
  if (active.status !== "recording") return { status: active.status };
  if (action === "pause") {
    submit(active);
    active.status = "paused";
  } else if (action === "audio") {
    if (Number(index) !== active.audio.sequence) throw new ApiError("Пропущен фрагмент записи.");
    active.audio.sequence += 1;
    addPacket(active, body);
  }
  return { status: active?.status ?? last?.status };
}
