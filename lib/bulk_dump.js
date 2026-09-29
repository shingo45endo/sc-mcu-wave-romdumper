// Reading a dump back out of a Roland bulk dump.
//
// The counterpart of file_dump.js, for a synth that cannot send a dump by itself. The program the host loads into it
// leaves the result in areas of RAM that the firmware will hand back when asked, and the host asks with an RQ1 and
// records the replies.
//
//
// A pass
// ------
// One filling of the buffer. The host puts the header and the request in place, calls the program, then asks for
// every area the buffer is made of.
//
//	->  F0 41 10 42 12  28 00 00  57 01 00 00 00 00 26 4E ...   the pass header, into the front of the buffer
//	->  F0 41 10 42 12  49 1E 00  00 00 ... 00 02 0C 02         where to read and how much
//	->  F0 41 10 42 12  40 10 17  08 00                         the call
//
//	        the program fills the buffer behind the header, and the half of the header that says what it did
//
//	->  F0 41 10 42 11  28 00 00  00 40 00                      ask for the first area
//	<-  F0 41 10 42 12  28 00 00  <128 bytes>                   eleven replies, the address stepping on
//	<-  F0 41 10 42 12  28 01 00  <128 bytes>
//	        ...
//	->  F0 41 10 42 11  28 10 00  00 40 00                      and the same for the other three
//	->  F0 41 10 42 11  29 00 00  00 40 00
//	->  F0 41 10 42 11  29 10 00  00 40 00
//
// The request goes in Drum Map Name because a drum setup address carries whole bytes and the buffer does not.
//
// Asking for H'2000 asks for more than any area holds, and the firmware stops at the end of the area, so one
// request is one whole area whatever an address step means on this revision.
//
// The four areas are one run of RAM, so the replies join up into one buffer:
//
//	28 00 00   1408   User Tone Bank #64   the header, then data
//	28 10 00   1408   User Tone Bank #65   data
//	29 00 00   1424   User Drum Set #65    data
//	29 10 00   1424   User Drum Set #66    data
//	           5664 = 16 + 706 x 8
//
// The file header is the same without the call: the host writes it and asks for it straight back.
//
//	->  F0 41 10 42 12  28 00 00  48 01 01 00 00 00 03 2A 0B 'WAVE_00.BIN'
//	->  F0 41 10 42 11  28 00 00  00 40 00
//
// The content starts with:
//
//	0	mark. 'W' a pass, 'H' the file header
//	1	version
//
// and for a pass:
//
//	2-5	where the data belongs in the file, 28 bits	written by the host
//	6-7	how many bytes of it are data, 14 bits		written by the host
//	8	what went to the wave ROM bank register		written by the program
//	9-10	what went to the wave ROM page register		written by the program
//	11-12	how many groups it filled, 14 bits		written by the program
//	13-14	reads that gave up waiting, 14 bits		written by the program
//	15	spare
//
// and for the file header:
//
//	2-5	the whole file, 28 bits
//	6-7	how many passes follow, 14 bits
//	8	the length of the name
//	9-	the name

import {parseDataMessage, formatAddress} from './gs_message.js';
import {SysexSplitter} from './sysex.js';

const GROUP_SIZE = 8;		// one byte of top bits, then seven of data

export const HEADER_SIZE = 16;
const MARK_PASS = 0x57;	// 'W'
const MARK_FILE = 0x48;	// 'H'
const VERSION = 1;

const AT_AT = 2;
const AT_SIZE = 6;
const AT_BANK = 8;
const AT_PAGE = 9;
const AT_GROUPS = 11;
const AT_GIVE_UP = 13;
const AT_PASS_COUNT = 6;
const AT_NAME_SIZE = 8;
const AT_NAME = 9;

// Seven bits at a time, most significant group first.
function putBits(out, at, value, count) {
	for (let i = 0; i < count; i++) {
		out[at + i] = (value >> (7 * (count - 1 - i))) & 0x7f;
	}
}

function getBits(bytes, at, count) {
	let value = 0;
	for (let i = 0; i < count; i++) {
		value = (value * 128) + (bytes[at + i] & 0x7f);
	}

	return value;
}

// The half of a pass header the host knows before it asks.
export function buildPassHeader({at, size}) {
	const out = new Uint8Array(HEADER_SIZE);
	out[0] = MARK_PASS;
	out[1] = VERSION;
	putBits(out, AT_AT, at, 4);
	putBits(out, AT_SIZE, size, 2);

	return out;
}

export function buildFileHeader({size, passCount, name}) {
	const text = Array.from(name, (c) => c.charCodeAt(0));
	console.assert(text.every((byte) => (byte > 0 && byte < 0x80)), 'a name is seven bit ASCII');
	const out = new Uint8Array(Math.max(HEADER_SIZE, AT_NAME + text.length));
	out[0] = MARK_FILE;
	out[1] = VERSION;
	putBits(out, AT_AT, size, 4);
	putBits(out, AT_PASS_COUNT, passCount, 2);
	out[AT_NAME_SIZE] = text.length;
	out.set(text, AT_NAME);

	return out;
}

function readHeader(bytes) {
	if (bytes.length < HEADER_SIZE || bytes[1] !== VERSION) {
		return null;
	}
	if (bytes[0] === MARK_FILE) {
		const nameSize = bytes[AT_NAME_SIZE];

		return {
			mark: MARK_FILE,
			size: getBits(bytes, AT_AT, 4),
			passCount: getBits(bytes, AT_PASS_COUNT, 2),
			name: String.fromCharCode(...bytes.slice(AT_NAME, AT_NAME + nameSize)),
		};
	}
	if (bytes[0] !== MARK_PASS) {
		return null;
	}

	return {
		mark: MARK_PASS,
		at: getBits(bytes, AT_AT, 4),
		size: getBits(bytes, AT_SIZE, 2),
		bank: bytes[AT_BANK],
		page: getBits(bytes, AT_PAGE, 2),
		groups: getBits(bytes, AT_GROUPS, 2),
		gaveUp: getBits(bytes, AT_GIVE_UP, 2),
	};
}

export class BulkDumpReceiver {
	// regions: [{addr: [family, mm, ll], size}], in the order the host asks for them. A reply to the start of the
	// first one begins the next pass.
	constructor(regions) {
		console.assert(regions.length > 0, 'a receiver needs at least one area to read back');
		this.regions = regions.map((region) => ({
			family: region.addr[0],
			start: toPosition(region.addr),
			size: region.size,
		}));
		this.offsets = [];
		let at = 0;
		for (const region of this.regions) {
			this.offsets.push(at);
			at += region.size;
		}
		this.passSize = at;
		this.passes = [];
		this.errors = [];
		this.current = null;
		this.packets = 0;
		this.splitter = new SysexSplitter((message) => this.handleMessage(message), this.errors);
	}

	// Accept a complete message, a fragment, or a whole capture.
	feed(bytes) {
		this.splitter.feed(bytes);
		return this;
	}

	handleMessage(message) {
		const reply = parseDataMessage(message);
		if (!reply) {
			return;
		}
		if (!reply.isChecksumOk) {
			this.errors.push(`a reply to ${formatAddress(reply.addr)} had a bad checksum`);
			return;
		}

		const place = this.findPlace(reply.addr);
		if (!place) {
			return;		// a reply about something else
		}
		if (place.index === 0 && place.at === 0) {
			this.current = {packed: new Uint8Array(this.passSize), received: 0};
			this.passes.push(this.current);
		}
		if (!this.current) {
			this.errors.push(`a reply to ${formatAddress(reply.addr)} arrived before the start of a pass`);
			return;
		}

		const base = this.offsets[place.index] + place.at;
		for (const [i, byte] of reply.data.entries()) {
			if (base + i < this.passSize) {
				this.current.packed[base + i] = byte;
				this.current.received++;
			}
		}
		this.packets++;
	}

	// Which area a reply belongs to, and how far into it.
	findPlace(addr) {
		const position = toPosition(addr);
		for (const [index, region] of this.regions.entries()) {
			if (region.family === addr[0] && position >= region.start && position < region.start + region.size) {
				return {index, at: position - region.start};
			}
		}

		return null;
	}

	// What every pass says about itself, and what is wrong with it.
	getProperties() {
		return this.passes.map((pass, i) => {
			const header = readHeader(pass.packed);
			const problems = [];
			if (!header) {
				problems.push('no header');
			} else if (header.mark === MARK_PASS) {
				if (pass.received < this.passSize) {
					problems.push(`${this.passSize - pass.received} bytes short`);
				}
				if (header.groups * (GROUP_SIZE - 1) !== header.size) {
					problems.push(`${header.size} bytes wanted but ${header.groups} group(s) filled`);
				}
				if (header.gaveUp) {
					problems.push(`${header.gaveUp} read(s) gave up waiting`);
				}
			}

			return {passNo: i, header, received: pass.received, problems};
		});
	}

	// The file the passes add up to. The size and the name come from the file header unless they are given here.
	getResult({size, name} = {}) {
		const file = this.passes.map((pass) => readHeader(pass.packed)).find((one) => (one?.mark === MARK_FILE));
		const total = size ?? file?.size ?? 0;
		const bytes = new Uint8Array(total);
		const covered = new Uint8Array(total);
		for (const pass of this.passes) {
			const header = readHeader(pass.packed);
			if (header?.mark !== MARK_PASS) {
				continue;
			}
			const data = unpackSeven(pass.packed.subarray(HEADER_SIZE));
			const n = Math.min(header.size, data.length, Math.max(0, total - header.at));
			bytes.set(data.subarray(0, n), header.at);
			covered.fill(1, header.at, header.at + n);
		}

		return {
			name: name ?? file?.name ?? null,
			size: total,
			bytes,
			holes: findHoles(covered),
			isComplete: (total > 0) && covered.every((one) => (one === 1)),
		};
	}
}

// Eight bytes in, seven out.
function unpackSeven(packed) {
	const out = new Uint8Array(Math.floor(packed.length / GROUP_SIZE) * (GROUP_SIZE - 1));
	let at = 0;
	for (let g = 0; g + GROUP_SIZE <= packed.length; g += GROUP_SIZE) {
		const msb = packed[g];
		for (let k = 0; k < GROUP_SIZE - 1; k++) {
			out[at++] = packed[g + 1 + k] | (((msb >> (GROUP_SIZE - 2 - k)) & 1) << 7);
		}
	}

	return out;
}

// The runs of the file no pass covered, so that asking again can be aimed at them.
function findHoles(covered) {
	const holes = [];
	let from = -1;
	for (let i = 0; i <= covered.length; i++) {
		if (i < covered.length && !covered[i]) {
			if (from < 0) {
				from = i;
			}
		} else if (from >= 0) {
			holes.push({at: from, size: i - from});
			from = -1;
		}
	}

	return holes;
}

// A bulk dump address counts one step per byte, across mm and ll.
function toPosition(addr) {
	return (addr[1] << 7) | addr[2];
}

// The file the passes add up to, in the shape getFileDumpResults() in file_dump.js gives. What the passes say about
// themselves - a pass that complained, a gap nothing covered - becomes that file's errors. `size` and `name` override
// what the file header said, for a capture that never carried one.
export function getBulkDumpResult(receiver, {size, name} = {}) {
	const result = receiver.getResult({size, name});
	const errors = [...receiver.errors];
	for (const pass of receiver.getProperties()) {
		for (const problem of pass.problems) {
			errors.push(`pass ${pass.passNo}: ${problem}`);
		}
	}
	for (const hole of result.holes) {
		errors.push(`nothing covers ${hole.size} bytes at H'${hole.at.toString(16).toUpperCase()}`);
	}
	const missingBytes = result.holes.reduce((total, hole) => (total + hole.size), 0);

	return {
		name: result.name,
		size: result.size,
		received: result.size - missingBytes,
		packets: receiver.packets,
		errors,
		isComplete: result.isComplete,
		bytes: result.bytes,
	};
}
