import { clean, post, transcribeClip } from "../docs/transport.js";
import { formatTranscript } from "./summary.js";
const prefix = "voice-notes:transcript:";
const sampleRate = 16_000;
const minimumSamples = 2_000;
let active;
let last;

function save(entry) {
  localStorage.setItem(prefix + entry.id, JSON.stringify(entry));
}

function read(id) {
  if (active?.id === id) return snapshot(active);
  if (last?.id === id) return last;
  const entry = JSON.parse(localStorage.getItem(prefix + id));
  if (!entry) throw new Error("Запись не найдена.");
  return entry;
}

function snapshot({ audio, ...entry }) {
  return entry;
}

function queueChunk(entry) {
  const audio = entry.audio;
  const { packets, chunkSamples, voiced, samples } = audio;
  Object.assign(audio, { packets: [], chunkSamples: 0, quietSamples: 0, voiced: false });
  if (!voiced || chunkSamples < minimumSamples) return;

  const chunk = { packets, samples: chunkSamples, start: (samples - chunkSamples) / sampleRate };
  if (entry.options.live) recognize(entry, chunk);
  else audio.deferred.push(chunk);
}

function recognize(entry, chunk) {
  const audio = entry.audio;
  audio.submitted += 1;
  audio.queue = audio.queue.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, audio.nextRequest - Date.now())));
    audio.nextRequest = Date.now() + 3_250;
    let result;
    try {
      result = await transcribeClip(chunk.packets, chunk.samples, entry.language, entry.sttModel);
    } catch (error) {
      if (error.status !== 429) throw error;
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      result = await transcribeClip(chunk.packets, chunk.samples, entry.language, entry.sttModel);
    }
    entry.detectedLanguage ||= result.language;
    const segments = result.segments?.length ? result.segments : result.text ? [{
      start: 0, end: chunk.samples / sampleRate, text: result.text,
    }] : [];
    for (const { start, end, text } of segments) {
      entry.segments.push({ start: chunk.start + start, end: chunk.start + end, text });
    }
    entry.text = entry.segments.map(({ text }) => text).join(" ");
  }).catch((error) => {
    audio.failure ||= error.message || "Не удалось распознать часть записи.";
  }).finally(() => {
    audio.completed += 1;
    if (entry.status === "processing") {
      entry.progress = `Распознаём запись · ${audio.completed}/${audio.submitted}`;
    }
  });
}

function collect(entry, buffer) {
  const audio = entry.audio;
  const cap = (entry.kind === "meeting" ? 60 : 15) * 60 * sampleRate;
  const samples = Math.min(buffer.byteLength / 2, cap - audio.samples);
  if (samples <= 0) return;
  const data = new DataView(buffer, 0, samples * 2);
  let energy = 0;
  for (let offset = 0; offset < data.byteLength; offset += 2) energy += data.getInt16(offset, true) ** 2;
  const speech = Math.sqrt(energy / samples) >= 85;
  // Keep the most recent quiet packet as a lead-in, with the absolute recording time.
  if (!audio.voiced && !speech) {
    audio.packets = [];
    audio.chunkSamples = 0;
  }
  audio.packets.push(new Uint8Array(buffer, 0, samples * 2));
  audio.samples += samples;
  audio.chunkSamples += samples;
  audio.voiced ||= speech;
  audio.quietSamples = speech ? 0 : audio.quietSamples + samples;
  entry.duration = audio.samples / sampleRate;
  if ((audio.chunkSamples >= 5 * sampleRate && audio.quietSamples >= sampleRate / 2)
      || audio.chunkSamples >= 8 * sampleRate
      || audio.samples >= cap) queueChunk(entry);
  if (audio.samples >= cap) void finish(entry);
}

async function finish(entry, interrupted) {
  const { audio } = entry;
  entry.status = "processing";
  entry.progress = "Завершаем распознавание речи…";

  if (entry.kind === "meeting" && entry.duration <= 31 && !interrupted) {
    await audio.queue;
    entry.status = "too-short";
    entry.error = "Для сохранения встречи запиши больше 31 секунды.";
    entry.text = "";
    entry.segments = [];
  } else {
    queueChunk(entry);
    for (const chunk of audio.deferred) recognize(entry, chunk);
    audio.deferred = [];
    await audio.queue;
    const finalStatus = interrupted || audio.failure ? "interrupted" : entry.text ? "saved" : "empty";
    if (audio.failure) entry.error = "Часть записи не обработана. " + audio.failure;
    if (entry.text) {
      entry.cleaned = formatTranscript(entry.segments);
      entry.progress = "DeepSeek очищает текст…";
      try { entry.cleaned = await cleanTranscript(entry.text); }
      catch (error) { entry.cleanupError = error.message; }
      if (entry.kind === "meeting" && entry.options.autoSummary) {
        entry.progress = "DeepSeek составляет сводку…";
        try { entry.summary = await requestSummary(entry, entry.options); }
        catch (error) { entry.summaryError = error.message; }
      }
    }
    entry.status = finalStatus;
  }

  delete entry.progress;
  last = snapshot(entry);
  if (entry.text) {
    try { save(last); } catch { last.error = "Не удалось сохранить текст в историю."; }
  }
  active = null;
}

export function recordingState() {
  return { active: active && snapshot(active), last };
}

export async function api(path, { method = "GET", json, body } = {}) {
  const [route, query] = path.split("?");
  if (route === "/recordings" && method === "GET") {
    const term = (new URLSearchParams(query).get("q") ?? "").trim().toLocaleLowerCase();
    const items = Object.keys(localStorage).filter((key) => key.startsWith(prefix))
      .map((key) => JSON.parse(localStorage.getItem(key))).filter(Boolean)
      .filter((entry) => !term || [entry.title, entry.text, entry.cleaned, entry.notes, JSON.stringify(entry.summary ?? "")]
        .some((value) => value?.toLocaleLowerCase().includes(term)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { items };
  }
  if (route === "/recordings") {
    if (active) throw new Error("Текущая запись ещё не завершена.");
    active = {
      id: crypto.randomUUID(), created_at: new Date().toISOString(), status: "recording",
      kind: json.kind, language: json.language, sttModel: json.options.sttModel, options: json.options,
      title: json.title || (json.kind === "meeting" ? "Встреча" : "Личная запись"),
      eventId: json.eventId, notes: "", duration: 0, text: "", segments: [],
      audio: { packets: [], deferred: [], samples: 0, chunkSamples: 0, quietSamples: 0,
        sequence: 0, voiced: false, queue: Promise.resolve(), completed: 0, submitted: 0, nextRequest: 0 },
    };
    return snapshot(active);
  }
  const [, , id, action, sequence] = route.split("/");
  if (!action) return read(id);
  if (action === "edit" || action === "delete") {
    if (active?.id === id) throw new Error("Дождись завершения записи.");
    const entry = read(id);
    if (action === "delete") {
      localStorage.removeItem(prefix + id);
      if (last?.id === id) last = null;
      return;
    }
    const updated = { ...entry, ...json };
    save(updated);
    if (last?.id === id) last = updated;
    return updated;
  }
  if (active?.id !== id) return { status: last?.status };
  if (action === "stop" && ["recording", "paused"].includes(active.status)) {
    void finish(active, json?.interrupted);
  } else if (action === "resume" && active.status === "paused") {
    active.status = "recording";
  } else if (action === "pause" && active.status === "recording") {
    queueChunk(active);
    active.status = "paused";
  } else if (action === "audio" && active.status === "recording") {
    if (!(body instanceof ArrayBuffer) || body.byteLength < 2 || body.byteLength % 2
        || Number(sequence) !== active.audio.sequence) throw new Error("Получен неверный фрагмент микрофона.");
    active.audio.sequence += 1;
    collect(active, body);
  }
  return { status: active?.status ?? last?.status };
}

function splitText(text, size) {
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    const space = rest.lastIndexOf(" ", size);
    const end = space < size / 2 ? size : space;
    parts.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  parts.push(rest);
  return parts;
}

async function cleanTranscript(text) {
  const cleaned = [];
  for (const part of splitText(text, 12_000)) {
    const draft = { text: part };
    await clean(draft);
    cleaned.push(draft.cleaned.trim());
  }
  return cleaned.join("\n\n");
}

export async function requestSummary(entry, options) {
  const text = entry.segments?.length ? entry.segments.map(({ start, text }) =>
    "[" + Math.floor(start) + "s] " + text).join("\n") : entry.text;
  if (!text?.trim()) throw new Error("Для сводки нужна расшифровка.");
  const parts = splitText(text, 14_000);
  const summarize = async (source, interim = false) => {
    const response = await post("/summary", JSON.stringify({ text: source, options, interim }),
      "application/json", 74_000);
    return response.json();
  };
  if (parts.length === 1) return summarize(parts[0]);
  let partial = [];
  for (const part of parts) partial.push(await summarize(part, true));
  while (partial.length > 1 && JSON.stringify(partial).length > 20_000) {
    const consolidated = [];
    for (let i = 0; i < partial.length; i += 2) {
      const pair = JSON.stringify(partial.slice(i, i + 2));
      consolidated.push(await summarize(pair.slice(0, 24_000), true));
    }
    partial = consolidated;
  }
  return summarize(JSON.stringify(partial).slice(0, 24_000));
}
