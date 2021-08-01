import EventEmitter from 'events';
import fileDialog from 'file-dialog';

import { FRAME_BUFFER_SIZE } from './constants.js';
import { CanvasRenderer } from './render.js';
import { MenuBar, Toolbar } from './ui.js';
import { parseSNAFile, parseZ80File, parseSZXFile } from './snapshot.js';
import { TAPFile, TZXFile } from './tape.js';
import { KeyboardHandler } from './keyboard.js';

import openIcon from './icons/open.svg';
import resetIcon from './icons/reset.svg';
import fullscreenIcon from './icons/fullscreen.svg';


class Emulator extends EventEmitter {
    constructor(canvas, machineType) {
        super();
        this.canvas = canvas;
        this.worker = new Worker('jsspeccy-worker.js');
        this.keyboardHandler = new KeyboardHandler(this.worker);

        this.renderer = new CanvasRenderer(canvas);

        this.msPerFrame = 20;
        this.frameBuffers = [
            new ArrayBuffer(FRAME_BUFFER_SIZE),
            new ArrayBuffer(FRAME_BUFFER_SIZE),
            new ArrayBuffer(FRAME_BUFFER_SIZE),
        ];
        this.bufferBeingShown = null;
        this.bufferAwaitingShow = null;
        this.lockedBuffer = null;

        this.isRunningFrame = false;
        this.nextFrameTime = performance.now();

        this.worker.onmessage = (e) => {
            switch(e.data.message) {
                case 'ready':
                    this.loadRoms().then(() => {
                        this.setMachine(machineType);
                        this.keyboardHandler.start();
                        window.requestAnimationFrame((t) => {
                            this.runAnimationFrame(t);
                        });
                    })
                    break;
                case 'frameCompleted':
                    // benchmarkRunCount++;
                    this.frameBuffers[this.lockedBuffer] = e.data.frameBuffer;
                    this.bufferAwaitingShow = this.lockedBuffer;
                    this.lockedBuffer = null;
                    const time = performance.now();
                    if (time > this.nextFrameTime) {
                        /* running at full blast - start next frame but adjust time base
                        to give it the full time allocation */
                        this.runFrame();
                        this.nextFrameTime = time + this.msPerFrame;
                    } else {
                        this.isRunningFrame = false;
                    }
                    break;
                default:
                    console.log('message received by host:', e.data);
            }
        }
    }

    async loadRom(url, page) {
        const response = await fetch(url);
        const data = new Uint8Array(await response.arrayBuffer());
        this.worker.postMessage({
            message: 'loadMemory',
            data,
            page: page,
        });
    }

    async loadRoms() {
        await this.loadRom('128-0.rom', 8);
        await this.loadRom('128-1.rom', 9);
        await this.loadRom('48.rom', 10);
    }

    getBufferToLock() {
        for (let i = 0; i < 3; i++) {
            if (i !== this.bufferBeingShown && i !== this.bufferAwaitingShow) {
                return i;
            }
        }
    }

    runFrame() {
        this.isRunningFrame = true;
        this.lockedBuffer = this.getBufferToLock();
        this.worker.postMessage({
            'message': 'runFrame',
            'frameBuffer': this.frameBuffers[this.lockedBuffer],
        }, [this.frameBuffers[this.lockedBuffer]]);
    }

    runAnimationFrame(time) {
        if (this.bufferAwaitingShow !== null) {
            this.bufferBeingShown = this.bufferAwaitingShow;
            this.bufferAwaitingShow = null;
            this.renderer.showFrame(this.frameBuffers[this.bufferBeingShown]);
            this.bufferBeingShown = null;
            // benchmarkRenderCount++;
        }
        if (time > this.nextFrameTime && !this.isRunningFrame) {
            this.runFrame();
            this.nextFrameTime += this.msPerFrame;
        }
        window.requestAnimationFrame((t) => {
            this.runAnimationFrame(t);
        });
    };

    setMachine(type) {
        if (type != 128) type = 48;
        this.worker.postMessage({
            message: 'setMachineType',
            type,
        });
        this.emit('setMachine', type);
    }

    reset() {
        this.worker.postMessage({message: 'reset'});
    }

    loadSnapshot(snapshot) {
        this.worker.postMessage({
            message: 'loadSnapshot',
            snapshot,
        })
        this.emit('setMachine', snapshot.model);
    }

    openTAPFile(data) {
        this.worker.postMessage({
            message: 'openTAPFile',
            data,
        })
    }

    openTZXFile(data) {
        this.worker.postMessage({
            message: 'openTZXFile',
            data,
        })
    }

    openFile(file) {
        const cleanName = file.name.toLowerCase();
        if (cleanName.endsWith('.z80')) {
            file.arrayBuffer().then(arrayBuffer => {
                const z80file = parseZ80File(arrayBuffer);
                this.loadSnapshot(z80file);
            });
        } else if (cleanName.endsWith('.szx')) {
            file.arrayBuffer().then(arrayBuffer => {
                const szxfile = parseSZXFile(arrayBuffer);
                this.loadSnapshot(szxfile);
            });
        } else if (cleanName.endsWith('.sna')) {
            file.arrayBuffer().then(arrayBuffer => {
                const snafile = parseSNAFile(arrayBuffer);
                this.loadSnapshot(snafile);
            });
        } else if (cleanName.endsWith('.tap')) {
            file.arrayBuffer().then(arrayBuffer => {
                if (!TAPFile.isValid(arrayBuffer)) {
                    alert('Invalid TAP file');
                } else {
                    this.openTAPFile(arrayBuffer);
                }
            });
        } else if (cleanName.endsWith('.tzx')) {
            file.arrayBuffer().then(arrayBuffer => {
                if (!TZXFile.isValid(arrayBuffer)) {
                    alert('Invalid TZX file');
                } else {
                    this.openTZXFile(arrayBuffer);
                }
            });
        } else {
            alert('Unrecognised file type: ' + file.name);
        }
    }
}

window.JSSpeccy = (container, opts) => {
    // let benchmarkRunCount = 0;
    // let benchmarkRenderCount = 0;
    opts = opts || {};

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    canvas.style.objectFit = 'contain';

    const appContainer = document.createElement('div');
    container.appendChild(appContainer);

    let zoom;
    let displayWidth;
    let displayHeight;
    let onSetZoom;
    let menuBar = null;
    let toolbar = null;
    let isFullscreen = false;

    const setZoom = (factor) => {
        zoom = factor;
        if (isFullscreen) {
            document.exitFullscreen();
            return;  // setZoom will be retriggered once fullscreen has exited
        }
        displayWidth = 320 * zoom;
        displayHeight = 240 * zoom;
        canvas.style.width = '' + displayWidth + 'px';
        canvas.style.height = '' + displayHeight + 'px';
        appContainer.style.width = '' + displayWidth + 'px';
        if (onSetZoom) onSetZoom(factor);
    }

    const enterFullscreen = () => {
        appContainer.requestFullscreen();
    }
    const exitFullscreen = () => {
        if (isFullscreen) {
            document.exitFullscreen();
        }
    }

    let uiIsHidden = false;
    let allowUIHiding = true;
    const hideUI = () => {
        if (allowUIHiding && !uiIsHidden) {
            uiIsHidden = true;
            appContainer.style.cursor = 'none';
            if (menuBar) menuBar.hide();
            if (toolbar) toolbar.hide();
        }
    }
    const showUI = () => {
        if (uiIsHidden) {
            uiIsHidden = false;
            appContainer.style.cursor = 'default';
            if (menuBar) menuBar.show();
            if (toolbar) toolbar.show();
        }
    }
    let hideUITimeout = null;
    let ignoreNextMouseMove = false;
    const fullscreenMouseMove = () => {
        if (ignoreNextMouseMove) {
            ignoreNextMouseMove = false;
            return;
        }
        showUI();
        if (hideUITimeout) clearTimeout(hideUITimeout);
        hideUITimeout = setTimeout(hideUI, 3000);
    }
    appContainer.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement) {
            isFullscreen = true;
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            document.addEventListener('mousemove', fullscreenMouseMove);
            /* a bogus mousemove event is emitted on entering fullscreen, so ignore it */
            ignoreNextMouseMove = true;
            if (menuBar) {
                menuBar.enterFullscreen();
                menuBar.onmouseenter(() => {allowUIHiding = false;});
                menuBar.onmouseout(() => {allowUIHiding = true;});
            }
            if (toolbar) {
                toolbar.enterFullscreen();
                toolbar.onmouseenter(() => {allowUIHiding = false;});
                toolbar.onmouseout(() => {allowUIHiding = true;});
            }
            hideUI();
            if (onSetZoom) onSetZoom('fullscreen');
        } else {
            isFullscreen = false;
            if (hideUITimeout) clearTimeout(hideUITimeout);
            showUI();
            if (menuBar) {
                menuBar.exitFullscreen();
                menuBar.onmouseenter(null);
                menuBar.onmouseout(null);
            }
            if (toolbar) {
                toolbar.exitFullscreen();
                toolbar.onmouseenter(null);
                toolbar.onmouseout(null);
            }
            document.removeEventListener('mousemove', fullscreenMouseMove);
            setZoom(zoom);
        }
    })

    const emu = new Emulator(canvas, opts.machine || 128);

    if (opts.ui) {
        menuBar = new MenuBar(appContainer);
        const fileMenu = menuBar.addMenu('File');
        fileMenu.addItem('Open...', () => {
            openFileDialog();
        });
        const machineMenu = menuBar.addMenu('Machine');
        const machine48Item = machineMenu.addItem('Spectrum 48K', () => {
            emu.setMachine(48);
        });
        const machine128Item = machineMenu.addItem('Spectrum 128K', () => {
            emu.setMachine(128);
        });
        const displayMenu = menuBar.addMenu('Display');

        const zoomItemsBySize = {
            1: displayMenu.addItem('100%', () => setZoom(1)),
            2: displayMenu.addItem('200%', () => setZoom(2)),
            3: displayMenu.addItem('300%', () => setZoom(3)),
        }
        const fullscreenItem = displayMenu.addItem('Fullscreen', () => {
            enterFullscreen();
        })
        onSetZoom = (factor) => {
            if (factor == 'fullscreen') {
                fullscreenItem.setCheckbox();
                for (let i in zoomItemsBySize) {
                    zoomItemsBySize[i].unsetCheckbox();
                }
            } else {
                fullscreenItem.unsetCheckbox();
                for (let i in zoomItemsBySize) {
                    if (parseInt(i) == factor) {
                        zoomItemsBySize[i].setCheckbox();
                    } else {
                        zoomItemsBySize[i].unsetCheckbox();
                    }
                }
            }
        }

        emu.on('setMachine', (type) => {
            if (type == 48) {
                machine48Item.setCheckbox();
                machine128Item.unsetCheckbox();
            } else {
                machine48Item.unsetCheckbox();
                machine128Item.setCheckbox();
            }
        });
    }

    appContainer.appendChild(canvas);
    canvas.style.display = 'block';

    if (opts.ui) {
        toolbar = new Toolbar(appContainer);
        toolbar.addButton(openIcon, {label: 'Open file'}, () => {
            openFileDialog();
        });
        toolbar.addButton(resetIcon, {label: 'Reset'}, () => {
            emu.reset();
        });
        toolbar.addButton(
            fullscreenIcon,
            {label: 'Enter full screen mode', align: 'right'},
            () => {
                if (isFullscreen) {
                    exitFullscreen();
                } else {
                    enterFullscreen();
                }
            }
        )
    }

    setZoom(opts.zoom || 1);

    const openFileDialog = () => {
        fileDialog().then(files => {
            const file = files[0];
            emu.openFile(file);
        });
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

    return emu;
};
