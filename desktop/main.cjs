const { app, BrowserWindow, ipcMain, Menu, net, nativeImage, protocol, screen, session, systemPreferences, Tray } = require("electron");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { watchBrowserButtons, watchMicrophone } = require("./microphone.cjs");

const appOrigin = "peopledo://app";
const panelURL = appOrigin + "/desktop/panel.html";
const panelTitle = "PeopleDo · Расшифровка";
const offerTitle = "PeopleDo · Запрос расшифровки";
const files = new Set([
  "/desktop/panel.html", "/desktop/panel.js", "/desktop/panel.css", "/docs/capture.js",
  "/docs/transport.js", "/docs/service-config.js",
]);
const mac = process.platform === "darwin";
const trayIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">' +
  (mac ? "" : '<rect width="20" height="20" rx="5" fill="#146641"/>') +
  '<path fill="' + (mac ? "black" : "white") + '" d="M4 8h2.5v4H4zm4.75-4h2.5v12h-2.5zm4.75 2h2.5v8h-2.5z"/></svg>';
const policy = "default-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'";

let window, tray, monitor, browserButtons;
let ready = false, offered = null, compactWindow = false, offerOpenedWindow = false;
let recording = "idle", micAuthorized = false, watchError = "";
protocol.registerSchemesAsPrivileged([{
  scheme: "peopledo", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

function placePanel(compact = false) {
  const { x, y, width } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const size = Math.min(compact ? 260 : 428, width - 36);
  window.setBounds({ x: x + width - size - 18, y: y + 18, width: size, height: compact ? 100 : 410 });
}

function reveal(focus) {
  if (!ready) return;
  if (focus) {
    compactWindow = false;
    offerOpenedWindow = false;
    window.setTitle(panelTitle);
    placePanel();
    sendState();
    window.show();
    window.focus();
  } else if (!window.isVisible()) {
    compactWindow = true;
    offerOpenedWindow = true;
    window.setTitle(offerTitle);
    placePanel(true);
    sendState();
    window.showInactive();
  }
}

function dismissOffer() {
  if (offerOpenedWindow) {
    window.hide();
    compactWindow = false;
  }
  offerOpenedWindow = false;
  offered = null;
}

function sendState() {
  if (ready) window.webContents.send("meeting:state", { offered, compact: compactWindow, watchError });
}

function offerTranscription(action) {
  offered = action;
  if (window.isVisible()) sendState();
  else reveal(false);
}

function microphoneChanged(enabled) {
  if (!enabled && recording === "recording") {
    offerTranscription("pause");
    return;
  }
  if (!enabled) return;
  if (recording === "idle" || recording === "paused") {
    offerTranscription(recording === "paused" ? "resume" : "start");
  } else if (offered === "pause") {
    dismissOffer();
    sendState();
  }
}

async function readBody(request, maxBytes) {
  if (!request.body) return null;
  const chunks = [];
  let length = 0;
  for await (const chunk of request.body) {
    length += chunk.byteLength;
    if (length > maxBytes) return null;
    chunks.push(chunk);
  }
  return length ? Buffer.concat(chunks, length) : null;
}

async function registerProtocol() {
  const config = await import(pathToFileURL(join(app.getAppPath(), "docs/service-config.js")).href);
  protocol.handle("peopledo", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response(null, { status: 404 });
    if (request.method === "GET" && files.has(url.pathname)) {
      const file = await net.fetch(pathToFileURL(join(app.getAppPath(), url.pathname)).href);
      const headers = new Headers(file.headers);
      headers.set("Content-Security-Policy", policy);
      if (url.pathname.endsWith(".js")) headers.set("Content-Type", "text/javascript; charset=utf-8");
      return new Response(file.body, { status: file.status, headers });
    }

    const transcribe = url.pathname === "/api/transcribe";
    if (request.method !== "POST" || (!transcribe && url.pathname !== "/api/cleanup")) {
      return new Response(null, { status: 404 });
    }
    if (request.initiatorOrigin && request.initiatorOrigin !== appOrigin) {
      return new Response(null, { status: 403 });
    }
    const type = request.headers.get("Content-Type")?.split(";")[0];
    if (type !== (transcribe ? "audio/wav" : "text/plain")) return new Response(null, { status: 415 });
    const body = await readBody(request, transcribe ? 320_044 : 80_000);
    if (!body) return new Response(null, { status: 400 });
    const target = new URL(transcribe ? "/transcribe" : "/cleanup", config.serviceOrigin);
    if (transcribe) target.searchParams.set("language", url.searchParams.get("language") || "multi");
    try {
      const upstream = await fetch(target, {
        method: "POST", body, redirect: "error",
        headers: { Origin: "https://lubyek.github.io", "Content-Type": type },
        signal: AbortSignal.timeout(transcribe ? 32_000 : 47_000),
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json", "Cache-Control": "no-store" },
      });
    } catch {
      return Response.json({ error: "Сервис расшифровки недоступен." }, { status: 502 });
    }
  });
}

function registerPermissions() {
  const mayUseMic = (contents, permission) =>
    micAuthorized && contents === window?.webContents && contents.getURL() === panelURL && permission === "media";
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) =>
    mayUseMic(contents, permission) && origin === appOrigin && details.mediaType === "audio");
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(mayUseMic(contents, permission) && details.mediaTypes?.length === 1 && details.mediaTypes[0] === "audio"));
  ipcMain.handle("meeting:permission", async ({ sender }) => {
    if (sender !== window?.webContents) return false;
    micAuthorized = process.platform !== "darwin" || await systemPreferences.askForMediaAccess("microphone");
    return micAuthorized;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => reveal(true));
  app.on("will-quit", () => {
    monitor?.();
    browserButtons?.();
  });
  app.whenReady().then(async () => {
    await registerProtocol();
    registerPermissions();
    if (mac) app.dock.hide();
    window = new BrowserWindow({
      width: 428, height: 410, minWidth: 250, minHeight: 100, show: false, resizable: false,
      frame: false, transparent: true, title: panelTitle, skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true,
        backgroundThrottling: false, nodeIntegration: false,
      },
    });
    window.setAlwaysOnTop(true, "floating");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.on("page-title-updated", (event) => event.preventDefault());
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("render-process-gone", () => {
      recording = "idle";
      micAuthorized = false;
      app.quit();
    });
    window.on("close", (event) => {
      if (app.quitting) return;
      event.preventDefault();
      dismissOffer();
      sendState();
      window.hide();
    });
    app.on("before-quit", () => { app.quitting = true; });
    ipcMain.on("meeting:controls", ({ sender }, state) => {
      if (sender !== window.webContents) return;
      if (state === "hide") window.close();
      if (state === "dismiss") {
        dismissOffer();
        sendState();
      }
      if (state === "start" || state === "resume" || state === "finishing") {
        recording = state === "finishing" ? "finishing" : "starting";
        offerOpenedWindow = false;
        offered = null;
        sendState();
      }
      if (state === "recording" || state === "paused") {
        recording = state;
        offerOpenedWindow = false;
        offered = null;
        sendState();
      }
      if (state === "finished") {
        recording = "idle";
        if (compactWindow && window.isVisible()) {
          compactWindow = false;
          window.setTitle(panelTitle);
          placePanel();
          sendState();
        }
      }
      if (state === "finished" || state === "release") micAuthorized = false;
    });

    const icon = nativeImage.createFromDataURL("data:image/svg+xml;base64," + Buffer.from(trayIcon).toString("base64"));
    if (mac) icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip("PeopleDo · Расшифровка");
    const menu = Menu.buildFromTemplate([
      { label: "Открыть расшифровку", click: () => reveal(true) },
      { label: "Выйти из PeopleDo", click: () => recording === "idle" ? app.quit() : reveal(true) },
    ]);
    tray.setContextMenu(menu);
    tray.on("click", () => reveal(true));
    await window.loadURL(panelURL);
    ready = true;
    browserButtons = watchBrowserButtons(microphoneChanged);

    monitor = watchMicrophone({
      roots: app.isPackaged ? process.resourcesPath : join(__dirname, "bin"),
      onChange(activated, deactivated) {
        watchError = "";
        if (activated || deactivated) microphoneChanged(activated);
        sendState();
      },
      onError(message) {
        watchError = message;
        dismissOffer();
        sendState();
      },
    });
  }).catch((error) => {
    console.error("PeopleDo desktop failed to start:", error.message);
    app.exit(1);
  });
}
