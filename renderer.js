// Constants and initializations
const addPlaylistInput = document.getElementById('add-playlist-input');
const addPlaylistInputButton = document.getElementById('add-playlist-input-button');
const downloadProgress = document.getElementById('download-progress');
const removePlaylistInputButton = document.getElementById('remove-playlist-input-button');
const refreshPlaylistInputButton = document.getElementById('refresh-playlist-input-button');
const playlistListDiv = document.getElementById('playlist-list');
const playerDiv = document.getElementById('player');
const audioPlayer = document.getElementById('audio-player');
const currentSong = document.getElementById('current-song');
const nextSongButton = document.getElementById('next-button');
const previousSongButton = document.getElementById('previous-button');
const shuffleCheckbox = document.getElementById('shuffle-checkbox');
const playbackSettingForm = document.getElementById('playback-setting-form');
const songListDiv = document.getElementById('song-list');

let songPosition = 0;
let currentPlaylist = '';
let songs = [];

// Utility functions
const disableButtons = () => {
    addPlaylistInputButton.disabled = true;
    removePlaylistInputButton.disabled = true;
    refreshPlaylistInputButton.disabled = true;
};

const enableButtons = () => {
    addPlaylistInputButton.disabled = false;
    removePlaylistInputButton.disabled = false;
    refreshPlaylistInputButton.disabled = false;
};

// Update the audio player with the current song.
const updateAudioPlayer = (song) => {
    audioPlayer.src = song.path;
    audioPlayer.play();
    currentSong.textContent = song.title;
};

// Fisher-Yates shuffle algorithm for a more uniform shuffle.
const shuffleSongs = () => {
    for (let i = songs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [songs[i], songs[j]] = [songs[j], songs[i]];
    }
};

// Main application logic.
const playPlaylist = async (playlistId) => {
    // If in playlist deletion mode delete the playlist
    if (removePlaylistInputButton.textContent === "Cancel") {
        if (currentPlaylist === playlistId) {
            playerDiv.style.display = 'none';
        }
        const playlistButtons = playlistListDiv.children;
        for (let i = 0; i < playlistButtons.length; i++) {
            playlistButtons[i].classList.remove("show-crosshair");
        }
        removePlaylistInputButton.textContent = "Remove";
        await window.ytdlp.removePlaylist(playlistId);
        await renderPlaylists();
        enableButtons();
    } else {
        // Else play the playlist
        if (currentPlaylist !== playlistId) {
            songPosition = 0;
            if (currentPlaylist) {
                try {
                    document.getElementById(currentPlaylist + '-button').className = '';
                } catch (e) {
                    console.error(`Playlist ${currentPlaylist} is unavailable`);
                    console.error(e);
                }
            }
            currentPlaylist = playlistId;
            document.getElementById(playlistId + '-button').className = 'active';
        }
        songs = await window.ytdlp.getSongs(playlistId);
        const fragment = document.createDocumentFragment();
        songs.forEach(song => {
            const button = document.createElement('button');
            button.textContent = song.title;
            button.id = song.id + '-button';
            button.addEventListener('click', () => playSong(song.id));
            fragment.appendChild(button);
        });
        songListDiv.replaceChildren(fragment);
        playerDiv.style.display = 'block';
        if (shuffleCheckbox.checked) {
            shuffleSongs();
        }
        updateAudioPlayer(songs[songPosition]);
        document.getElementById(songs[songPosition].id + '-button').className = 'active';
    }
};

const playSong = (songId) => {
    document.getElementById(songs[songPosition].id + '-button').className = '';
    songPosition = songs.findIndex(song => song.id === songId);
    updateAudioPlayer(songs[songPosition]);
    document.getElementById(songs[songPosition].id + '-button').className = 'active';
};

const nextSong = () => {
    document.getElementById(songs[songPosition].id + '-button').className = '';
    songPosition = (songPosition < songs.length - 1) ? songPosition + 1 : 0;
    if (songPosition === 0 && shuffleCheckbox.checked) {
        shuffleSongs();
    }
    updateAudioPlayer(songs[songPosition]);
    document.getElementById(songs[songPosition].id + '-button').className = 'active';
};

const previousSong = () => {
    if (songPosition > 0) {
        document.getElementById(songs[songPosition].id + '-button').className = '';
        songPosition--;
        updateAudioPlayer(songs[songPosition]);
        document.getElementById(songs[songPosition].id + '-button').className = 'active';
    }
};

const renderPlaylists = async () => {
    const playlists = await window.ytdlp.getPlaylists();
    const fragment = document.createDocumentFragment();
    playlists.forEach(playlist => {
        const button = document.createElement('button');
        button.textContent = playlist.title;
        button.id = playlist.id + '-button';
        button.addEventListener('click', () => playPlaylist(playlist.id));
        fragment.appendChild(button);
    });
    playlistListDiv.replaceChildren(fragment);
};

const setupEventListeners = () => {
    shuffleCheckbox.addEventListener('change', () => {
        const currentSongId = songs[songPosition].id;
        if (shuffleCheckbox.checked) {
            shuffleSongs();
        } else {
            songs.sort((a, b) => a.position - b.position);
        }
        songPosition = songs.findIndex(song => song.id === currentSongId);
    });

    audioPlayer.addEventListener('ended', () => {
        const playbackSetting = playbackSettingForm.elements['playback'].value;
        if (playbackSetting === 'continue') {
            nextSong();
        } else if (playbackSetting === 'loop') {
            audioPlayer.play();
        }
    });

    nextSongButton.addEventListener('click', nextSong);
    previousSongButton.addEventListener('click', previousSong);

    addPlaylistInputButton.addEventListener('click', async () => {
        if (addPlaylistInput.value !== '') {
            disableButtons();
            const playlistToDownload = addPlaylistInput.value;
            addPlaylistInput.value = '';
            await window.ytdlp.downloadPlaylist(playlistToDownload);
            await renderPlaylists();
            enableButtons();
        }
    });

    removePlaylistInputButton.addEventListener('click', async () => {
        addPlaylistInputButton.disabled = true;
        const playlistButtons = playlistListDiv.children;
        if (removePlaylistInputButton.textContent === "Remove") {
            removePlaylistInputButton.textContent = "Cancel";
            for (let i = 0; i < playlistButtons.length; i++) {
                playlistButtons[i].classList.add("show-crosshair");
            }
        } else {
            removePlaylistInputButton.textContent = "Remove";
            enableButtons();
            for (let i = 0; i < playlistButtons.length; i++) {
                playlistButtons[i].classList.remove("show-crosshair");
            }
        }
    });

    refreshPlaylistInputButton.addEventListener('click', async () => {
        disableButtons();
        const playlists = await window.ytdlp.getPlaylists();
        for (const playlist of playlists) {
            await window.ytdlp.downloadPlaylist(playlist.id);
        }
        localStorage.setItem('last-updated', Date.now().valueOf().toString());
        enableButtons();
    });

    window.ytdlp.onPlaylistProgress((progress) => {
        downloadProgress.value = progress[1];
        if (progress[1] === 1) {
            setTimeout(() => {
                downloadProgress.value = 0;
            }, 1000);
        }
    });

    audioPlayer.addEventListener('play', () => window.playback.playbackChange('play'));
    audioPlayer.addEventListener('pause', () => window.playback.playbackChange('pause'));

    window.playback.play(() => audioPlayer.play());
    window.playback.pause(() => audioPlayer.pause());
};

const init = async () => {
    setupEventListeners();
    disableButtons();
    await renderPlaylists();

    // Check if the playlists need to be updated every 24 hours.
    if (localStorage.getItem('last-updated')) {
        const currentTime = Date.now().valueOf();
        if (currentTime - Number(localStorage.getItem('last-updated')) > 86400000 /* 24 hours */) {
            if (window.navigator.onLine) {
                const playlists = await window.ytdlp.getPlaylists();
                await Promise.all(playlists.map(playlist => window.ytdlp.downloadPlaylist(playlist.id)));
                localStorage.setItem('last-updated', currentTime.toString());
            }
        }
    } else {
        localStorage.setItem('last-updated', Date.now().valueOf().toString());
    }
    enableButtons();
};

init();