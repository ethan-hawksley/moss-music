const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const child_process = require("node:child_process");
const {pid} = require("node:process");
const sqlite3 = require("sqlite3").verbose();

let DATA_DIRECTORY;
if (process.platform === "linux") {
  DATA_DIRECTORY = path.join(
    app.getPath("home"),
    ".local",
    "share",
    "moss-music",
  );
} else {
  DATA_DIRECTORY = app.getPath("userData");
}
if (!fs.existsSync(DATA_DIRECTORY))
  fs.mkdirSync(DATA_DIRECTORY, {recursive: true});
console.log(DATA_DIRECTORY);
const DB_PATH = path.join(DATA_DIRECTORY, "database.db");
const SONG_DIRECTORY = path.join(DATA_DIRECTORY, "songs");
const SONG_FILE_DIRECTORY = path.join(DATA_DIRECTORY, "files");
let mainWindow;
let tray;

// Database initialization
let db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error("Error opening database:", err.message);
  else console.log("Connected to SQLite database.");
});

//@formatter:off
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        position INTEGER NOT NULL
    )`);

  db.run(`CREATE TABLE IF NOT EXISTS songs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        channel TEXT NOT NULL
    )`);

  db.run(`CREATE TABLE IF NOT EXISTS playlist_songs (
        playlist_id TEXT,
        song_id TEXT,
        position INTEGER,
        FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE,
        FOREIGN KEY (song_id) REFERENCES songs (id) ON DELETE CASCADE,
        PRIMARY KEY (playlist_id, song_id)
    )`);
  //@formatter:on
});

// Database functions
const getPlaylists = () =>
  new Promise((resolve, reject) => {
    db.all(
      `SELECT id, title, position
            FROM playlists
            ORDER BY position`,
      (err, rows) => {
        if (err) return reject("Error fetching playlists");
        resolve(
          rows.map((row) => ({
            id: row.id,
            title: row.title,
            position: row.position,
          })),
        );
      },
    );
  });

const getPlaylistData = (id) =>
  new Promise((resolve, reject) => {
    db.all(
      `SELECT id, title, position
            FROM playlists
            WHERE id = ?`,
      [id],
      (err, rows) => {
        if (err) return reject("Error getting data of playlist");
        resolve(
          rows.map((row) => ({
            id: row.id,
            title: row.title,
            position: row.position,
          }))[0],
        );
      },
    );
  });

const getHighestPlaylistPosition = () =>
  new Promise((resolve, reject) => {
    db.all("SELECT MAX(position) as position FROM playlists", (err, rows) => {
      if (err) return reject("Error fetching max position");
      if (rows[0].position === null) {
        resolve(-1);
      } else {
        resolve(rows[0].position);
      }
    });
  });

const getSongs = (playlistId) =>
  new Promise((resolve, reject) => {
    db.all(
      `SELECT songs.id, songs.title, songs.path, songs.channel, playlist_songs.position
            FROM songs
                     JOIN
                 playlist_songs
                 ON
                     songs.id = playlist_songs.song_id
            WHERE playlist_songs.playlist_id = ?
            ORDER BY playlist_songs.position`,
      [playlistId],
      (err, rows) => {
        if (err) return reject("Error fetching songs");
        resolve(rows);
      },
    );
  });

const parseM3UFile = (filePath) => {
  return new Promise((resolve, reject) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");

      let playlistData = {
        id: path.basename(filePath),
        title: path.basename(filePath, ".m3u"),
        songs: [],
      };

      let currentSong = null;

      lines.forEach((line) => {
        line = line.trim();
        if (line === "" || line.startsWith("#EXTM3U")) return;

        if (line.startsWith("#EXTINF:")) {
          const match = line.match(/#EXTINF:(-?\d+),(.+)/);
          if (match) {
            currentSong = {
              title: match[2],
              channel: "file",
            };
          }
        } else if (!line.startsWith("#")) {
          // This is a file path
          const songPath = path.resolve(path.dirname(filePath), line);
          if (currentSong) {
            currentSong.id = path.basename(songPath);
            currentSong.path = songPath;
            playlistData.songs.push(currentSong);
          } else {
            // If no EXTINF was found, use filename as title
            playlistData.songs.push({
              id: path.basename(songPath),
              title: path.basename(songPath),
              path: songPath,
              channel: "file",
            });
          }
          currentSong = null;
        }
      });

      if (playlistData.songs.length === 0) {
        reject("No valid songs found in M3U file");
      } else {
        resolve(playlistData);
      }
    } catch (error) {
      console.error("M3U parse error:", error);
      reject(`Failed to parse M3U file: ${error.message}`);
    }
  });
};

const swapPlaylists = (playlistId1, playlistId2) =>
  new Promise(async (resolve) => {
    const playlistData = await getPlaylists();
    const playlist1Position = playlistData.find(
      (element) => element.id === playlistId1,
    ).position;
    const playlist2Position = playlistData.find(
      (element) => element.id === playlistId2,
    ).position;
    const updatePlaylist1Position = new Promise((resolve, reject) => {
      db.run(
        `UPDATE playlists
                SET position = ?
                WHERE id = ?`,
        [playlist2Position, playlistId1],
        (err) => {
          if (err) return reject(err);
          resolve();
        },
      );
    });

    const updatePlaylist2Position = new Promise((resolve, reject) => {
      db.run(
        `UPDATE playlists
                SET position = ?
                WHERE id = ?`,
        [playlist1Position, playlistId2],
        (err) => {
          if (err) return reject(err);
          resolve();
        },
      );
    });
    await Promise.all([updatePlaylist1Position, updatePlaylist2Position]);
    resolve("ok");
  });

const deleteUnreferencedSongs = () => {
  db.all(
    "SELECT id, path FROM songs WHERE id NOT IN (SELECT song_id FROM playlist_songs)",
    (err, rows) => {
      if (err)
        return console.error("Error fetching unreferenced songs:", err.message);
      rows.forEach((row) => {
        if (row.path.includes(SONG_DIRECTORY)) {
          fs.unlink(row.path, (err) => {
            if (err) console.error("Error deleting song file", err.message);
            else console.log("Deleted song file:", row.path);
          });
        }
        db.run(
          "DELETE FROM songs WHERE id NOT IN (SELECT song_id FROM playlist_songs)",
          (err) => {
            if (err)
              console.error(
                "Error deleting unreferenced songs from database:",
                err.message,
              );
            else console.log("Deleted unreferenced songs from database");
          },
        );
      });
    },
  );
};

// Playlist functions
const fetchPlaylistData = (playlistURL) =>
  new Promise((resolve, reject) => {
    let output = "";
    let command = child_process.spawn("yt-dlp", [
      "-J",
      "--flat-playlist",
      "--no-warnings",
      playlistURL,
    ]);

    command.stdout.on("data", (data) => (output += data.toString()));

    command.stderr.on("data", (data) => {
      console.error("yt-dlp error:", data.toString());
      output += data.toString();
    });

    command.on("close", (code) => {
      // Check exit code
      if (code !== 0) {
        console.error(`yt-dlp exited with code ${code}`);
        return reject(`yt-dlp failed with code ${code}`);
      }

      try {
        // Validate output exists
        if (!output || output.trim() === "") {
          return reject("No output from yt-dlp");
        }

        const jsonLine = JSON.parse(output);

        // Validate required fields exist
        if (!jsonLine || !jsonLine.id || !jsonLine.title || !jsonLine.entries) {
          return reject("Invalid playlist data format");
        }

        // Validate entries exist
        if (!Array.isArray(jsonLine.entries) || jsonLine.entries.length === 0) {
          return reject("Playlist has no entries");
        }

        let playlistData = {
          id: jsonLine.id,
          title: jsonLine.title.replace(/^Album - /, ""),
          songs: jsonLine.entries.map((rawSong) => ({
            id: rawSong.id,
            title: rawSong.title
              .replace(/^\d+\.\s*/, "") // Remove leading track number
              .replace(
                /^.*?(?:OST|Soundtrack|Remaster|Acoustic)\s*(?:\([^)]*\))?\s*-\s*/i,
                "",
              ) // Remove OST/Soundtrack prefixes with optional parentheticals
              .replace(/\s*\([^)]*(?:Soundtrack|OST|Chapter)[^)]*\)/gi, "") // Remove soundtrack-related parentheticals
              .replace(/\s*-\s*[^-]*$/, "") // Remove trailing artist after dash
              .trim(),
            path: "",
            channel: rawSong.channel?.replace(/ - Topic$/, "") || "unknown",
          })),
        };

        // Handle description JSON
        let descriptionJson = [];
        try {
          if (jsonLine.description) {
            descriptionJson = JSON.parse(jsonLine.description);
          }
        } catch (e) {
          console.error(`Error parsing description JSON: ${e}`);
        }

        // Add file songs from description
        if (Array.isArray(descriptionJson)) {
          descriptionJson.forEach((song) => {
            if (song && song.position && song.path && song.title) {
              playlistData.songs.splice(song.position - 1, 0, {
                id: song.path,
                title: song.title,
                path: path.join(SONG_FILE_DIRECTORY, song.path),
                channel: "file",
              });
            }
          });
        }

        resolve(playlistData);
      } catch (e) {
        console.error(`Error parsing JSON: ${e}`);
        // Log problematic output for debugging
        fs.writeFileSync(
          path.join(app.getPath("documents"), "yt-dlp-error.log"),
          output,
        );
        reject(`Failed to parse playlist data: ${e.message}`);
      }
    });

    // Handle spawn errors
    command.on("error", (err) => {
      console.error("Failed to start yt-dlp:", err);
      reject(`Failed to start yt-dlp: ${err.message}`);
    });
  });
const downloadSong = (song, directory) =>
  new Promise((resolve) => {
    // If it's a local file, just return the song as-is
    if (song.channel === "file") {
      return resolve(song);
    }

    // YouTube download logic for non-file songs
    const command = child_process.spawn("yt-dlp", [
      "-x",
      "--restrict-filenames",
      "--windows-filenames",
      "-P",
      directory,
      `https://youtube.com/watch?v=${song.id}`,
    ]);
    command.stdout.on("data", (data) => {
      console.log(data.toString());
      if (data.toString().startsWith("[ExtractAudio] Destination: ")) {
        song.path = data.toString().slice(28, -1);
      } else if (
        data.toString().startsWith("[ExtractAudio] Not converting audio ")
      ) {
        song.path = data.toString().slice(36, -46);
      }
    });
    command.stderr.on("data", (data) => console.error(data.toString()));
    command.on("close", () => resolve(song.path ? song : ""));
  });

const downloadPlaylist = (playlistURL) =>
  new Promise(async (resolve, reject) => {
    try {
      // Check if it's a local file path or URL
      const isLocalFile =
        playlistURL.toLowerCase().endsWith(".m3u") &&
        (fs.existsSync(playlistURL) ||
          fs.existsSync(path.resolve(playlistURL)) ||
          playlistURL.startsWith("/") ||
          playlistURL.startsWith("./"));

      // Setup directories
      const characters = "abcdefghijklmnopqrstuvwxyz0123456789_".split("");
      characters.forEach((letter) => {
        const dir = path.join(SONG_DIRECTORY, letter);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
      });
      if (!fs.existsSync(SONG_FILE_DIRECTORY)) {
        fs.mkdirSync(SONG_FILE_DIRECTORY, {recursive: true});
      }

      let playlistData;
      if (isLocalFile) {
        // Handle local M3U file
        const resolvedPath = path.resolve(playlistURL);
        if (!fs.existsSync(resolvedPath)) {
          return reject(`M3U file not found: ${resolvedPath}`);
        }
        playlistData = await parseM3UFile(resolvedPath);
      } else {
        // Handle YouTube URL
        if (!playlistURL.startsWith("https://")) {
          playlistURL = `https://www.youtube.com/playlist?list=${playlistURL}`;
        }
        playlistData = await fetchPlaylistData(playlistURL);
      }

      // Rest of your existing code...
      mainWindow.webContents.send("playlistProgress", [playlistURL, 0]);
      const highestPosition = await getHighestPlaylistPosition();
      db.get(
        "SELECT id, title FROM playlists WHERE id = ?",
        [playlistData.id],
        (err, row) => {
          if (err) return reject(err);
          if (!row) {
            db.run(
              "INSERT INTO playlists (id, title, position) VALUES (?, ?, ?)",
              [playlistData.id, playlistData.title, highestPosition + 1],
              (err) => {
                if (err)
                  console.error("Error inserting playlist:", err.message);
              },
            );
          } else if (row.title !== playlistData.title) {
            db.run(
              "UPDATE playlists SET title = ? WHERE id = ?",
              [playlistData.title, playlistData.id],
              (err) => {
                if (err)
                  console.error("Error updating playlist title:", err.message);
              },
            );
          }
        },
      );

      let progress = 0;
      let songCount = playlistData.songs.length;

      db.all(
        "SELECT song_id FROM playlist_songs WHERE playlist_id = ?",
        [playlistData.id],
        async (err, rows) => {
          if (err) return reject(err);

          const currentSongIds = rows.map((row) => row.song_id);
          const newSongIds = playlistData.songs.map((song) => song.id);
          const songsToRemove = currentSongIds.filter(
            (id) => !newSongIds.includes(id),
          );

          songsToRemove.forEach((songId) => {
            db.run(
              "DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?",
              [playlistData.id, songId],
              (err) => {
                if (err)
                  console.error(
                    "Error removing song from playlist_songs:",
                    err.message,
                  );
              },
            );
          });

          // Process songs in batches to prevent memory overload
          const batchSize = 5; // Limit concurrent downloads

          const processSongBatch = async (songBatch) => {
            const batchPromises = songBatch.map(async ({song, index}) => {
              return new Promise((resolve, reject) => {
                db.get(
                  "SELECT id FROM songs WHERE id = ?",
                  [song.id],
                  async (err, row) => {
                    if (err) return reject(err);

                    try {
                      if (!row) {
                        let directoryName = characters.includes(
                          song.id[0].toLowerCase(),
                        )
                          ? song.id[0].toLowerCase()
                          : "_";
                        let songPath = path.join(SONG_DIRECTORY, directoryName);
                        let downloadedSong = await downloadSong(song, songPath);
                        if (downloadedSong) {
                          db.run(
                            `INSERT OR REPLACE INTO songs (id, title, path, channel) VALUES (?, ?, ?, ?)`,
                            [
                              downloadedSong.id,
                              downloadedSong.title,
                              downloadedSong.path,
                              downloadedSong.channel,
                            ],
                          );
                        }
                      }

                      db.run(
                        `INSERT OR REPLACE INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)`,
                        [playlistData.id, song.id, index],
                      );

                      progress++;
                      mainWindow.webContents.send("playlistProgress", [
                        playlistData.id,
                        progress / songCount,
                      ]);
                      resolve();
                    } catch (downloadError) {
                      console.error(
                        `Error downloading song ${song.id}:`,
                        downloadError,
                      );
                      // Still resolve to continue with other songs
                      progress++;
                      mainWindow.webContents.send("playlistProgress", [
                        playlistData.id,
                        progress / songCount,
                      ]);
                      resolve();
                    }
                  },
                );
              });
            });

            await Promise.all(batchPromises);
          };

          // Process songs in batches
          for (let i = 0; i < playlistData.songs.length; i += batchSize) {
            const batch = playlistData.songs
              .slice(i, i + batchSize)
              .map((song, batchIndex) => ({song, index: i + batchIndex}));

            await processSongBatch(batch);

            // Add a small delay between batches to prevent overwhelming the system
            if (i + batchSize < playlistData.songs.length) {
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }

          resolve();
        },
      );
    } catch (error) {
      console.error("Error downloading playlist:", error);
      reject(error);
    }
  });

const removePlaylist = (playlistID) =>
  new Promise(async (resolve, reject) => {
    try {
      const playlistDatabaseData = await getPlaylistData(playlistID);
      if (!playlistDatabaseData) {
        return reject("Playlist not found in database");
      }

      const deletePlaylistPromise = new Promise((resolve, reject) => {
        db.run("DELETE FROM playlists WHERE id = ?", [playlistID], (err) => {
          if (err) return reject(err);
          console.log("Playlist deleted:", playlistID);
          resolve();
        });
      });

      const deletePlaylistSongsPromise = new Promise((resolve, reject) => {
        db.run(
          "DELETE FROM playlist_songs WHERE playlist_id = ?",
          [playlistID],
          (err) => {
            if (err) return reject(err);
            console.log("Playlist songs deleted for playlist:", playlistID);
            resolve();
          },
        );
      });

      const updatePlaylistPositions = new Promise((resolve, reject) => {
        db.run(
          `UPDATE playlists
                    SET position = position - 1
                    WHERE position > ?
                      AND POSITION > 0`,
          [playlistDatabaseData.position],
          (err) => {
            if (err) return reject(err);
            console.log("Playlist positions decremented");
            resolve();
          },
        );
      });

      await Promise.all([
        deletePlaylistPromise,
        deletePlaylistSongsPromise,
        updatePlaylistPositions,
      ]);
      deleteUnreferencedSongs();
      resolve();
    } catch (error) {
      reject(error);
    }
  });

// IPC handlers
ipcMain.handle("downloadPlaylist", (event, playlistURL) =>
  downloadPlaylist(playlistURL),
);
ipcMain.handle("removePlaylist", (event, playlistID) =>
  removePlaylist(playlistID),
);
ipcMain.handle("getPlaylists", async () => await getPlaylists());
ipcMain.handle("getSongs", (event, playlistId) => getSongs(playlistId));
ipcMain.handle("swapPlaylists", (event, playlistId1, playlistId2) =>
  swapPlaylists(playlistId1, playlistId2),
);
ipcMain.on("playbackChange", (_event, state) => updateTrayMenu(state));

// Electron app lifecycle
function createWindow() {
  mainWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    minWidth: 600,
    minHeight: 500,
    useContentSize: true,
    webPreferences: {preload: path.join(__dirname, "preload.js")},
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: "#f4f4f4",
  });
  mainWindow.setMenu(null);
  mainWindow.loadFile("index.html");
  //mainWindow.openDevTools();
}

function updateTrayMenu(state) {
  const contextMenu = Menu.buildFromTemplate([
    {label: "Show App", click: () => mainWindow.show()},
    {
      label: state === "play" ? "Pause" : "Play",
      click: () =>
        mainWindow.webContents.send(state === "play" ? "pause" : "play"),
    },
    {label: "Quit", click: () => app.quit()},
  ]);
  tray.setContextMenu(contextMenu);
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  mainWindow.on("ready-to-show", () => mainWindow.show());

  const iconPath = path.join(__dirname, "icon.png");
  const trayIcon = nativeImage.createFromPath(iconPath);
  tray = new Tray(trayIcon);
  tray.setToolTip("Moss Music");

  tray.on("click", () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });

  updateTrayMenu("paused");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
