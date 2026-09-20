const DEFAULT_DEVICE_ID = 0x10;	// GS device 17, the factory default
const BLOCK_SIZE = 0x40;		// bulk dump address granularity
const MAX_BLOCK = 15;

// Which block a drum map address selects. The SC-55 family's handler swaps the first four around; the SC-88 family's
// leaves them alone. Named rather than defaulted, because loading a dumper at the wrong address is silent.
const BLOCK_ORDERS = {
	sc55: {0: 2, 1: 3, 2: 0, 3: 1},
	sc88: {},
};
console.assert(
	Object.entries(BLOCK_ORDERS.sc55).every(([blockNo, nibble]) => (BLOCK_ORDERS.sc55[nibble] === Number(blockNo))),
	'the block swizzle must be its own inverse',
);

export function getBlockOrderNames() {
	return Object.keys(BLOCK_ORDERS);
}

// One message per 64-byte block of `image`, loaded at `start` bytes into the drum map. `start` has to be a multiple of 64.
export function buildBulkMessages(image, start = 0, {mapNo = 1, blockOrder, device = DEFAULT_DEVICE_ID} = {}) {
	const nibbleOf = BLOCK_ORDERS[blockOrder];
	if (!nibbleOf) {
		throw new Error(`blockOrder must be one of: ${getBlockOrderNames().join(', ')}`);
	}
	if (start % BLOCK_SIZE) {
		throw new Error('the load offset must be a multiple of 64');
	}

	const messages = [];
	for (let i = 0; i < image.length; i += BLOCK_SIZE) {
		const blockNo = (start + i) / BLOCK_SIZE;
		if (blockNo > MAX_BLOCK) {
			throw new Error(`block ${blockNo} is past the ${MAX_BLOCK + 1} the handler can address`);
		}
		const mm = (mapNo << 4) | ((blockNo in nibbleOf) ? nibbleOf[blockNo] : blockNo);
		messages.push(buildDt1Message([0x49, mm, 0x00], toNibbles(image.slice(i, i + BLOCK_SIZE)), device));
	}

	return messages;
}

export function gsResetMessage({device = DEFAULT_DEVICE_ID} = {}) {
	return buildDt1Message([0x40, 0x00, 0x7f], [0x00], device);
}

// DT1 to 40 10 17 - the parameter the ROM hook is attached to.
export function triggerMessage({device = DEFAULT_DEVICE_ID} = {}) {
	return buildDt1Message([0x40, 0x10, 0x17], [0x08, 0x00], device);
}

// Write anything to one address. What an address step means is the area's own: the drum maps count nibbles, the user
// areas count bytes.
export function buildWriteMessage(addr, bytes, {isNibble = true, device = DEFAULT_DEVICE_ID} = {}) {
	return buildDt1Message(addr, (isNibble) ? toNibbles(bytes) : Array.from(bytes), device);
}

// RQ1, asking for `size` address steps from `addr`. The firmware stops at the end of the area, so asking for more
// than an area holds returns the rest of it, whatever the step means on this revision.
export function buildRequestMessage(addr, size, {device = DEFAULT_DEVICE_ID} = {}) {
	return buildRolandMessage(0x11, [...addr, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f], device);
}

function buildDt1Message(addr, data, device = DEFAULT_DEVICE_ID) {
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
