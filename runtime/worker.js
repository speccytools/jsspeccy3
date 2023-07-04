import { FRAME_BUFFER_SIZE } from './constants.js';
import { TAPFile, TZXFile } from './tape.js';

let core = null;
let spectranet = null;
let spectranet_memory = null;
let memory = null;
let memoryData = null;
let workerFrameData = null;
let registerPairs = null;
let tapePulses = null;

let stopped = false;
let tape = null;
let tapeIsPlaying = false;
let processMsgFromProxy = null;

const loadCore = (baseUrl) => {

    const sendToProxy = (method, args) => {
        postMessage({
            'message': 'sendToProxy',
            method: method,
            args: args
        });
    };

    const importObject = {
        env: {
            abort: m => { /* ... */ },
            debug_print: (s, len) => {
                console.log(String.fromCharCode.apply(String, new Uint8Array(spectranet_memory.buffer, s, len)));
            },
            nic_socket: (sockfd, s_type) => {
                sendToProxy("socket", [sockfd, s_type]);
            },
            nic_bind: (sockfd, port) => {
                sendToProxy("bind", [sockfd, port]);
            },
            nic_socket_close: (sockfd, s_type) => {
                sendToProxy("socket_close", [sockfd]);
            },
            nic_sendto: (sockfd, address_ptr, address_len, port, buf, len) => {
                sendToProxy("sendto", [sockfd,
                    Array.from(new Uint8Array(spectranet_memory.buffer, address_ptr, address_len)),
                    port, Array.from(new Uint8Array(spectranet_memory.buffer, buf, len))]);
            },
            nic_send: (sockfd, buf, len) => {
                sendToProxy("send", [sockfd, Array.from(new Uint8Array(spectranet_memory.buffer, buf, len))]);
            },
            nic_connect: (sockfd, address_ptr, address_len, port) => {
                sendToProxy("connect", [sockfd,
                    Array.from(new Uint8Array(spectranet_memory.buffer, address_ptr, address_len)), port]);
            }
        }
    };

    WebAssembly.instantiateStreaming(
        fetch(new URL('jsspeccy-spectranet.wasm', baseUrl), {}), importObject
    ).then(results => {
        spectranet = results.instance.exports;
        spectranet_memory = spectranet.memory;

        const recv_buffer = spectranet.recv_buffer;

        processMsgFromProxy = (method, args) => {
            switch (method)
            {
                case 'recv':
                {
                    const socketId = args[0];
                    const pay = args[1];
                    const array = new Int8Array(spectranet_memory.buffer, recv_buffer, pay.buffer.length);
                    array.set(pay.buffer);
                    spectranet.compat_rx_data(socketId, pay.buffer.length);
                    break;
                }
                case 'connected':
                {
                    const socketId = args[0];
                    const success = args[1];
                    spectranet.compat_connected(socketId, success);
                    break;
                }
            }
        };

        const spectranetImportObject = {
            env: {
                abort: m => { /* ... */ },
                spectranetReset: () => spectranet.nic_w5100_reset(),
                spectranetRead: (reg) => spectranet.nic_w5100_read(reg),
                spectranetWrite: (reg, val) => spectranet.nic_w5100_write(reg, val),
                updateSpectranetIO: () => spectranet.nic_w5100_io(),
                extWriteSpectranetROM: (addr, val) => {
                    postMessage({
                        'message': 'writeSpectranetROM',
                        addr: addr,
                        val: val
                    });
                },
                extEraseSpectranetROM: (from, to, val) => {
                    postMessage({
                        'message': 'eraseSpectranetROM',
                        from: from,
                        to: to,
                        val: val
                    });
                }
            }
        };

        WebAssembly.instantiateStreaming(
            fetch(new URL('jsspeccy-core.wasm', baseUrl), {}), spectranetImportObject
        ).then(results => {
            core = results.instance.exports;
            memory = core.memory;
            memoryData = new Uint8Array(memory.buffer);
            workerFrameData = memoryData.subarray(core.FRAME_BUFFER, FRAME_BUFFER_SIZE);
            registerPairs = new Uint16Array(core.memory.buffer, core.REGISTERS, 12);
            tapePulses = new Uint16Array(core.memory.buffer, core.TAPE_PULSES, core.TAPE_PULSES_LENGTH);

            core.resetROM();

            postMessage({
                'message': 'ready',
            });
        });
    });

};

const loadMemoryPage = (page, offset, data) => {
    memoryData.set(data, core.MACHINE_MEMORY + page * 0x1000 + offset);
};

const fetchMemoryPage = (page, offset, len) => {
    const begin = core.MACHINE_MEMORY + page * 0x1000 + offset;
    return memoryData.slice(begin, begin + len);
};

const loadSnapshot = (snapshot) => {
    core.setMachineType(snapshot.model);
    for (let page in snapshot.memoryPages) {
        loadMemoryPage(page, 0, snapshot.memoryPages[page]);
    }
    ['AF', 'BC', 'DE', 'HL', 'AF_', 'BC_', 'DE_', 'HL_', 'IX', 'IY', 'SP', 'IR'].forEach(
        (r, i) => {
            registerPairs[i] = snapshot.registers[r];
        }
    )
    core.setPC(snapshot.registers.PC);
    core.setIFF1(snapshot.registers.iff1);
    core.setIFF2(snapshot.registers.iff2);
    core.setIM(snapshot.registers.im);
    core.setHalted(!!snapshot.halted);

    core.writePort(0x00fe, snapshot.ulaState.borderColour);
    if (snapshot.model != 48) {
        core.writePort(0x7ffd, snapshot.ulaState.pagingFlags);
    }

    core.setTStates(snapshot.tstates);
};

const trapTapeLoad = () => {
    if (!tape) return;
    const block = tape.getNextLoadableBlock();
    if (!block) return;

    /* get expected block type and load vs verify flag from AF' */
    const af_ = registerPairs[4];
    const expectedBlockType = af_ >> 8;
    const shouldLoad = af_ & 0x0001;  // LOAD rather than VERIFY
    let addr = registerPairs[8];  /* IX */
    const requestedLength = registerPairs[2];  /* DE */
    const actualBlockType = block[0];

    let success = true;
    if (expectedBlockType != actualBlockType) {
        success = false;
    } else {
        if (shouldLoad) {
            let offset = 1;
            let loadedBytes = 0;
            let checksum = actualBlockType;
            while (loadedBytes < requestedLength) {
                if (offset >= block.length) {
                    /* have run out of bytes to load */
                    success = false;
                    break;
                }
                const byte = block[offset++];
                loadedBytes++;
                core.poke(addr, byte);
                addr = (addr + 1) & 0xffff;
                checksum ^= byte;
            }

            // if loading is going right, we should still have a checksum byte left to read
            success &= (offset < block.length);
            if (success) {
                const expectedChecksum = block[offset];
                success = (checksum === expectedChecksum);
            }
        } else {
            // VERIFY. TODO: actually verify.
            success = true;
        }
    }

    if (success) {
        /* set carry to indicate success */
        registerPairs[0] |= 0x0001;
    } else {
        /* reset carry to indicate failure */
        registerPairs[0] &= 0xfffe;
    }
    core.setPC(0x05e2);  /* address at which to exit the tape trap */
}

onmessage = (e) => {
    switch (e.data.message) {
        case 'loadCore':
            loadCore(e.data.baseUrl);
            break;
        case 'runFrame':
            if (stopped) return;
            const frameBuffer = e.data.frameBuffer;
            const frameData = new Uint8Array(frameBuffer);

            let audioBufferLeft = null;
            let audioBufferRight = null;
            let audioLength = 0;
            if ('audioBufferLeft' in e.data) {
                audioBufferLeft = e.data.audioBufferLeft;
                audioBufferRight = e.data.audioBufferRight;
                audioLength = audioBufferLeft.byteLength / 4;
                core.setAudioSamplesPerFrame(audioLength);
            } else {
                core.setAudioSamplesPerFrame(0);
            }

            if (tape && tapeIsPlaying) {
                const tapePulseBufferTstateCount = core.getTapePulseBufferTstateCount();
                const tapePulseWriteIndex = core.getTapePulseWriteIndex();
                const [newTapePulseWriteIndex, tstatesGenerated, tapeFinished] = tape.pulseGenerator.emitPulses(
                    tapePulses, tapePulseWriteIndex, 80000 - tapePulseBufferTstateCount
                );
                core.setTapePulseBufferState(newTapePulseWriteIndex, tapePulseBufferTstateCount + tstatesGenerated);
                if (tapeFinished) {
                    tapeIsPlaying = false;
                    postMessage({
                        message: 'stoppedTape',
                    });
                }
            }

            let status = core.runFrame();
            while (status) {
                switch (status) {
                    case 1:
                        stopped = true;
                        throw("Unrecognised opcode!");
                    case 2:
                        trapTapeLoad();
                        break;
                    default:
                        stopped = true;
                        throw("runFrame returned unexpected result: " + status);
                }

                status = core.resumeFrame();
            }

            frameData.set(workerFrameData);
            if (audioLength) {
                const leftSource = new Float32Array(core.memory.buffer, core.AUDIO_BUFFER_LEFT, audioLength);
                const rightSource = new Float32Array(core.memory.buffer, core.AUDIO_BUFFER_RIGHT, audioLength);
                const leftData = new Float32Array(audioBufferLeft);
                const rightData = new Float32Array(audioBufferRight);
                leftData.set(leftSource);
                rightData.set(rightSource);
                postMessage({
                    message: 'frameCompleted',
                    frameBuffer,
                    audioBufferLeft,
                    audioBufferRight,
                }, [frameBuffer, audioBufferLeft, audioBufferRight]);
            } else {
                postMessage({
                    message: 'frameCompleted',
                    frameBuffer,
                }, [frameBuffer]);
            }

            break;
        case 'keyDown':
            core.keyDown(e.data.row, e.data.mask);
            break;
        case 'keyUp':
            core.keyUp(e.data.row, e.data.mask);
            break;
        case 'setMachineType':
            core.setMachineType(e.data.type);
            break;
        case 'reset':
            core.reset();
            break;
        case 'nmi':
            core.nonMaskableInterrupt();
            break;
        case 'dump':
            core.dump();
            break;
        case 'loadMemory':
            loadMemoryPage(e.data.page, e.data.offset, e.data.data);
            break;
        case 'fetchMemory':
            var result = fetchMemoryPage(e.data.page, e.data.offset, e.data.len);
            postMessage({
                message: 'memoryFetched',
                data: result,
                id: e.data.id
            });
            break;
        case 'loadSnapshot':
            loadSnapshot(e.data.snapshot);
            postMessage({
                message: 'fileOpened',
                id: e.data.id,
                mediaType: 'snapshot',
            });
            break;
        case 'openTAPFile':
            tape = new TAPFile(e.data.data);
            tapeIsPlaying = false;
            postMessage({
                message: 'fileOpened',
                id: e.data.id,
                mediaType: 'tape',
            });
            break;
        case 'openTZXFile':
            tape = new TZXFile(e.data.data);
            tapeIsPlaying = false;
            postMessage({
                message: 'fileOpened',
                id: e.data.id,
                mediaType: 'tape',
            });
            break;
        
        case 'playTape':
            if (tape && !tapeIsPlaying) {
                tapeIsPlaying = true;
                postMessage({
                    message: 'playingTape',
                });
            }
            break;
        case 'stopTape':
            if (tape && tapeIsPlaying) {
                tapeIsPlaying = false;
                postMessage({
                    message: 'stoppedTape',
                });
            }
            break;
        case 'setTapeTraps':
            core.setTapeTraps(e.data.value);
            break;
        case 'msg':
            const method = e.data.method;
            const args = e.data.args;
            processMsgFromProxy(method, args);
            break;
        case 'proxyTerm':
            spectranet.compat_proxy_term();
            break;
        default:
            console.log('message received by worker:', e.data);
    }
};
