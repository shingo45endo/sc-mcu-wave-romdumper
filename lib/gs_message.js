// The Roland messages both the build tools and the page send.

export const DEFAULT_DEVICE_ID = 0x10;	// GS device 17, the factory default

const ADDR_SIZE = 3;

const SYSTEM_INFO_SIZE = 0x20;
const PING_ADDR = [0x40, 0x30, 0x00];
const PING_SIZE = [0x00, 0x00, SYSTEM_INFO_SIZE];

export function gsResetMessage({device = DEFAULT_DEVICE_ID} = {}) {
	return buildDt1Message([0x40, 0x00, 0x7f], [0x00], device);
}

// Write anything to one address. What an address step means is the area's own: the drum maps count nibbles, the user areas count bytes.
export function buildWriteMessage(addr, bytes, {isNibble = true, device = DEFAULT_DEVICE_ID} = {}) {
	return buildDt1Message(addr, (isNibble) ? toNibbles(bytes) : Array.from(bytes), device);
}

// RQ1, asking for `size` address steps from `addr`.
export function buildRequestMessage(addr, size, {device = DEFAULT_DEVICE_ID} = {}) {
	return buildRolandMessage(0x11, [...addr, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f], device);
}

// F0 41 10 42 11 40 30 00 00 00 20 70 F7
export function pingMessage(device = DEFAULT_DEVICE_ID) {
	return buildRolandMessage(0x11, [...PING_ADDR, ...PING_SIZE], device);
}

// The device id and the block of a reply to pingMessage, or null if this is not one.
export function parsePingReply(message) {
	const reply = parseDataMessage(message);
	if (!reply || !reply.isChecksumOk || reply.data.length < 2 || PING_ADDR.some((byte, i) => (reply.addr[i] !== byte))) {
		return null;
	}

	return {device: reply.device, data: reply.data};
}

// A DT1 message taken apart, or null if it is not one. A bad checksum is reported rather than refused, so the caller
// can say so.
export function parseDataMessage(message) {
	if (message.length < 5 + ADDR_SIZE + 2 || message[0] !== 0xf0 || message[1] !== 0x41 || message[3] !== 0x42 || message[4] !== 0x12) {
		return null;
	}
	const body = message.slice(5, -2);

	return {
		device: message[2],
		addr: Array.from(body.slice(0, ADDR_SIZE)),
		data: Uint8Array.from(body.slice(ADDR_SIZE)),
		isChecksumOk: (calcChecksum(body) === message[message.length - 2]),
	};
}

// Rewrite the device id of a prepared Roland message. No checksum covers that byte, so the prepared .syx files can be
// retargeted without rebuilding them. Anything that is not a Roland message is returned untouched.
export function rewriteDeviceId(message, device) {
	const out = Uint8Array.from(message);
	if (out.length > 5 && out[0] === 0xf0 && out[1] === 0x41 && out[3] === 0x42) {
		out[2] = device & 0x7f;
	}

	return out;
}

// The three bytes of a bulk dump address, from the text a catalogue writes it in: "28 00 00".
export function toAddress(text) {
	const bytes = text.trim().split(/\s+/u).map((token) => parseInt(token, 16));
	if (bytes.length !== ADDR_SIZE || bytes.some((byte) => !(byte >= 0 && byte <= 0x7f))) {
		throw new Error(`${JSON.stringify(text)} is not a bulk dump address`);
	}

	return bytes;
}

export function toAddressText(body) {
	return [...body.slice(0, ADDR_SIZE)].map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
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
