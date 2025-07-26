const {contextBridge, ipcRenderer} = require("electron");

contextBridge.exposeInMainWorld("ytdlp", {
  downloadPlaylist: (playlistURL) => ipcRenderer.invoke("downloadPlaylist", playlistURL),
  removePlaylist: (playlistID) => ipcRenderer.invoke("removePlaylist", playlistID),
  onPlaylistProgress: (callback) => ipcRenderer.on("playlistProgress", (_event, progress) => callback(progress),),
  getPlaylists: () => ipcRenderer.invoke("getPlaylists"),
  getSongs: (playlistId) => ipcRenderer.invoke("getSongs", playlistId),
  swapPlaylists: (playlistID1, playlistID2) => ipcRenderer.invoke("swapPlaylists", playlistID1, playlistID2),
});

contextBridge.exposeInMainWorld("playback", {
  playbackChange: (state) => ipcRenderer.send("playbackChange", state),
  play: (callback) => ipcRenderer.on("play", (_event) => callback()),
  pause: (callback) => ipcRenderer.on("pause", (_event) => callback()),
  previous: (callback) => ipcRenderer.on("previous", (_event) => callback()),
  next: (callback) => ipcRenderer.on("next", (_event) => callback())
});
