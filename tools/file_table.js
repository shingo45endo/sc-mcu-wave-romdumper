const SRC_MCU = 0;              // page 0 of the CPU address space
const SRC_PCM = 1;              // through the PCM chip's wave ROM read port
const SRC_END = 0xff;

const PACKET_BYTES = 112;       // file bytes carried by one dump packet

export const SOURCE_NAMES = {[SRC_MCU]: 'mcu', [SRC_PCM]: 'wave'};

// Bytes -> the files the table lists. `table` starts at the table's first byte.
export function parseTable(table) {
	const bytes = (table instanceof Uint8Array) ? table : new Uint8Array(table);
	let i = 0;
	while (i + 3 < bytes.length && (bytes[i] || bytes[i + 1])) {
		i += 4;
	}
	i += 2;	// the H'0000 terminator

	const files = [];
	while (i < bytes.length && bytes[i] !== SRC_END) {
		const source = bytes[i];
		const addr = (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
		const size = (bytes[i + 4] << 16) | (bytes[i + 6] << 8) | bytes[i + 7];
		let end = i + 8;
		while (end < bytes.length && bytes[end]) {
			end++;
		}
		let name = '';
		for (let k = i + 8; k < end; k++) {
			name += String.fromCharCode(bytes[k]);
		}
		console.assert(size > 0, `the file table entry at ${i} asks for no bytes`);
		files.push({
			source, addr, size, name,
			packets: Math.ceil(size / PACKET_BYTES),
			offset: i,
		});
		i = (end + 2) & ~1;	// past the NUL, then even
	}
	if (i >= bytes.length) {
		throw new Error('the file table has no H\'FF terminator');
	}

	return files;
}

// How much MIDI a table's worth of dumping is, and how long it takes.
export function estimateDumpTime({files}) {
	const packets = files.reduce((p, file) => p + file.packets, 0);
	const midiBytes = packets * 137 + files.length * 30;	// a data packet is 137 bytes on the wire, a header about 30

	return {packets, midiBytes, seconds: Math.round(midiBytes / 3125)};
}
