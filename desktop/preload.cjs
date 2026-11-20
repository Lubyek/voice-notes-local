const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopMeeting", {
  onState(handler) {
    ipcRenderer.on("meeting:state", (_event, state) => handler(state));
  },
  onControl(state) {
    ipcRenderer.send("meeting:controls", state);
  },
  requestMicrophone() {
    return ipcRenderer.invoke("meeting:permission");
  },
});
