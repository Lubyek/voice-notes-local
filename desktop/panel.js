import { api } from "../docs/transport.js";

const ui = Object.fromEntries([
  "offer", "accept", "dismiss", "start", "pause", "resume", "stop", "status", "error",
  "result", "raw", "clean", "clean-title", "history", "previous",
].map((id) => [id, document.getElementById(id)]));
const desktop = window.desktopMeeting;
const date = new Intl.DateTimeFormat("ru", { dateStyle: "short", timeStyle: "short" });
let state = {};
let external = {};
let capture;
let selected;
let sessionId;
let sequence = 0;
let switching = false;
let pageError = "";

function formatTime(seconds = 0) {
  const minutes = Math.floor(seconds / 60);
  return String(minutes).padStart(2, "0") + ":" + String(Math.floor(seconds % 60)).padStart(2, "0");
}

function write(element, content) {
  if (element.textContent !== content) element.textContent = content;
}

function render() {
  const active = state.active;
  const entry = active ?? selected ?? state.last;
  const status = active?.status;
  ui.offer.hidden = !external.offered || Boolean(active) || switching;
  ui.start.hidden = Boolean(active) || !ui.offer.hidden;
  ui.pause.hidden = status !== "recording";
  ui.resume.hidden = status !== "paused";
  ui.stop.hidden = status !== "recording" && status !== "paused";
  ui.previous.disabled = Boolean(active) || switching;
  for (const button of [ui.start, ui.accept, ui.pause, ui.resume, ui.stop]) button.disabled = switching;
  write(ui.status, switching ? "Переключаем микрофон…"
    : status === "recording" ? "Запись микрофона · " + formatTime(entry.duration)
    : status === "paused" ? "На паузе · " + formatTime(entry.duration)
    : status === "processing" ? entry.progress
    : entry?.status === "empty" ? "Речь не распознана"
    : entry?.status === "interrupted" ? "Запись прервана"
    : entry?.text ? "Расшифровка завершена" : "Ожидаем активности микрофона");
  const error = pageError || entry?.error || external.watchError || "";
  write(ui.error, error);
  ui.error.hidden = !error;
  ui.result.hidden = !entry?.text;
  write(ui.raw, entry?.text ?? "");
  write(ui.clean, entry?.cleaned ?? "");
  ui.clean.hidden = ui["clean-title"].hidden = !entry?.cleaned;
}

async function loadHistory() {
  const { items } = await api("/recordings");
  ui.previous.replaceChildren(new Option("Последняя запись", ""), ...items.map(({ id, preview, created_at }) =>
    new Option(date.format(new Date(created_at)) + " · " + preview, id)));
  ui.history.hidden = !items.length;
}

async function refresh() {
  state = await api("/state");
  if (sessionId && state.active?.id !== sessionId && !switching) {
    try {
      await closeMic(false);
    } finally {
      sessionId = null;
      desktop.onControl("finished");
    }
    await loadHistory();
  } else if (capture && state.active?.status !== "recording" && !switching) {
    await closeMic(false);
  }
  render();
}

function action(path, settings = {}) {
  return api("/recordings" + path, { method: "POST", ...settings });
}

async function openMic(resuming) {
  const context = new AudioContext();
  let stream;
  try {
    await context.resume();
    if (!await desktop.requestMicrophone()) throw new Error("Разреши PeopleDo доступ к микрофону в настройках системы.");
    await context.audioWorklet.addModule(new URL("../docs/capture.js", import.meta.url));
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const node = new AudioWorkletNode(context, "microphone-capture", { channelCount: 1, channelCountMode: "explicit" });
    const sink = context.createGain();
    sink.gain.value = 0;
    const source = context.createMediaStreamSource(stream);
    if (resuming) {
      await action("/" + sessionId + "/resume");
    } else {
      const entry = await action("", { json: { language: "multi" } });
      sessionId = entry.id;
      sequence = 0;
      selected = null;
      ui.previous.value = "";
    }
    const current = { context, stream, node };
    capture = current;
    node.port.onmessage = ({ data }) => {
      if (data === "flushed") current.flushed?.();
      else if (data instanceof ArrayBuffer) {
        void action(`/${sessionId}/audio/${sequence++}`, { body: data }).catch(() => {
          pageError = "Не удалось обработать звук с микрофона.";
          void run(() => endRecording(true));
        });
      }
    };
    const interrupted = () => {
      if (capture !== current) return;
      pageError = "Микрофон недоступен. Подключи его и нажми «Возобновить».";
      void run(() => pauseRecording(false), false);
    };
    node.onprocessorerror = interrupted;
    for (const track of stream.getTracks()) track.addEventListener("ended", interrupted, { once: true });
    source.connect(node).connect(sink).connect(context.destination);
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    await context.close().catch(() => {});
    desktop.onControl("release");
    throw error;
  }
}

async function closeMic(flush = true) {
  const current = capture;
  if (!current) return;
  capture = null;
  current.stream.getTracks().forEach((track) => track.stop());
  if (flush) {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 750);
      current.flushed = () => { clearTimeout(timeout); resolve(); };
      current.node.port.postMessage("flush");
    });
  }
  current.node.port.onmessage = null;
  await current.context.close().catch(() => {});
  desktop.onControl("release");
}

async function startRecording() {
  desktop.onControl("start");
  try {
    await openMic(false);
  } catch (error) {
    desktop.onControl("finished");
    throw error;
  }
}

async function pauseRecording(flush = true) {
  await closeMic(flush);
  await action("/" + sessionId + "/pause");
}

async function endRecording(interrupted = false) {
  await closeMic(!interrupted);
  await action("/" + sessionId + "/stop", { json: { interrupted } });
}

async function run(operation, resetError = true) {
  if (switching) return;
  switching = true;
  if (resetError) pageError = "";
  render();
  try {
    await operation();
  } catch (error) {
    pageError = error.name === "NotAllowedError" ? "Разреши PeopleDo доступ к микрофону." : (error.message || "Действие не удалось.");
  } finally {
    switching = false;
    await refresh();
  }
}

async function poll() {
  try {
    if (!switching) await refresh();
  } finally {
    setTimeout(poll, 250);
  }
}

ui.accept.onclick = ui.start.onclick = () => run(startRecording);
ui.dismiss.onclick = () => desktop.onControl("dismiss");
ui.pause.onclick = () => run(pauseRecording);
ui.resume.onclick = () => run(() => openMic(true));
ui.stop.onclick = () => run(endRecording);
ui.previous.onchange = async () => {
  selected = ui.previous.value ? await api("/recordings/" + ui.previous.value) : null;
  render();
};
desktop.onState((next) => { external = next; render(); });
void loadHistory();
void poll();
