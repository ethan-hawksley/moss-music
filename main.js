const {app, BrowserWindow, Tray, Menu, nativeImage, ipcMain} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const child_process = require('node:child_process');
const sqlite3 = require('sqlite3').verbose();

let DATA_DIRECTORY;
if (process.platform === "linux") {
    DATA_DIRECTORY = path.join(app.getPath("home"), '.local', 'share', 'moss-music');
} else {
    DATA_DIRECTORY = app.getPath('userData');
}
if (!fs.existsSync(DATA_DIRECTORY)) fs.mkdirSync(DATA_DIRECTORY, {recursive: true});
console.log(DATA_DIRECTORY);
const DB_PATH = path.join(DATA_DIRECTORY, 'database.db');
const SONG_DIRECTORY = path.join(DATA_DIRECTORY, 'songs');
let mainWindow;
let tray;

// Database initialization
let db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('Error opening database:', err.message); else console.log('Connected to SQLite database.');
});

//@formatter:off
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS songs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        channel TEXT NOT NULL,
        duration INTEGER NOT NULL
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
const getPlaylists = () => new Promise((resolve, reject) => {
    db.all('SELECT id, title FROM playlists', (err, rows) => {
        if (err) return reject('Error fetching playlists');
        resolve(rows.map(row => ({id: row.id, title: row.title})));
    });
});

const getSongs = (playlistId) => new Promise((resolve, reject) => {
    db.all(`SELECT songs.id, songs.title, songs.path, songs.channel, songs.duration, playlist_songs.position
            FROM songs
                     JOIN
                 playlist_songs
                 ON
                     songs.id = playlist_songs.song_id
            WHERE playlist_songs.playlist_id = ?
            ORDER BY playlist_songs.position`, [playlistId], (err, rows) => {
        if (err) return reject('Error fetching songs');
        resolve(rows);
    });
})


const deleteUnreferencedSongs = () => {
    db.all('SELECT id, path FROM songs WHERE id NOT IN (SELECT song_id FROM playlist_songs)', (err, rows) => {
        if (err) return console.error('Error fetching unreferenced songs:', err.message);
        rows.forEach((row) => {
            fs.unlink(row.path, (err) => {
                if (err) console.error('Error deleting song file', err.message); else console.log('Deleted song file:', row.path);
            });
        db.run('DELETE FROM songs WHERE id NOT IN (SELECT song_id FROM playlist_songs)', (err) => {
            if (err) console.error('Error deleting unreferenced songs from database:', err.message); else console.log('Deleted unreferenced songs from database');
        });
        });
    });
};

// Playlist functions
const fetchPlaylistData = (playlistURL) => new Promise((resolve, reject) => {
    let output = '';
    let command = child_process.spawn('yt-dlp', ['-j', '--flat-playlist', '--no-warnings', playlistURL]);

    command.stdout.on('data', (data) => output += data.toString());
    command.stderr.on('data', (data) => console.error(data));
    command.on('close', () => {
        try {
            const jsonLines = output.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line));
            if (jsonLines.length === 0) return reject('empty');
            const playlistData = {
                id: jsonLines[0].playlist_id,
                title: jsonLines[0].playlist_title.replace(/^Album - /, ''),
                songs: jsonLines.map(rawSong => ({
                    id: rawSong.id,
                    title: rawSong.title,
                    path: '',
                    channel: rawSong.channel.replace(/ - Topic$/, ''),
                    duration: rawSong.duration
                }))
            };
            resolve(playlistData);
        } catch (e) {
            console.error(`error parsing json: ${e}`);
            fs.writeFileSync(path.join(app.getPath('documents'), 'log.json'), output);
            reject('error');
        }
    });
});

const downloadSong = (song, directory) => new Promise((resolve) => {
    const command = child_process.spawn('yt-dlp', ['-x', '-P', directory, `https://youtube.com/watch?v=${song.id}`]);
    command.stdout.on('data', (data) => {
        console.log(data.toString());
        if (data.toString().startsWith('[ExtractAudio] Destination: ')) {
            song.path = data.toString().slice(28, -1);
        } else if (data.toString().startsWith('[ExtractAudio] Not converting audio ')) {
            song.path = data.toString().slice(36, -46);
        }
    });
    command.stderr.on('data', (data) => console.error(data.toString()));
    command.on('close', () => resolve(song.path ? song : ''));
});

const downloadPlaylist = (playlistURL) => new Promise(async (resolve, reject) => {
    try {
        if (!playlistURL.startsWith('https://')) {
            playlistURL = `https://www.youtube.com/playlist?list=${playlistURL}`;
        }
        const characters = 'abcdefghijklmnopqrstuvwxyz0123456789_'.split('');
        characters.forEach(letter => {
            const dir = path.join(SONG_DIRECTORY, letter);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
        });

        const playlistData = await fetchPlaylistData(playlistURL);
        mainWindow.webContents.send('playlistProgress', [playlistURL, 0]);

        db.get('SELECT id, title FROM playlists WHERE id = ?', [playlistData.id], (err, row) => {
            if (err) return reject(err);
            if (!row) {
                db.run('INSERT INTO playlists (id, title) VALUES (?, ?)', [playlistData.id, playlistData.title], (err) => {
                    if (err) console.error('Error inserting playlist:', err.message);
                });
            } else if (row.title !== playlistData.title) {
                db.run('UPDATE playlists SET title = ? WHERE id = ?', [playlistData.title, playlistData.id], (err) => {
                    if (err) console.error('Error updating playlist title:', err.message);
                });
            }
        });

        let progress = 0;
        let songCount = playlistData.songs.length;

        db.all('SELECT song_id FROM playlist_songs WHERE playlist_id = ?', [playlistData.id], async (err, rows) => {
            if (err) return reject(err);

            const currentSongIds = rows.map(row => row.song_id);
            const newSongIds = playlistData.songs.map(song => song.id);
            const songsToRemove = currentSongIds.filter(id => !newSongIds.includes(id));

            songsToRemove.forEach(songId => {
                db.run('DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?', [playlistData.id, songId], (err) => {
                    if (err) console.error('Error removing song from playlist_songs:', err.message);
                });
            });

            const downloadPromises = playlistData.songs.map(async (song, index) => {
                return new Promise((resolve, reject) => {
                    db.get('SELECT id FROM songs WHERE id = ?', [song.id], async (err, row) => {
                        if (err) return reject(err);
                        if (!row) {
                            let directoryName = characters.includes(song.id[0].toLowerCase()) ? song.id[0].toLowerCase() : '_';
                            let songPath = path.join(SONG_DIRECTORY, directoryName);
                            let downloadedSong = await downloadSong(song, songPath);
                            if (downloadedSong) {
                                db.run(`INSERT
                                OR REPLACE INTO songs (id, title, path, channel, duration) VALUES (?, ?, ?, ?, ?)`, [downloadedSong.id, downloadedSong.title, downloadedSong.path, downloadedSong.channel, downloadedSong.duration]);
                            }
                        }
                        db.run(`INSERT
                        OR REPLACE INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)`, [playlistData.id, song.id, index]);
                        progress++;
                        mainWindow.webContents.send('playlistProgress', [playlistData.id, progress / songCount]);
                        resolve();
                    });
                });
            });

            await Promise.all(downloadPromises);
            resolve();
        });
    } catch (error) {
        reject(error);
    }
});

const removePlaylist = (playlistID) => new Promise(async (resolve, reject) => {
    try {
        const playlistData = await fetchPlaylistData(`https://youtube.com/playlist?list=${playlistID}`);

        const deletePlaylistPromise = new Promise((resolve, reject) => {
            db.run('DELETE FROM playlists WHERE id = ?', [playlistData.id], (err) => {
                if (err) return reject(err);
                console.log('Playlist deleted:', playlistData.title);
                resolve();
            });
        });

        const deletePlaylistSongsPromise = new Promise((resolve, reject) => {
            db.run('DELETE FROM playlist_songs WHERE playlist_id = ?', [playlistData.id], (err) => {
                if (err) return reject(err);
                console.log('Playlist songs deleted for playlist:', playlistData.title);
                resolve();
            });
        });

        await Promise.all([deletePlaylistPromise, deletePlaylistSongsPromise]);
        await deleteUnreferencedSongs();
        resolve();
    } catch (error) {
        reject(error);
    }
});

// IPC handlers
ipcMain.handle('downloadPlaylist', (event, playlistURL) => downloadPlaylist(playlistURL));
ipcMain.handle('removePlaylist', (event, playlistID) => removePlaylist(playlistID));
ipcMain.handle('getPlaylists', async () => await getPlaylists());
ipcMain.handle('getSongs', (event, playlistId) => getSongs(playlistId));
ipcMain.on('playbackChange', (_event, state) => updateTrayMenu(state));

// Electron app lifecycle
function createWindow() {
    mainWindow = new BrowserWindow({
        show: false,
        width: 900,
        height: 600,
        minWidth: 400,
        minHeight: 500,
        useContentSize: true,
        webPreferences: {preload: path.join(__dirname, 'preload.js')},
        icon: path.join(__dirname, 'icon.png'),
        backgroundColor: '#f4f4f4'
    });
    mainWindow.setMenu(null);
    mainWindow.loadFile('index.html');
    //mainWindow.openDevTools();
}

function updateTrayMenu(state) {
    const contextMenu = Menu.buildFromTemplate([{label: 'Show App', click: () => mainWindow.show()}, {
        label: state === 'play' ? 'Pause' : 'Play',
        click: () => mainWindow.webContents.send(state === 'play' ? 'pause' : 'play')
    }, {label: 'Quit', click: () => app.quit()}]);
    tray.setContextMenu(contextMenu);
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    mainWindow.on('ready-to-show', () => mainWindow.show());

    const iconPath = path.join(__dirname, 'icon.png');
    const trayIcon = nativeImage.createFromPath(iconPath);
    tray = new Tray(trayIcon);
    tray.setToolTip('Moss Music');

    tray.on('click', () => {
        if (mainWindow.isVisible()) {
            mainWindow.hide();
        } else {
            mainWindow.show();
        }
    });

    updateTrayMenu('paused');
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
