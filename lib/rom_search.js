// Finding things in a firmware ROM image.

// Every match of a byte pattern, in which null means "any byte".
export function findPatternAll(rom, pattern, limit = Infinity) {
	const offsets = [];
	const end = rom.length - pattern.length;
	const first = pattern[0];
	for (let i = 0; i <= end; i++) {
		if (rom[i] !== first) {
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
	for (let k = 0; k < pattern.length; k++) {
		const want = pattern[k];
		if (want !== null && rom[at + k] !== want) {
			return false;
		}
	}

	return true;
}

// A big endian word.
export function toWord(rom, at) {
	return (rom[at] << 8) | rom[at + 1];
}

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		t[n] = c >>> 0;
	}

	return t;
})();

// Ordinary CRC-32, the one a zip file uses.
export function calcCrc32(bytes) {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	}

	return (c ^ 0xffffffff) >>> 0;
}
