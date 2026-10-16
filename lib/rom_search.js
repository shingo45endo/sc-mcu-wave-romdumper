// Reading a ROM image: finding things in it, its words and their byte order, and its CRC-32.

// Every match of a byte pattern, in which null means "any byte".
export function findPatternAll(rom, pattern, limit = Infinity) {
	const offsets = [];
	const end = rom.length - pattern.length;
	const firstByte = pattern[0];
	for (let i = 0; i <= end; i++) {
		if (rom[i] !== firstByte) {
			continue;
		}
		if (matchPatternAt(rom, i, pattern)) {
			offsets.push(i);
			if (offsets.length > limit) {
				break;
			}
		}
	}

	return offsets;
}

// Matches a byte pattern in which null means "any byte".
export function matchPatternAt(rom, at, pattern) {
	if (at < 0 || at + pattern.length > rom.length) {
		return false;
	}
	for (let i = 0; i < pattern.length; i++) {
		const patternByte = pattern[i];
		if (patternByte !== null && rom[at + i] !== patternByte) {
			return false;
		}
	}

	return true;
}

// A big endian word.
export function toWord(rom, at) {
	return (rom[at] << 8) | rom[at + 1];
}

// Swap the two bytes of every word. Its own inverse.
export function swapBytes(rom) {
	const out = rom.slice();
	for (let i = 0; i + 1 < out.length; i += 2) {
		const firstByte = out[i];
		out[i] = out[i + 1];
		out[i + 1] = firstByte;
	}

	return out;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let byteValue = 0; byteValue < 256; byteValue++) {
		let crc = byteValue;
		for (let bitNo = 0; bitNo < 8; bitNo++) {
			crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
		}
		table[byteValue] = crc >>> 0;
	}

	return table;
})();

// Ordinary CRC-32, the one a zip file uses.
export function calcCrc32(bytes) {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	}

	return (crc ^ 0xffffffff) >>> 0;
}
