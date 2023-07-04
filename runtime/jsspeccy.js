import EventEmitter from 'events';
import fileDialog from 'file-dialog';
import JSZip from 'jszip';

import { Buffer } from 'buffer';
import { DisplayHandler } from './render.js';
import { UIController } from './ui.js';
import { parseSNAFile, parseZ80File, parseSZXFile } from './snapshot.js';
import { TAPFile, TZXFile } from './tape.js';
import { KeyboardHandler } from './keyboard.js';
import { AudioHandler } from './audio.js';
import { SpectranetConfiguration, SpectranetConfigurationOption } from './spectranet.js';
import { Long, serialize, deserialize } from 'bson';

import openIcon from './icons/open.svg';
import resetIcon from './icons/reset.svg';
import magicIcon from './icons/magic.svg';
import warningIcon from './icons/warning.svg';
import successIcon from './icons/success.svg';
import playIcon from './icons/play.svg';
import serverIcon from './icons/server.svg';
import pauseIcon from './icons/pause.svg';
import fullscreenIcon from './icons/fullscreen.svg';
import exitFullscreenIcon from './icons/exitfullscreen.svg';
import tapePlayIcon from './icons/tape_play.svg';
import tapePauseIcon from './icons/tape_pause.svg';

const scriptUrl = document.currentScript.src;

class Emulator extends EventEmitter {
    constructor(canvas, opts) {
        super();
        this.canvas = canvas;
        this.worker = new Worker(new URL('jsspeccy-worker.js', scriptUrl));
        this.keyboardHandler = new KeyboardHandler(this.worker);
        this.displayHandler = new DisplayHandler(this.canvas);
        this.audioHandler = new AudioHandler();
        this.isRunning = false;
        this.isInitiallyPaused = (!opts.autoStart);
        this.autoLoadTapes = opts.autoLoadTapes || false;
        this.tapeAutoLoadMode = opts.tapeAutoLoadMode || 'default';  // or usr0
        this.proxyURL = opts.proxyURL || 'ws://localhost:5000';
        this.tapeIsPlaying = false;
        this.tapeTrapsEnabled = ('tapeTrapsEnabled' in opts) ? opts.tapeTrapsEnabled : true;

        this.msPerFrame = 20;
        this.wsProxy = null;

        this.isExecutingFrame = false;
        this.nextFrameTime = null;
        this.machineType = null;

        const spectranetRom = localStorage.getItem('spectranetRom');

        this.spectranetRomSaveTimer = -1;

        if (spectranetRom) {
            this.spectranetRom = Uint8Array.from(atob(spectranetRom), c => c.charCodeAt(0));
        } else {
            this.spectranetRom = null;
        }

        this.nextFileOpenID = 0;
        this.fileOpenPromiseResolutions = {};
        this.nextMemoryFetchID = 0;
        this.memoryFetchResolutions = {};

        this.worker.onmessage = (e) => {
            switch(e.data.message) {
                case 'ready':
                    this.ready(opts);
                    break;
                case 'frameCompleted':
                    // benchmarkRunCount++;
                    if ('audioBufferLeft' in e.data) {
                        this.audioHandler.frameCompleted(e.data.audioBufferLeft, e.data.audioBufferRight);
                    }

                    this.displayHandler.frameCompleted(e.data.frameBuffer);
                    if (this.isRunning) {
                        const time = performance.now();
                        if (time > this.nextFrameTime) {
                            /* running at full blast - start next frame but adjust time base
                            to give it the full time allocation */
                            this.runFrame();
                            this.nextFrameTime = time + this.msPerFrame;
                        } else {
                            this.isExecutingFrame = false;
                        }
                    } else {
                        this.isExecutingFrame = false;
                    }
                    break;
                case 'memoryFetched':
                    this.memoryFetchResolutions[e.data.id](e.data.data);
                    delete this.memoryFetchResolutions[e.data.id];
                    break;
                case 'fileOpened':
                    if (e.data.mediaType == 'tape' && this.autoLoadTapes) {
                        const TAPE_LOADERS_BY_MACHINE = {
                            '48': {'default': 'tapeloaders/tape_48.szx', 'usr0': 'tapeloaders/tape_48.szx'},
                            '49': {'default': 'tapeloaders/tape_48.szx', 'usr0': 'tapeloaders/tape_48.szx'},
                            '128': {'default': 'tapeloaders/tape_128.szx', 'usr0': 'tapeloaders/tape_128_usr0.szx'},
                            '5': {'default': 'tapeloaders/tape_pentagon.szx', 'usr0': 'tapeloaders/tape_pentagon_usr0.szx'},
                        };
                        this.openUrl(new URL(TAPE_LOADERS_BY_MACHINE[this.machineType][this.tapeAutoLoadMode], scriptUrl));
                        if (!this.tapeTrapsEnabled) {
                            this.playTape();
                        }
                    }
                    this.fileOpenPromiseResolutions[e.data.id]({
                        mediaType: e.data.mediaType,
                    });
                    if (e.data.mediaType == 'tape') {
                        this.emit('openedTapeFile');
                    }
                    break;
                case 'playingTape':
                    this.tapeIsPlaying = true;
                    this.emit('playingTape');
                    break;
                case 'stoppedTape':
                    this.tapeIsPlaying = false;
                    this.emit('stoppedTape');
                    break;
                case 'sendToProxy':
                    this.wsProxy.send(serialize({
                        "m": e.data.method,
                        "a": e.data.args
                    }));
                    break;
                case 'writeSpectranetROM':
                {
                    if (this.spectranetRom) {
                        const addr = e.data.addr;
                        this.spectranetRom[addr] = e.data.val;
                        this.saveSpectranetRom();
                    }
                    break;
                }
                case 'eraseSpectranetROM':
                {
                    if (this.spectranetRom) {
                        const from = e.data.from;
                        const to = e.data.to;
                        const val = e.data.val;

                        for (let i = from; i < to; i++)
                        {
                            this.spectranetRom[i] = val;
                        }

                        this.saveSpectranetRom();
                    }
                    break;
                }

                default:
                    console.log('message received by host:', e.data);
            }
        };

        const worker = this.worker;
        this.wsProxy = new WebSocket(this.proxyURL);
        const self = this;

        this.wsProxy.onopen = function() {
            console.log("Connected to WS proxy.");
            self.emit('success', "Connected to proxy");
            worker.postMessage({
                message: 'loadCore',
                baseUrl: scriptUrl,
            });
        };

        this.wsProxy.onclose = function(event) {
            self.emit('warning', "No connection with proxy");
            worker.postMessage({
                message: 'proxyTerm'
            });
        };

        this.wsProxy.onmessage = function(event) {
            event.data.arrayBuffer().then((b) => {
                const d = deserialize(b);

                worker.postMessage({
                    message: 'msg',
                    method: d.m,
                    args: d.a
                });
            });
        };
    }

    async ready(opts) {
        await this.loadRoms();
        this.setMachine(opts.machine || 128);
        this.setTapeTraps(this.tapeTrapsEnabled);

        const configFlash = await this.fetchRomData(88 + 31, 0, 4096);
        const config = new SpectranetConfiguration(configFlash);

        if (opts.tnfs) {
            await this.loadTNFS(opts.tnfs, config);
        } else {
            await this.unloadTNFS(config);

            if (opts.openUrl) {
                this.openUrlList(opts.openUrl).catch(err => {
                    alert(err);
                })
            }
        }

        console.log("Spectranet config:");
        console.log(config);

        await this.loadRomData(config.bake(), 88 + 31, 0);

        if (opts.autoStart) this.start();
    }

    saveSpectranetRom() {
        if (this.spectranetRomSaveTimer !== -1) {
            clearTimeout(this.spectranetRomSaveTimer);
        }
        this.spectranetRomSaveTimer = setTimeout(() => {
            localStorage.setItem('spectranetRom', Buffer.from(this.spectranetRom).toString('base64'));
            this.spectranetRomSaveTimer = -1;
        }, 1000);
    }

    setCookie(c_name, value, exdays) {
        var exdate = new Date();
        exdate.setDate(exdate.getDate() + exdays);
        var c_value = escape(value) + ((exdays == null) ? "" : "; expires=" + exdate.toUTCString());
        document.cookie = c_name + "=" + c_value;
    }

    getCookie(c_name) {
        var i, x, y, ARRcookies = document.cookie.split(";");
        for (i = 0; i < ARRcookies.length; i++) {
            x = ARRcookies[i].substr(0, ARRcookies[i].indexOf("="));
            y = ARRcookies[i].substr(ARRcookies[i].indexOf("=") + 1);
            x = x.replace(/^\s+|\s+$/g, "");
            if (x == c_name) {
                return unescape(y);
            }
        }
    }

    start() {
        if (!this.isRunning) {
            this.isRunning = true;
            this.isInitiallyPaused = false;
            this.nextFrameTime = performance.now();
            this.keyboardHandler.start();
            this.audioHandler.start();
            this.emit('start');
            window.requestAnimationFrame((t) => {
                this.runAnimationFrame(t);
            });
        }
    }

    pause() {
        if (this.isRunning) {
            this.isRunning = false;
            this.keyboardHandler.stop();
            this.audioHandler.stop();
            this.emit('pause');
        }
    }

    async loadRomData(data, page, offset = 0) {
        this.worker.postMessage({
            message: 'loadMemory',
            data,
            page: page,
            offset: offset
        });
    }

    fetchRomData(page, offset, len) {
        const fetchID = this.nextMemoryFetchID++;
        this.worker.postMessage({
            message: 'fetchMemory',
            page: page,
            offset: offset,
            len: len,
            id: fetchID
        });
        const self = this;
        return new Promise((resolve, reject) => {
            self.memoryFetchResolutions[fetchID] = resolve;
        });
    }

    async loadRom(url, page, offset = 0) {
        const response = await fetch(new URL(url, scriptUrl));
        const data = new Uint8Array(await response.arrayBuffer());
        await this.loadRomData(data, page, offset);
        return data;
    }

    async loadRoms() {
        await this.loadRom('roms/128-0.rom', 32);
        await this.loadRom('roms/128-1.rom', 36);
        await this.loadRom('roms/48.rom', 40);
        await this.loadRom('roms/pentagon-0.rom', 48);
        await this.loadRom('roms/trdos.rom', 52);

        if (this.spectranetRom == null) {
            this.spectranetRom = await this.loadRom('roms/spectranet.rom', 88);
        } else {
            await this.loadRomData(this.spectranetRom, 88, 0);
        }
    }

    async unloadTNFS(config) {
        if (config.sections.hasOwnProperty(0x01ff)) {
            // delete auto-mount section
            delete config.sections[0x01ff];
        }
    }

    async loadTNFS(resource, config) {
        console.log("Mounting TNFS to: " + resource);

        const autoMountConfig = config.obtainSection(0x01ff);

        autoMountConfig[0x00] = new SpectranetConfigurationOption("string", resource);
        // auto-boot
        autoMountConfig[0x81] = new SpectranetConfigurationOption("byte", 1);
    }

    runFrame() {
        this.isExecutingFrame = true;
        const frameBuffer = this.displayHandler.getNextFrameBuffer();

        if (this.audioHandler.isActive) {
            const [audioBufferLeft, audioBufferRight] = this.audioHandler.frameBuffers;

            this.worker.postMessage({
                message: 'runFrame',
                frameBuffer,
                audioBufferLeft,
                audioBufferRight,
            }, [frameBuffer, audioBufferLeft, audioBufferRight]);
        } else {
            this.worker.postMessage({
                message: 'runFrame',
                frameBuffer,
            }, [frameBuffer]);
        }
    }

    runAnimationFrame(time) {
        if (this.displayHandler.readyToShow()) {
            this.displayHandler.show();
            // benchmarkRenderCount++;
        }
        if (this.isRunning) {
            if (time > this.nextFrameTime && !this.isExecutingFrame) {
                this.runFrame();
                this.nextFrameTime += this.msPerFrame;
            }
            window.requestAnimationFrame((t) => {
                this.runAnimationFrame(t);
            });
        }
    };

    setMachine(type) {
        if (type != 128 && type != 129 && type != 5 && type != 49) type = 48;
        this.worker.postMessage({
            message: 'setMachineType',
            type,
        });
        this.machineType = type;
        this.emit('setMachine', type);
    }

    reset() {
        this.worker.postMessage({message: 'reset'});
    }

    nmi() {
        this.worker.postMessage({message: 'nmi'});
    }

    loadSnapshot(snapshot) {
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'loadSnapshot',
            id: fileID,
            snapshot,
        })
        this.emit('setMachine', snapshot.model);
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    openTAPFile(data) {
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'openTAPFile',
            id: fileID,
            data,
        })
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    openTZXFile(data) {
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'openTZXFile',
            id: fileID,
            data,
        })
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    getFileOpener(filename) {
        const cleanName = filename.toLowerCase();
        if (cleanName.endsWith('.z80')) {
            return arrayBuffer => {
                const z80file = parseZ80File(arrayBuffer);
                return this.loadSnapshot(z80file);
            };
        } else if (cleanName.endsWith('.szx')) {
            return arrayBuffer => {
                const szxfile = parseSZXFile(arrayBuffer);
                return this.loadSnapshot(szxfile);
            };
        } else if (cleanName.endsWith('.sna')) {
            return arrayBuffer => {
                const snafile = parseSNAFile(arrayBuffer);
                return this.loadSnapshot(snafile);
            };
        } else if (cleanName.endsWith('.tap')) {
            return arrayBuffer => {
                if (!TAPFile.isValid(arrayBuffer)) {
                    alert('Invalid TAP file');
                } else {
                    return this.openTAPFile(arrayBuffer);
                }
            };
        } else if (cleanName.endsWith('.tzx')) {
            return arrayBuffer => {
                if (!TZXFile.isValid(arrayBuffer)) {
                    alert('Invalid TZX file');
                } else {
                    return this.openTZXFile(arrayBuffer);
                }
            };
        } else if (cleanName.endsWith('.zip')) {
            return async arrayBuffer => {
                const zip = await JSZip.loadAsync(arrayBuffer);
                const openers = [];
                zip.forEach((path, file) => {
                    if (path.startsWith('__MACOSX/')) return;
                    const opener = this.getFileOpener(path);
                    if (opener) {
                        const boundOpener = async () => {
                            const buf = await file.async('arraybuffer');
                            return opener(buf);
                        };
                        openers.push(boundOpener);
                    }
                });
                if (openers.length == 1) {
                    return openers[0]();
                } else if (openers.length == 0) {
                    throw 'No loadable files found inside ZIP file: ' + filename;
                } else {
                    // TODO: prompt to choose a file
                    throw 'Multiple loadable files found inside ZIP file: ' + filename;
                }
            }
        }
    }

    async openFile(file) {
        const opener = this.getFileOpener(file.name);
        if (opener) {
            const buf = await file.arrayBuffer();
            return opener(buf).catch(err => {alert(err);});
        } else {
            throw 'Unrecognised file type: ' + file.name;
        }
    }

    async openUrl(url) {
        const opener = this.getFileOpener(url.toString());
        if (opener) {
            const response = await fetch(url);
            const buf = await response.arrayBuffer();
            return opener(buf);
        } else {
            throw 'Unrecognised file type: ' + url.split('/').pop();
        }
    }
    async openUrlList(urls) {
        if (typeof(urls) === 'string') {
            return await this.openUrl(urls);
        } else {
            for (const url of urls) {
                await this.openUrl(url);
            }
        }
    }

    setAutoLoadTapes(val) {
        this.autoLoadTapes = val;
        this.emit('setAutoLoadTapes', val);
    }
    setTapeTraps(val) {
        this.tapeTrapsEnabled = val;
        this.worker.postMessage({
            message: 'setTapeTraps',
            value: val,
        })
        this.emit('setTapeTraps', val);
    }

    playTape() {
        this.worker.postMessage({
            message: 'playTape',
        });
    }
    stopTape() {
        this.worker.postMessage({
            message: 'stopTape',
        });
    }

    exit() {
        this.pause();
        this.worker.terminate();
    }
}

window.JSSpeccy = (container, opts) => {
    // let benchmarkRunCount = 0;
    // let benchmarkRenderCount = 0;
    opts = opts || {};

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    canvas.style.imageRendering = 'pixelated';

    const emu = new Emulator(canvas, {
        machine: opts.machine || 128,
        autoStart: opts.autoStart || false,
        tnfs: opts.tnfs,
        proxyURL: opts.proxyURL,
        autoLoadTapes: opts.autoLoadTapes || false,
        tapeAutoLoadMode: opts.tapeAutoLoadMode || 'default',
        openUrl: opts.openUrl,
        tapeTrapsEnabled: ('tapeTrapsEnabled' in opts) ? opts.tapeTrapsEnabled : true,
    });
    const ui = new UIController(container, emu, {zoom: opts.zoom || 1, sandbox: opts.sandbox});

    const fileMenu = ui.menuBar.addMenu('File');
    if (!opts.sandbox) {
        fileMenu.addItem('Open...', () => {
            openFileDialog();
        });
        fileMenu.addItem('Find games...', () => {
            openGameBrowser();
        });
        const autoLoadTapesMenuItem = fileMenu.addItem('Auto-load tapes', () => {
            emu.setAutoLoadTapes(!emu.autoLoadTapes);
        });
        const updateAutoLoadTapesCheckbox = () => {
            if (emu.autoLoadTapes) {
                autoLoadTapesMenuItem.setCheckbox();
            } else {
                autoLoadTapesMenuItem.unsetCheckbox();
            }
        }
        emu.on('setAutoLoadTapes', updateAutoLoadTapesCheckbox);
        updateAutoLoadTapesCheckbox();
    }

    const tapeTrapsMenuItem = fileMenu.addItem('Instant tape loading', () => {
        emu.setTapeTraps(!emu.tapeTrapsEnabled);
    });

    const updateTapeTrapsCheckbox = () => {
        if (emu.tapeTrapsEnabled) {
            tapeTrapsMenuItem.setCheckbox();
        } else {
            tapeTrapsMenuItem.unsetCheckbox();
        }
    }
    emu.on('setTapeTraps', updateTapeTrapsCheckbox);
    updateTapeTrapsCheckbox();

    const machineMenu = ui.menuBar.addMenu('Machine');
    const machine48Item = machineMenu.addItem('Spectrum 48K', () => {
        emu.setMachine(48);
    });
    const machine48WSpectanetItem = machineMenu.addItem('48K + Spectranet', () => {
        emu.setMachine(49);
    });
    const machine128Item = machineMenu.addItem('Spectrum 128K', () => {
        emu.setMachine(128);
    });
    const machinePentagonItem = machineMenu.addItem('Pentagon 128', () => {
        emu.setMachine(5);
    });
    const displayMenu = ui.menuBar.addMenu('Display');

    const zoomItemsBySize = {
        1: displayMenu.addItem('100%', () => ui.setZoom(1)),
        2: displayMenu.addItem('200%', () => ui.setZoom(2)),
        3: displayMenu.addItem('300%', () => ui.setZoom(3)),
    }
    const fullscreenItem = displayMenu.addItem('Fullscreen', () => {
        ui.enterFullscreen();
    })
    const setZoomCheckbox = (factor) => {
        if (factor == 'fullscreen') {
            fullscreenItem.setBullet();
            for (let i in zoomItemsBySize) {
                zoomItemsBySize[i].unsetBullet();
            }
        } else {
            fullscreenItem.unsetBullet();
            for (let i in zoomItemsBySize) {
                if (parseInt(i) == factor) {
                    zoomItemsBySize[i].setBullet();
                } else {
                    zoomItemsBySize[i].unsetBullet();
                }
            }
        }
    }

    ui.on('setZoom', setZoomCheckbox);
    setZoomCheckbox(ui.zoom);

    emu.on('setMachine', (type) => {
        if (type == 48) {
            machine48Item.setBullet();
            machine48WSpectanetItem.unsetBullet();
            machine128Item.unsetBullet();
            machinePentagonItem.unsetBullet();
        } else if (type == 49) {
            machine48Item.unsetBullet();
            machine48WSpectanetItem.setBullet();
            machine128Item.unsetBullet();
            machinePentagonItem.unsetBullet();
        } else if (type == 128) {
            machine48Item.unsetBullet();
            machine48WSpectanetItem.unsetBullet();
            machine128Item.setBullet();
            machinePentagonItem.unsetBullet();
        } else { // pentagon
            machine48Item.unsetBullet();
            machine48WSpectanetItem.unsetBullet();
            machine128Item.unsetBullet();
            machinePentagonItem.setBullet();
        }
    });

    if (!opts.sandbox) {
        ui.toolbar.addButton(openIcon, {label: 'Open file'}, () => {
            openFileDialog();
        });
    }
    ui.toolbar.addButton(resetIcon, {label: 'Reset'}, () => {
        emu.reset();
    });
    const pauseButton = ui.toolbar.addButton(playIcon, {label: 'Unpause'}, () => {
        if (emu.isRunning) {
            emu.pause();
        } else {
            emu.start();
        }
    });
    ui.toolbar.addButton(magicIcon, {label: 'Magic'}, () => {
        emu.nmi();
    });
    ui.toolbar.addButton(serverIcon, {label: 'Connect to TNFS'}, () => {
        const s = prompt("Please enter TNFS server to connect to");
        if (!s)
            return;
        window.location.search = "?tnfs=" + s;
    });
    emu.on('pause', () => {
        pauseButton.setIcon(playIcon);
        pauseButton.setLabel('Unpause');
    });
    emu.on('start', () => {
        pauseButton.setIcon(pauseIcon);
        pauseButton.setLabel('Pause');
    });
    const tapeButton = ui.toolbar.addButton(tapePlayIcon, {label: 'Start tape'}, () => {
        if (emu.tapeIsPlaying) {
            emu.stopTape();
        } else {
            emu.playTape();
        }
    });
    tapeButton.disable();

    const statusLabel = ui.toolbar.addLabel();
    statusLabel.disable();

    const spectranetMenu = ui.menuBar.addMenu('Spectranet');

    spectranetMenu.addItem('Erase ROM', () => {
        localStorage.removeItem('spectranetRom');
        location.reload();
    })

    emu.on('warning', (e) => {
        statusLabel.enable(warningIcon, e, '#a01f1f');
    });
    emu.on('success', (e) => {
        statusLabel.enable(successIcon, e, '#0f330c');
    });

    emu.on('openedTapeFile', () => {
        tapeButton.enable();
    });
    emu.on('playingTape', () => {
        tapeButton.setIcon(tapePauseIcon);
        tapeButton.setLabel('Stop tape');
    });
    emu.on('stoppedTape', () => {
        tapeButton.setIcon(tapePlayIcon);
        tapeButton.setLabel('Start tape');
    });

    const fullscreenButton = ui.toolbar.addButton(
        fullscreenIcon,
        {label: 'Enter full screen mode', align: 'right'},
        () => {
            ui.toggleFullscreen();
        }
    )

    ui.on('setZoom', (factor) => {
        if (factor == 'fullscreen') {
            fullscreenButton.setIcon(exitFullscreenIcon);
            fullscreenButton.setLabel('Exit full screen mode');
        } else {
            fullscreenButton.setIcon(fullscreenIcon);
            fullscreenButton.setLabel('Enter full screen mode');
        }
    });

    const openFileDialog = () => {
        fileDialog().then(files => {
            const file = files[0];
            emu.openFile(file).then(() => {
                if (emu.isInitiallyPaused) emu.start();
            }).catch((err) => {alert(err);});
        });
    }

    const openGameBrowser = () => {
        emu.pause();
        const body = ui.showDialog();
        body.innerHTML = `
            <label>Find games</label>
            <form>
                <input type="search">
                <button type="submit">Search</button>
            </form>
            <div class="results">
            </div>
        `;
        const input = body.querySelector('input');
        const searchButton = body.querySelector('button');
        const searchForm = body.querySelector('form');
        const resultsContainer = body.querySelector('.results');

        searchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            searchButton.innerText = 'Searching...';
            const searchTerm = input.value.replace(/[^\w\s\-\']/, '');

            const encodeParam = (key, val) => {
                return encodeURIComponent(key) + '=' + encodeURIComponent(val);
            }

            const searchUrl = (
                'https://archive.org/advancedsearch.php?'
                + encodeParam('q', 'collection:softwarelibrary_zx_spectrum title:"' + searchTerm + '"')
                + '&' + encodeParam('fl[]', 'creator')
                + '&' + encodeParam('fl[]', 'identifier')
                + '&' + encodeParam('fl[]', 'title')
                + '&' + encodeParam('rows', '50')
                + '&' + encodeParam('page', '1')
                + '&' + encodeParam('output', 'json')
            )
            fetch(searchUrl).then(response => {
                searchButton.innerText = 'Search';
                return response.json();
            }).then(data => {
                resultsContainer.innerHTML = '<ul></ul><p>- powered by <a href="https://archive.org/">Internet Archive</a></p>';
                const ul = resultsContainer.querySelector('ul');
                const results = data.response.docs;
                results.forEach(result => {
                    const li = document.createElement('li');
                    ul.appendChild(li);
                    const resultLink = document.createElement('a');
                    resultLink.href = '#';
                    resultLink.innerText = result.title;
                    const creator = document.createTextNode(' - ' + result.creator)
                    li.appendChild(resultLink);
                    li.appendChild(creator);
                    resultLink.addEventListener('click', (e) => {
                        e.preventDefault();
                        fetch(
                            'https://archive.org/metadata/' + result.identifier
                        ).then(response => response.json()).then(data => {
                            let chosenFilename = null;
                            data.files.forEach(file => {
                                const ext = file.name.split('.').pop().toLowerCase();
                                if (ext == 'z80' || ext == 'sna' || ext == 'tap' || ext == 'tzx' || ext == 'szx') {
                                    chosenFilename = file.name;
                                }
                            });
                            if (!chosenFilename) {
                                alert('No loadable file found');
                            } else {
                                const finalUrl = 'https://cors.archive.org/cors/' + result.identifier + '/' + chosenFilename;
                                emu.openUrl(finalUrl).catch((err) => {
                                    alert(err);
                                }).then(() => {
                                    ui.hideDialog();
                                    emu.start();
                                });
                            }
                        })
                    })
                })
            })
        })
        input.focus();
    }

    const exit = () => {
        emu.exit();
        ui.unload();
    }

    /*
        const benchmarkElement = document.getElementById('benchmark');
        setInterval(() => {
            benchmarkElement.innerText = (
                "Running at " + benchmarkRunCount + "fps, rendering at "
                + benchmarkRenderCount + "fps"
            );
            benchmarkRunCount = 0;
            benchmarkRenderCount = 0;
        }, 1000)
    */

    return {
        setZoom: (zoom) => {ui.setZoom(zoom);},
        toggleFullscreen: () => {ui.toggleFullscreen();},
        enterFullscreen: () => {ui.enterFullscreen();},
        exitFullscreen: () => {ui.exitFullscreen();},
        setMachine: (model) => {emu.setMachine(model);},
        openFileDialog: () => {openFileDialog();},
        openUrl: (url) => {
            emu.openUrl(url).catch((err) => {alert(err);});
        },
        exit: () => {exit();},
    };
};
