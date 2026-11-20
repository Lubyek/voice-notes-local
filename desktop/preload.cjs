const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopMeeting", {
  onState(handler) {
    ipcRenderer.on("meeting:state", (_event, state) => handler(state));
  },
  onControl(state) {
    ipcRenderer.send("meeting:controls", state);
  },
  onStart(handler) {
    ipcRenderer.on("meeting:start-now", handler);
  },
  setPreferences(settings) {
    ipcRenderer.send("meeting:preferences", settings);
  },
  setSchedule(events) {
    ipcRenderer.send("meeting:schedule", events);
  },
  draftEmail(message) {
    return ipcRenderer.invoke("meeting:email", message);
  },
  copy(text) {
    return ipcRenderer.invoke("meeting:copy", text);
  },
  saveFile(data) {
    return ipcRenderer.invoke("meeting:export", data);
  },
  openLink(url) {
    return ipcRenderer.invoke("meeting:open-link", url);
  },
  requestMicrophone() {
    return ipcRenderer.invoke("meeting:permission");
  },
});
