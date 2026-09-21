// The Roland messages both the build tools and the page send.

export const DEFAULT_DEVICE_ID = 0x10;	// GS device 17, the factory default

export function gsResetMessage({device = DEFAULT_DEVICE_ID} = {}) {
	return buildDt1Message([0x40, 0x00, 0x7f], [0x00], device);
}

// DT1 to 40 10 17 - the parameter the ROM hook is attached to.
export function triggerMessage({device = DEFAULT_DEVICE_ID} = {}) {
	return buildDt1Message([0x40, 0x10, 0x17], [0x08, 0x00], device);
}

// Write anything to one address. What an address step means is the area's own: the drum maps count nibbles, the user areas count bytes.
export function buildWriteMessage(addr, bytes, {isNibble = true, device = DEFAULT_DEVICE_ID} = {}) {
	return buildDt1Message(addr, (isNibble) ? toNibbles(bytes) : Array.from(bytes), device);
}

// RQ1, asking for `size` address steps from `addr`.
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
