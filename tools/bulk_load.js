const DEFAULT_DEVICE = 0x10;	// GS device 17, the factory default
const BLOCK_SIZE = 0x40;		// bulk dump address granularity
const MAX_BLOCK = 15;

// block -> the low nibble that selects it, undoing the handler's swizzle
const BLOCK_NIBBLE = {0: 2, 1: 3, 2: 0, 3: 1};
console.assert(
	Object.entries(BLOCK_NIBBLE).every(([blockNo, nibble]) => (BLOCK_NIBBLE[nibble] === Number(blockNo))),
	'the block swizzle must be its own inverse',
);

// One message per 64-byte block of `image`, loaded at `start` bytes into the drum map. `start` has to be a multiple of 64.
export function buildBulkMessages(image, start = 0, {mapNo = 1, device = DEFAULT_DEVICE} = {}) {
	if (start % BLOCK_SIZE) {
		throw new Error('the load offset must be a multiple of 64');
	}

	const messages = [];
	for (let i = 0; i < image.length; i += BLOCK_SIZE) {
		const blockNo = (start + i) / BLOCK_SIZE;
		if (blockNo > MAX_BLOCK) {
			throw new Error(`block ${blockNo} is past the ${MAX_BLOCK + 1} the handler can address`);
		}
		const mm = (mapNo << 4) | ((blockNo in BLOCK_NIBBLE) ? BLOCK_NIBBLE[blockNo] : blockNo);
		messages.push(buildDt1Message([0x49, mm, 0x00], toNibbles(image.slice(i, i + BLOCK_SIZE)), device));
	}

	return messages;
}

export function gsResetMessage({device = DEFAULT_DEVICE} = {}) {
	return buildDt1Message([0x40, 0x00, 0x7f], [0x00], device);
}

// DT1 to 40 1x 17 - the parameter the ROM hook is attached to.
export function triggerMessage({partNo = 0, device = DEFAULT_DEVICE} = {}) {
	return buildDt1Message([0x40, 0x10 | (partNo & 0x0f), 0x17], [0x08, 0x00], device);
}

function buildDt1Message(addr, data, device = DEFAULT_DEVICE) {
	return buildRolandMessage(0x12, [...addr, ...data], device);
}

function toNibbles(bytes) {
	const values = [];
	for (const byte of bytes) {
		values.push((byte >> 4) & 0x0f, byte & 0x0f);
	}
	return values;
}

function buildRolandMessage(command, body, device) {
	return Uint8Array.from([0xf0, 0x41, device, 0x42, command, ...body, calcChecksum(body), 0xf7]);
}

function calcChecksum(bytes) {
	let s = 0;
	for (const byte of bytes) {
		s = (s + byte) & 0x7f;
	}
	return (128 - s) & 0x7f;
}
