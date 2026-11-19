import { api, ApiError, needsApiKey } from "./transport.js";

const ui = Object.fromEntries([
  "search", "history", "history-empty", "language", "api-settings", "api-key", "record", "record-state", "error",
  "transcript-meta", "transcript-text", "transcript-empty", "transcript-error", "latest", "copy",
].map((id) => [id, document.getElementById(id)]));

const date = new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
let state;
let capture;
let busy = false;
let selectedId;
let selectedRecording;
let visibleRecording;
let historyVersion;
let historyRequest = 0;
let searchTimer;
let pollTimer;
let pageError = "";
let serverError = "";

function formatTime(seconds) {
  return [Math.floor(seconds / 60), Math.floor(seconds % 60)].map((part) => String(part).padStart(2, "0")).join(":");
}

function renderControls() {
  const active = state?.active;
  const model = state?.model;
  const recording = active?.status === "recording";
  ui.language.disabled = busy || Boolean(active || capture);
  ui["api-key"].disabled = ui.language.disabled;
  const missingKey = needsApiKey && !ui["api-key"].value.trim();
  ui.record.disabled = !state || busy || (capture
    ? capture.stopping || !recording
    : Boolean(active) || missingKey || model?.state !== "ready");
  ui.record.classList.toggle("is-recording", Boolean(capture));
  ui.record.querySelector("span").textContent = capture ? "Остановить" : "Начать запись";

  let status = "Готово к записи";
  if (!state) status = "Подключение…";
  else if (busy) status = "Подключение микрофона…";
  else if (capture?.stopping || active?.status === "processing") status = active?.progress || "Завершаем расшифровку…";
  else if (recording) status = "Идёт запись · " + formatTime(active.duration);
  else if (missingKey) status = "Введи ключ ProxyAPI";
  else if (model?.state === "error") status = "Распознавание недоступно";
  ui["record-state"].textContent = status;

  const error = pageError || serverError || model?.error || "";
  ui.error.hidden = !error;
  ui.error.textContent = error;
}

function highlightHistory() {
  const id = selectedId ?? visibleRecording?.id;
  for (const button of ui.history.querySelectorAll("button")) {
    if (button.dataset.id === id) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}

function renderTranscript() {
  const current = state?.active ?? state?.last;
  const entry = selectedId ? selectedRecording : current;
  visibleRecording = entry;
  const text = entry?.text ?? "";
  if (ui["transcript-text"].textContent !== text) {
    ui["transcript-text"].textContent = text;
    ui.copy.textContent = "Копировать текст";
  }
  ui["transcript-text"].hidden = !text;
  ui["transcript-empty"].hidden = Boolean(text);
  ui["transcript-empty"].textContent = ({
    recording: "Слушаю…",
    processing: "Расшифровываем запись…",
    empty: "Речь не распознана.",
    interrupted: "Расшифровка прервалась.",
  })[entry?.status] ?? "Здесь появится текст записи.";
  ui["transcript-meta"].hidden = !entry;
  if (entry) {
    ui["transcript-meta"].textContent = `${date.format(new Date(entry.created_at))} · ${formatTime(entry.duration)}`;
  }
  ui["transcript-error"].hidden = !entry?.error;
  ui["transcript-error"].textContent = entry?.error ?? "";
  ui.latest.hidden = !selectedId;
  ui.copy.hidden = !text;
  highlightHistory();
}

async function loadHistory() {
  const request = ++historyRequest;
  const query = ui.search.value.trim();
  const result = await api("/recordings?" + new URLSearchParams({ q: query }));
  if (request !== historyRequest) return;
  const list = document.createDocumentFragment();
  for (const item of result.items) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    const preview = document.createElement("strong");
    const meta = document.createElement("small");
    button.type = "button";
    button.dataset.id = item.id;
    preview.textContent = item.preview;
    meta.textContent = `${date.format(new Date(item.created_at))} · ${formatTime(item.duration)}`;
    button.append(preview, meta);
    li.append(button);
    list.append(li);
  }
  ui.history.replaceChildren(list);
  ui["history-empty"].hidden = Boolean(result.items.length);
  ui["history-empty"].textContent = query ? "Совпадений нет." : "История пока пуста.";
  highlightHistory();
}

async function poll() {
  const previousCapture = capture;
  try {
    const next = await api("/state");
    state = next;
    serverError = "";
    if (capture && capture === previousCapture && !capture.stopping
        && (state.active?.id !== capture.id || state.active?.status !== "recording")) {
      await stopCapture(capture, { sendStop: false });
    }
    renderTranscript();
    if (historyVersion !== (state.last?.id ?? "")) {
      await loadHistory();
      historyVersion = state.last?.id ?? "";
    }
  } catch {
    serverError = "Не удалось загрузить состояние приложения.";
  } finally {
    renderControls();
    pollTimer = setTimeout(poll, state?.active ? 450 : 1000);
  }
}

function readable(error) {
  if (error.name === "NotAllowedError") return "Разреши доступ к микрофону в браузере.";
  if (error.name === "NotFoundError") return "Микрофон не найден.";
  if (error.name === "NotReadableError") return "Браузер не смог открыть микрофон.";
  return error.message || "Действие не удалось.";
}

async function openCapture() {
  if (busy || capture || ui.record.disabled) return;
  busy = true;
  pageError = "";
  renderControls();
  let stream;
  let context;
  let entry;
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      throw new Error("Открой приложение в современном браузере через HTTPS или localhost.");
    }
    context = new AudioContext();
    await context.resume();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    await context.audioWorklet.addModule(new URL("./capture.js", import.meta.url));
    const mic = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "microphone-capture", { channelCount: 1, channelCountMode: "explicit" });
    const sink = context.createGain();
    sink.gain.value = 0;
    entry = await api("/recordings", { method: "POST", json: { language: ui.language.value, ...(needsApiKey && { apiKey: ui["api-key"].value.trim() }) } });
    const current = {
      id: entry.id, stream, context, node, queue: Promise.resolve(),
      sequence: 0, inFlight: 0, stopping: false, failed: false,
    };
    capture = current;
    node.port.onmessage = ({ data }) => {
      if (data === "flushed") current.onFlushed?.();
      else if (data instanceof ArrayBuffer) enqueue(current, data);
    };
    node.onprocessorerror = () => {
      pageError = "Захват аудио прервался.";
      void stopCapture(current, { interrupted: true });
    };
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => stopCapture(current, { interrupted: true }), { once: true });
    }
    mic.connect(node).connect(sink).connect(context.destination);
    selectedId = selectedRecording = null;
    state.active = entry;
    renderTranscript();
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    if (context) await context.close().catch(() => {});
    if (entry) {
      capture = null;
      await api(`/recordings/${entry.id}/stop`, { method: "POST", json: { interrupted: true } }).catch(() => {});
    }
    pageError = readable(error);
  } finally {
    busy = false;
    renderControls();
  }
}

function enqueue(current, buffer) {
  if (current.failed) return;
  if (current.inFlight >= 24) {
    current.failed = true;
    pageError = "Не удалось обработать аудио.";
    void stopCapture(current, { interrupted: true });
    return;
  }

  current.inFlight += 1;
  const path = `/recordings/${current.id}/audio/${current.sequence++}`;
  current.queue = current.queue.then(async () => {
    if (current.failed) return;
    const options = { method: "POST", body: buffer };
    let result;
    try {
      result = await api(path, { ...options, signal: AbortSignal.timeout(2500) });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      result = await api(path, { ...options, signal: AbortSignal.timeout(2500) });
    }
    if (result.status !== "recording") void stopCapture(current, { sendStop: false });
  }).catch((error) => {
    current.failed = true;
    pageError = readable(error);
    void stopCapture(current, { interrupted: true });
  }).finally(() => { current.inFlight -= 1; });
}

async function stopCapture(current, { interrupted = false, sendStop = true } = {}) {
  if (current.stopping) return;
  current.stopping = true;
  current.stream.getTracks().forEach((track) => track.stop());
  renderControls();
  if (sendStop && !current.failed) {
    const flushed = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 1200);
      current.onFlushed = () => { clearTimeout(timeout); resolve(true); };
      current.node.port.postMessage("flush");
    });
    interrupted ||= !flushed;
  }
  current.node.port.onmessage = null;
  await current.context.close().catch(() => {});
  await current.queue;
  if (sendStop) {
    try {
      const entry = await api(`/recordings/${current.id}/stop`, {
        method: "POST", json: { interrupted: interrupted || current.failed },
      });
      if (state?.active?.id === current.id) state.active = entry;
    } catch (error) {
      pageError = readable(error);
    }
  }
  if (capture === current) capture = null;
  renderTranscript();
  renderControls();
}

async function showRecording(id) {
  selectedId = id;
  pageError = "";
  try {
    const entry = await api(`/recordings/${id}`);
    if (selectedId === id) {
      selectedRecording = entry;
      renderTranscript();
    }
  } catch (error) {
    if (selectedId === id) {
      selectedId = selectedRecording = null;
      pageError = readable(error);
      renderTranscript();
    }
  }
  renderControls();
}

ui["api-settings"].hidden = !needsApiKey;
ui["api-key"].addEventListener("input", renderControls);
ui.record.addEventListener("click", () => capture ? stopCapture(capture) : openCapture());
ui.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  historyRequest += 1;
  searchTimer = setTimeout(() => {
    void loadHistory().catch((error) => {
      pageError = readable(error);
      renderControls();
    });
  }, 150);
});
ui.history.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button) void showRecording(button.dataset.id);
});
ui.latest.addEventListener("click", () => {
  selectedId = selectedRecording = null;
  renderTranscript();
});
ui.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(visibleRecording?.text ?? "");
    ui.copy.textContent = "Скопировано";
  } catch (error) {
    pageError = readable(error);
    renderControls();
  }
});
window.addEventListener("pagehide", () => {
  clearTimeout(pollTimer);
  if (!capture) return;
  capture.stream.getTracks().forEach((track) => track.stop());
  void api(`/recordings/${capture.id}/stop`, {
    method: "POST", json: { interrupted: true }, keepalive: true,
  }).catch(() => {});
});
window.addEventListener("pageshow", ({ persisted }) => { if (persisted) location.reload(); });

void poll();
const linkId = new URLSearchParams(location.search).get("note");
if (linkId && /^[a-f0-9]{32}$/.test(linkId)) void showRecording(linkId);
