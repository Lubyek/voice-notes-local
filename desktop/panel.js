import { api } from "../docs/transport.js";

const ui = Object.fromEntries([
  "offer", "offer-title", "offer-text", "accept", "offer-stop", "dismiss", "hide", "start", "pause", "resume", "stop", "status", "error",
  "result", "raw", "clean", "clean-title",
].map((id) => [id, document.getElementById(id)]));
const desktop = window.desktopMeeting;
let state = {};
let external = {};
let capture;
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
  const entry = active ?? state.last;
  const status = active?.status;
  const compact = external.compact === true;
  const resuming = external.offered === "resume" && status === "paused";
  const pausing = external.offered === "pause" && status === "recording";
  const starting = external.offered === "start" && !active;
  ui.offer.hidden = !resuming && !pausing && !starting;
  write(ui["offer-title"], pausing ? "Микрофон выключен" : resuming ? "Расшифровка на паузе" : "Микрофон включён");
  write(ui["offer-text"], pausing ? "Поставить запись на паузу?" : resuming ? "Продолжить текущую запись?" : "Начать личную расшифровку?");
  write(ui.accept, pausing ? "Пауза" : resuming ? "Возобновить" : "Транскрибировать");
  ui["offer-stop"].hidden = !resuming && !pausing;
  document.body.classList.toggle("compact", compact);
  document.body.classList.toggle("offering", !ui.offer.hidden);
  ui.start.hidden = Boolean(active) || !ui.offer.hidden || compact;
  ui.pause.hidden = status !== "recording";
  ui.resume.hidden = status !== "paused";
  ui.stop.hidden = status !== "recording" && status !== "paused";
  for (const button of [ui.start, ui.accept, ui["offer-stop"], ui.pause, ui.resume, ui.stop]) button.disabled = switching;
  write(ui.status, switching ? "Переключаем микрофон…"
    : status === "recording" ? (compact ? "Запись · " : "Запись микрофона · ") + formatTime(entry.duration)
    : status === "paused" ? "На паузе · " + formatTime(entry.duration)
    : status === "processing" ? entry.progress
    : entry?.status === "empty" ? "Речь не распознана"
    : entry?.status === "interrupted" ? "Запись прервана"
    : entry?.text ? "Расшифровка завершена" : "Ожидаем активности микрофона");
  const error = pageError || entry?.error || external.watchError || "";
  write(ui.error, error);
  ui.error.title = error;
  ui.error.hidden = !error;
  ui.result.hidden = !entry?.text;
  write(ui.raw, entry?.text ?? "");
  write(ui.clean, entry?.cleaned ?? "");
  ui.clean.hidden = ui["clean-title"].hidden = !entry?.cleaned;
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
    desktop.onControl("recording");
  } catch (error) {
    desktop.onControl("finished");
    throw error;
  }
}

async function pauseRecording(flush = true) {
  await closeMic(flush);
  await action("/" + sessionId + "/pause");
  desktop.onControl("paused");
}

async function resumeRecording() {
  desktop.onControl("resume");
  try {
    await openMic(true);
    desktop.onControl("recording");
  } catch (error) {
    desktop.onControl("paused");
    throw error;
  }
}

async function endRecording(interrupted = false) {
  desktop.onControl("finishing");
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

const offerActions = { start: startRecording, pause: pauseRecording, resume: resumeRecording };
ui.accept.onclick = () => {
  const operation = offerActions[external.offered];
  if (operation) void run(operation);
};
ui.start.onclick = () => run(startRecording);
ui.dismiss.onclick = () => desktop.onControl("dismiss");
ui.hide.onclick = () => desktop.onControl("hide");
ui.pause.onclick = () => run(pauseRecording);
ui.resume.onclick = () => run(resumeRecording);
ui["offer-stop"].onclick = ui.stop.onclick = () => run(endRecording);
desktop.onState((next) => { external = next; render(); });
void poll();
