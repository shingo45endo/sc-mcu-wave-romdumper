// --------------------------------
// scrambling
// --------------------------------

// logical data bit j comes from ROM data bit DATA_BITS[j]
const DATA_BITS = [2, 0, 4, 5, 7, 6, 3, 1];
console.assert((new Set(DATA_BITS)).size === 8, 'DATA_BITS must name every data bit exactly once');

const TO_LOGICAL = new Uint8Array(256);
const TO_ROM = new Uint8Array(256);
for (let b = 0; b < 256; b++) {
	let v = 0;
	for (let j = 0; j < 8; j++) {
		if (b & (1 << DATA_BITS[j])) {
			v |= 1 << j;
		}
	}
	TO_LOGICAL[b] = v;
	TO_ROM[v] = b;
}

// Logical address bit j drives ROM address bit ADDR_BITS[j].
const ADDR_BITS = [
	2, 0, 3, 4, 1, 9, 13, 10, 18, 17, 6, 15, 11, 16, 8, 5, 12, 7, 14, 19, 20,
];

// A device gets a 2 MiB slot of address, of which 1 MiB is the common case.
const IMAGE_BITS = 20;
console.assert(ADDR_BITS.length === IMAGE_BITS + 1, 'ADDR_BITS must cover every address bit a 2 MiB device has');

// Turn a dump taken through the read port into an ordinary ROM image.
export function convertToRomImage(port, bits = calcBitsForSize(port.length)) {
	const size = 1 << bits;
	const out = new Uint8Array(size);
	const n = Math.min(port.length, size);
	for (let i = 0; i < n; i++) {
		out[toRomAddr(i, bits)] = TO_ROM[port[i]];
	}
	return out;
}

// The inverse: what the read port would return for a ROM image, for checking one against the other.
export function convertToPortOrder(image, bits = calcBitsForSize(image.length)) {
	const size = 1 << bits;
	const out = new Uint8Array(size);
	const n = Math.min(image.length, size);
	for (let i = 0; i < size; i++) {
		const a = toRomAddr(i, bits);
		if (a < n) {
			out[i] = TO_LOGICAL[image[a]];
		}
	}
	return out;
}

// How many address bits a device of this many bytes needs.
function calcBitsForSize(size) {
	let bits = 0;
	while ((1 << bits) < size) {
		bits++;
	}
	if (bits > ADDR_BITS.length) {
		throw new Error(`a device of ${size} bytes needs more address bits than ` +
			`the permutation covers (${ADDR_BITS.length})`);
	}
	return bits;
}

// Address seen by a device, given the address the PCM chip drove.
function toRomAddr(logical, bits = IMAGE_BITS) {
	let a = 0;
	for (let j = 0; j < bits; j++) {
		if (logical & (1 << j)) {
			a |= 1 << ADDR_BITS[j];
		}
	}
	return a >>> 0;
}

// --------------------------------
// recognising it
// --------------------------------

// Every Roland wave ROM starts with 32 ASCII bytes beginning "Roland". Useful for telling a correct conversion from a wrong one.
export function looksLikeWaveRom(bytes) {
	const head = String.fromCharCode(...bytes.slice(0, 6));
	return head.toLowerCase() === 'roland';
}

export function toHeaderText(bytes) {
	let s = '';
	for (const byte of bytes.slice(0, 32)) {
		s += (byte >= 0x20 && byte < 0x7f) ? String.fromCharCode(byte) : '.';
	}
	return s;
}
