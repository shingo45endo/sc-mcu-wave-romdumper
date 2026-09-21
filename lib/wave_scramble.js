// --------------------------------
// scrambling
// --------------------------------

// logical data bit j comes from ROM data bit dataBits[j]
// logical address bit j drives ROM address bit addrBits[j]
const SCRAMBLES = {
	sc55: {
		dataBits: [2, 0, 4, 5, 7, 6, 3, 1],
		addrBits: [2, 0, 3, 4, 1, 9, 13, 10, 18, 17, 6, 15, 11, 16, 8, 5, 12, 7, 14, 19, 20],
	},
	sc88: {
		dataBits: [2, 0, 4, 5, 7, 6, 3, 1],
		addrBits: [0, 4, 2, 3, 1, 13, 7, 12, 5, 10, 16, 9, 6, 8, 14, 17, 11, 15, 18, 19],
	},
};

const DEFAULT_SCRAMBLE = 'sc55';

const TABLES = new Map();
for (const [name, {dataBits, addrBits}] of Object.entries(SCRAMBLES)) {
	console.assert((new Set(dataBits)).size === 8, `${name}: dataBits must name every data bit exactly once`);
	console.assert((new Set(addrBits)).size === addrBits.length &&
		Math.max(...addrBits) === addrBits.length - 1, `${name}: addrBits must be a permutation`);
	const toLogical = new Uint8Array(256);
	const toRom = new Uint8Array(256);
	for (let b = 0; b < 256; b++) {
		let v = 0;
		for (let j = 0; j < 8; j++) {
			if (b & (1 << dataBits[j])) {
				v |= 1 << j;
			}
		}
		toLogical[b] = v;
		toRom[v] = b;
	}
	TABLES.set(name, {toLogical, toRom, addrBits});
}

export function getScrambleNames() {
	return [...TABLES.keys()];
}

function getTable(scramble) {
	const table = TABLES.get(scramble);
	if (!table) {
		throw new Error(`no such scrambling: ${scramble}. Known: ${getScrambleNames().join(', ')}`);
	}

	return table;
}

// Turn a dump taken through the read port into an ordinary ROM image.
export function convertToRomImage(port, {scramble = DEFAULT_SCRAMBLE, bits = calcBitsForSize(port.length)} = {}) {
	const {toRom, addrBits} = getTable(scramble);
	const size = 1 << bits;
	const out = new Uint8Array(size);
	const n = Math.min(port.length, size);
	for (let i = 0; i < n; i++) {
		out[toRomAddr(i, bits, addrBits)] = toRom[port[i]];
	}

	return out;
}

// The inverse: what the read port would return for a ROM image, for checking one against the other.
export function convertToPortOrder(image, {scramble = DEFAULT_SCRAMBLE, bits = calcBitsForSize(image.length)} = {}) {
	const {toLogical, addrBits} = getTable(scramble);
	const size = 1 << bits;
	const out = new Uint8Array(size);
	const n = Math.min(image.length, size);
	for (let i = 0; i < size; i++) {
		const a = toRomAddr(i, bits, addrBits);
		if (a < n) {
			out[i] = toLogical[image[a]];
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

	return bits;
}

// Address seen by a device, given the address the chip drove. A bit the table does not name passes through.
function toRomAddr(logical, bits, addrBits) {
	let a = 0;
	for (let j = 0; j < bits; j++) {
		if (logical & (1 << j)) {
			a |= 1 << ((j < addrBits.length) ? addrBits[j] : j);
		}
	}

	return a >>> 0;
}

// --------------------------------
// recognizing it
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
