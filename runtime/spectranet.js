import {Buffer} from "buffer";


export class SpectranetConfigurationOption {
    constructor(type, value) {
        this.type = type;
        this.value = value;
    }
}

export class SpectranetConfiguration {
    /*
        Organization in memory:

        Total cfg size:		2 bytes (first 2 bytes of 4K page)

        Then come the sections.
        Each section looks like this:
        Section-ID		2 bytes
        Section-size		2 bytes
        First cfg item ID	1 byte
        Cfg data		N bytes
        Second cfg item ID	1 byte
        Cfg data		N bytes
        Nth cfg item ID		1 byte
        ... and so on.
     */

    constructor(memory) {
        this.sections = {}
        this.load(memory);
    }

    getUInt(memory, location) {
        return memory[location] + memory[location + 1] * 256;
    }

    setUInt(memory, location, value) {
        memory[location] = value & 0xFF;
        memory[location + 1] = (value & 0xFF00) >> 8;
    }

    obtainSection(id) {
        if (this.sections.hasOwnProperty(id))
        {
            return this.sections[id];
        }

        const newSection = {};
        this.sections[id] = newSection;
        return newSection;
    }

    load(memory) {
        const totalSize = this.getUInt(memory, 0);
        let pointer = 2;
        while (pointer < totalSize) {
            const sectionID = this.getUInt(memory, pointer);
            pointer += 2;
            const sectionSize = this.getUInt(memory, pointer);
            pointer += 2;
            const newSection = {};

            this.sections[sectionID] = newSection;

            const sectionEnd = pointer + sectionSize;
            while (pointer < sectionEnd) {
                const itemID = memory[pointer];
                pointer += 1;

                /*
                    The two most significant bits of the config item ID indicate what the
                    thing is:

                    00			Null terminated string
                    01			reserved
                    10			8 bit value
                    11			16 bit value
                 */

                switch (itemID & 0xC0) {
                    case 0x00: {
                        let stringPointer = pointer;
                        while (memory[stringPointer]) {
                            stringPointer += 1;
                        }

                        newSection[itemID] = new SpectranetConfigurationOption(
                            "string", Buffer.from(memory.slice(pointer, stringPointer)).toString());

                        pointer = stringPointer + 1;
                        break;
                    }
                    case 0x80: {
                        newSection[itemID] = new SpectranetConfigurationOption(
                            "byte", memory[pointer]);

                        pointer += 1;
                        break;
                    }
                    case 0xC0: {
                        newSection[itemID] = new SpectranetConfigurationOption(
                            "int", this.getUInt(memory, pointer));
                        pointer += 2;
                        break;
                    }
                }
            }
        }
    }

    bake() {
        let totalSize = 2;
        for (let sectionID in this.sections) {
            totalSize += 4; // section id + section size
            const section = this.sections[sectionID];
            for (let optionId in section) {
                const option = section[optionId];
                switch (option.type) {
                    case "string":
                    {
                        totalSize += 2 + option.value.length;
                        break;
                    }
                    case "byte":
                    {
                        totalSize += 2;
                        break;
                    }
                    case "int":
                    {
                        totalSize += 3;
                        break;
                    }
                }
            }
        }
        const data = new Uint8Array(totalSize + 2);
        this.setUInt(data, 0, totalSize);

        // terminator
        data[totalSize] = 0xFF;
        data[totalSize + 1] = 0xFF;

        let pointer = 2;

        for (let sectionID in this.sections) {
            this.setUInt(data, pointer, parseInt(sectionID));
            pointer += 2;
            const sectionSizePointer = pointer;
            let sectionSize = 0;
            pointer += 2;

            const section = this.sections[sectionID];
            for (let optionId in section) {
                data[pointer] = parseInt(optionId);
                pointer += 1;

                const option = section[optionId];
                switch (option.type) {
                    case "string":
                    {
                        sectionSize += 2 + option.value.length;
                        data.set(new Uint8Array(Buffer.from(option.value)), pointer);
                        pointer += option.value.length;
                        data[pointer] = 0;
                        pointer += 1;
                        break;
                    }
                    case "byte":
                    {
                        data[pointer] = option.value;
                        sectionSize += 2;
                        pointer += 1;
                        break;
                    }
                    case "int":
                    {
                        this.setUInt(data, pointer, option.value);
                        sectionSize += 3;
                        pointer += 2;
                        break;
                    }
                }
            }

            this.setUInt(data, sectionSizePointer, sectionSize);
        }

        return data;
    }
}