// Word the payload puts at LOADADDR+2 so a hook can tell it is loaded.
export const MAGIC_WORD = 0xc0da;   // "coda" - the musical jump-here mark

// Bytes the trampoline needs in free ROM space.
const TRAMPOLINE_SIZE = 15;

// The address where the trampoline code is placed.
// If there is no free space at this location, search for a free ROM space.
const TRAMPOLINE_ADDR = 0xff70;

// Drum set 2's parameter area, which is where the dumper is loaded.
const LOAD_ADDR = 0x8cd4;

// --------------------------------
// reading a ROM
// --------------------------------
export function analyzeRom(rom) {
	if (!(rom instanceof Uint8Array)) {
		rom = new Uint8Array(rom);
	}
	const hook = findHook(rom);
	const bank = (hook.isOk) ? hook.offset & ~0xffff : 0;
	const shaped = (hook.isOk) ? findTrampoline(rom) : null;
	const table = (hook.isOk)
		? findTableEntry(rom, hook.offset, [bank + TRAMPOLINE_ADDR, shaped])
		: {isOk: false, reasonCode: 'no-hook'};
	const stub = (hook.isOk && table.isOk)
		? findStub(rom, hook, table)
		: {isOk: false, isPatched: false, reasonCode: (hook.isOk) ? 'no-table-entry' : 'no-hook'};

	return {
		size: rom.length,
		crc32: calcCrc32(rom),
		version: findVersionString(rom),
		hook,
		table,
		stub,
		hasUnknownPatch: hook.isOk && !table.isOk && hasMagic(rom),
		isReady: hook.isOk && table.isOk && stub.isOk,
		loadAddr: LOAD_ADDR,
	};
}

// The routine always starts with ADD:G.W #2,R5, and the routine in front of it always ends with RTS,
// so "19 AD 09" pins the entry down. Between it and the core sit 11 to 20 bytes that differ from model to model.
const ENTRY_BACK_MIN = 8;
const ENTRY_BACK_MAX = 48;

// The body of dt1_write_nibble2 assembles one byte out of two SysEx nibbles. The high nibble is shifted up four times in a row:
//     A0 84        MOV:G.B  R0,R4
//     A4 1A        SHLL.B   R4     x4
const NIBBLE_CORE = [
	0xa0, 0x84,
	0xa4, 0x1a,
	0xa4, 0x1a,
	0xa4, 0x1a,
	0xa4, 0x1a,
];

function findHook(rom) {
	const cores = findAll(rom, NIBBLE_CORE, 4);
	if (cores.length === 0) {
		return {isOk: false, reasonCode: 'handler-not-found'};
	}
	if (cores.length > 1) {
		return {isOk: false, reasonCode: 'handler-ambiguous', matchCount: cores.length};
	}

	const core = cores[0];
	for (let back = ENTRY_BACK_MIN; back <= ENTRY_BACK_MAX; back++) {
		const p = core - back;
		if (p <= 0) {
			break;
		}
		if (rom[p - 1] !== 0x19) {
			continue;
		}                 // RTS ends the previous routine
		if (rom[p] === 0xad && rom[p + 1] === 0x09) {      // ADD:G.W #2,R5
			return {isOk: true, offset: p, core, gap: back};
		}
	}

	return {isOk: false, reasonCode: 'handler-entry-not-found'};
}

function findAll(rom, pattern, limit = Infinity) {
	const offsets = [];
	const end = rom.length - pattern.length;
	const first = pattern[0];
	for (let i = 0; i <= end; i++) {
		if (rom[i] !== first) {
			continue;
		}
		if (matchAt(rom, i, pattern)) {
			offsets.push(i);
			if (offsets.length > limit) {
				break;
			}
		}
	}

	return offsets;
}

// Matches a byte pattern in which null means "any byte".
function matchAt(rom, at, pattern) {
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

// A stub that is not at TRAMPOLINE_ADDR, recognised by its own shape.
const STUB_SIG = [
	0x1d, null, null, 0x05, (0xc0da >> 8) & 0xff, 0xc0da & 0xff,
	0x26, 0x04,
	0x03, null, null, null,
	0x10, null, null,
];
console.assert(STUB_SIG.length === TRAMPOLINE_SIZE, 'the stub signature must be as long as the stub itself');

function findTrampoline(rom) {
	const hits = findAll(rom, STUB_SIG, 4);
	return (hits.length === 1) ? hits[0] : null;
}

// The DT1 handler jump table. sysex_find_param returns a pointer into it and the dispatcher does JSR @R3,
// so redirecting one entry redirects one handler without touching the handler itself.
const TABLE_MIN_ENTRIES = 5;
const TABLE_MIN_ADDR = 0x0400;

function findTableEntry(rom, hookOffset, alsoTargets = []) {
	const targets = [hookOffset & 0xffff];
	for (const target of (Array.isArray(alsoTargets)) ? alsoTargets : [alsoTargets]) {
		if (target !== undefined && target !== null) {
			targets.push(target & 0xffff);
		}
	}

	const found = [];
	for (let i = 0; i + 1 < rom.length; i++) {
		if (!targets.includes(toWord(rom, i))) {
			continue;
		}
		let lowOffset = i;
		while (lowOffset - 2 >= 0 && toWord(rom, lowOffset - 2) >= TABLE_MIN_ADDR &&
			toWord(rom, lowOffset - 2) < toWord(rom, lowOffset)) {
			lowOffset -= 2;
		}
		let highOffset = i;
		while (highOffset + 4 <= rom.length && toWord(rom, highOffset + 2) >= TABLE_MIN_ADDR &&
			toWord(rom, highOffset + 2) > toWord(rom, highOffset)) {
			highOffset += 2;
		}
		const entryCount = (highOffset - lowOffset) / 2 + 1;
		if (entryCount >= TABLE_MIN_ENTRIES) {
			found.push({offset: i, start: lowOffset, entries: entryCount, index: (i - lowOffset) / 2});
		}
	}
	if (found.length === 0) {
		return {isOk: false, reasonCode: 'table-not-found'};
	}
	if (found.length > 1) {
		return {isOk: false, reasonCode: 'table-ambiguous', candidateCount: found.length};
	}

	return {isOk: true, ...found[0]};
}

function toWord(rom, at) {
	return (rom[at] << 8) | rom[at + 1];
}

// Where the stub is, or would go, and how that was decided.
//   'existing'   the jump table entry already holds TRAMPOLINE_ADDR, so
//                this tool has patched this image.
//   'fixed'      not patched, and the fixed address is free.
//   'searched'   not patched, and it is not free: the longest run in the bank.
function findStub(rom, hook, table) {
	const bank = hook.offset & ~0xffff;
	const fixedAt = bank + TRAMPOLINE_ADDR;
	const entry = toWord(rom, table.offset);
	if (entry !== (hook.offset & 0xffff)) {
		return {isOk: true, at: bank + entry, fixedAt, how: 'existing', isPatched: true};
	}

	const free = findFreeSpace(rom, hook.offset);
	if (!free.isOk) {
		return {
			isOk: false, isPatched: false, fixedAt,
			reasonCode: free.reasonCode, neededSize: free.neededSize,
			...((free.runSize === undefined) ? {} : {runSize: free.runSize}),
		};
	}

	return {
		isOk: true, at: free.offset, fixedAt,
		how: (free.isFixedAddress) ? 'fixed' : 'searched',
		isPatched: false, run: free.run, runSize: free.runSize,
	};
}

// Somewhere in the same 64 KiB bank to put the trampoline
// TRAMPOLINE_ADDR is tried first and taken whenever it is free, so that the answer is the same address on almost every image.
// The search is what happens when it is not: the longest run in the bank.
function findFreeSpace(rom, hookOffset, neededSize = TRAMPOLINE_SIZE) {
	const bank = hookOffset & ~0xffff;
	const end = Math.min(bank + 0x10000, rom.length);

	const at = bank + TRAMPOLINE_ADDR;
	if (at + neededSize <= end && isFree(rom, at, neededSize)) {
		let from = at;
		while (from > bank && rom[from - 1] === 0xff) {
			from--;
		}
		let to = at + neededSize;
		while (to < end && rom[to] === 0xff) {
			to++;
		}
		return {isOk: true, offset: at, run: from, runSize: to - from, isFixedAddress: true};
	}

	let best = null;
	let i = bank;
	while (i < end) {
		if (rom[i] !== 0xff) {
			i++; continue;
		}
		let j = i;
		while (j < end && rom[j] === 0xff) {
			j++;
		}
		const size = j - i;
		if (size >= neededSize && (!best || size > best.size)) {
			best = {offset: i, size};
		}
		i = j;
	}
	if (!best) {
		return {isOk: false, isFixedAddress: false, reasonCode: 'bank-has-no-free-run', neededSize};
	}

	// start on an even address inside the run
	let put = (best.offset + 1) & ~1;
	if (put + neededSize > best.offset + best.size) {
		put = best.offset;
	}
	if (put + neededSize > best.offset + best.size) {
		return {
			isOk: false, isFixedAddress: false,
			reasonCode: 'free-run-too-short', runSize: best.size, neededSize,
		};
	}

	return {isOk: true, offset: put, run: best.offset, runSize: best.size, isFixedAddress: false};
}

function isFree(rom, at, size) {
	for (let k = 0; k < size; k++) {
		if (rom[at + k] !== 0xff) {
			return false;
		}
	}

	return true;
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

function calcCrc32(bytes) {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	}

	return (c ^ 0xffffffff) >>> 0;
}

// SC-55 family ROMs carry a build string like "Ver1.21   121120118 ...".
function findVersionString(rom) {
	for (let i = 0; i + 8 < rom.length; i++) {
		if (rom[i] !== 0x56 || rom[i + 1] !== 0x65 || rom[i + 2] !== 0x72) {
			continue;
		}  // "Ver"
		let j = i;
		let s = '';
		while (j < rom.length && rom[j] >= 0x20 && rom[j] < 0x7f && s.length < 48) {
			s += String.fromCharCode(rom[j]);
			j++;
		}
		if (s.length >= 7 && /^Ver\s?\d/u.test(s)) {
			return {offset: i, text: s.trim()};
		}
	}

	return null;
}

function hasMagic(rom) {
	const highByte = (MAGIC_WORD >> 8) & 0xff;
	const lowByte = MAGIC_WORD & 0xff;
	for (let i = 0; i + 1 < rom.length; i++) {
		if (rom[i] === highByte && rom[i + 1] === lowByte) {
			return true;
		}
	}

	return false;
}

// --------------------------------
// the patch
// --------------------------------

// Returns a new Uint8Array; the input is never modified.
//   options.loadAddr     where the dumper will be in RAM (default: LOAD_ADDR)
//   options.freeOffset   where to put the trampoline     (default: detected)
export function patchRom(rom, options = {}) {
	if (!(rom instanceof Uint8Array)) {
		rom = new Uint8Array(rom);
	}

	const addr = (options.loadAddr !== undefined) ? options.loadAddr : LOAD_ADDR;
	if (addr < 0 || addr > 0xfffff) {
		throw patchError('load-address-out-of-range', {loadAddr: addr});
	}

	const info = analyzeRom(rom);
	if (!info.hook.isOk) {
		throw patchError(info.hook.reasonCode, info.hook);
	}
	if (!info.table.isOk) {
		throw patchError(
			info.table.reasonCode,
			{...info.table, hasUnknownPatch: info.hasUnknownPatch},
		);
	}
	if (!info.stub.isOk) {
		throw patchError(info.stub.reasonCode, info.stub);
	}

	const bank = info.hook.offset & ~0xffff;
	const entryAt = info.table.offset;
	const handlerAddr = info.hook.offset & 0xffff;
	const at = (options.freeOffset === undefined) ? info.stub.at : options.freeOffset;
	if ((at & ~0xffff) !== bank) {
		throw patchError('trampoline-outside-bank', {at, bank});
	}
	if (at + TRAMPOLINE_SIZE > rom.length) {
		throw patchError('trampoline-does-not-fit', {at, neededSize: TRAMPOLINE_SIZE, size: rom.length});
	}

	const stub = buildTrampoline(addr, handlerAddr);
	const beforeEntry = rom.slice(entryAt, entryAt + 2);
	const beforeStub = rom.slice(at, at + TRAMPOLINE_SIZE);

	const out = rom.slice();
	out.set(stub, at);
	out[entryAt] = (at >> 8) & 0xff;
	out[entryAt + 1] = at & 0xff;

	// Only these two runs are ever written, so they are all that has to be compared to know whether the output is the input.
	const isSame = (before, after) => (before.length === after.length && before.every((e, i) => (e === after[i])));
	const isUnchanged = isSame(beforeStub, stub) && isSame(beforeEntry, out.slice(entryAt, entryAt + 2));

	return {
		rom: out, info, loadAddr: addr,
		tableEntry: entryAt, handler: bank + handlerAddr, trampolineAt: at,
		replaced: beforeEntry, written: out.slice(entryAt, entryAt + 2),
		stub, stubReplaced: beforeStub, isPatched: info.stub.isPatched, isUnchanged,
		crc32: calcCrc32(out),
	};
}

// Why the patch could not be made, as an Error a caller can read rather than print. The message is the code itself,
// so a throw that nobody catches is still traceable; `details` carries the numbers behind it.
function patchError(reasonCode, details) {
	return Object.assign(new Error(reasonCode), {reasonCode, details});
}

// CMP:G.W #MAGIC_WORD,@magicAddr:16 / BNE +4 / PJSR @loadAddr / JMP @original
function buildTrampoline(loadAddr, originalHandler) {
	const magicAddr = (loadAddr + 2) & 0xffff;
	return new Uint8Array([
		0x1d, (magicAddr >> 8) & 0xff, magicAddr & 0xff, 0x05, (MAGIC_WORD >> 8) & 0xff, MAGIC_WORD & 0xff,
		0x26, 0x04,
		0x03, (loadAddr >> 16) & 0x0f, (loadAddr >> 8) & 0xff, loadAddr & 0xff,
		0x10, (originalHandler >> 8) & 0xff, originalHandler & 0xff,
	]);
}

// The GS message that fires the hook: DT1 to 40 1x 17.
export function triggerSysEx({deviceId = 0x10, part = 0} = {}) {
	const addr = [0x40, 0x10 | (part & 0x0f), 0x17];
	const data = [0x08, 0x00];
	let sum = 0;
	for (const byte of [...addr, ...data]) {
		sum = (sum + byte) & 0x7f;
	}
	const checksum = (128 - sum) & 0x7f;
	return new Uint8Array([0xf0, 0x41, deviceId & 0x7f, 0x42, 0x12, ...addr, ...data, checksum, 0xf7]);
}
