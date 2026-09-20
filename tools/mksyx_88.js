#!/usr/bin/env node
/*
	Build the SC-88 family dump files.

	  node tools/mksyx_88.js [--bin build/88] [--out syx]

	Input is what the assembler produced in build/88, plus the model catalogue in tools/catalogue.json. Output is syx/.

	One file per wave ROM chip select, because 2 MiB already takes half an hour and a failure part way should not cost
	the rest. Each file is the dumper, then one group per pass: write the request, call the dumper, ask for the four
	areas it filled. Nothing waits on a reply, so the whole thing is written out in advance and played straight at the
	synth while MIDI In is recorded.
*/

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';
import util from 'node:util';

import {formatDuration} from '../lib/format.js';
import {planPasses, toRequestBytes} from '../lib/wave_plan_88.js';
import {buildFileHeader, buildPassHeader, HEADER_SIZE} from '../lib/bulk_dump.js';
import {buildBulkMessages, buildRequestMessage, buildWriteMessage, gsResetMessage, triggerMessage} from './bulk_load.js';
import {writeSmf} from './smf_write.js';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');

const FAMILY = '88';
const BLOCK_ORDER = 'sc88';
const BLOCK_SIZE = 0x40;
const MAP_NO = 1;

// These have to match src/88/dumper_88.inc. Drum Map Name is the drum map's last field, which is where the SC-55
// dumper takes its arguments too.
const ARG_OFFSET = 0x380;
const ARG_LEN = 12;
const GROUP_BYTES = 7;

// Asking for more than an area holds returns the rest of it, whatever an address step means on this revision.
const WHOLE_AREA = 0x2000;

// What each message has to be followed by. The last request of a pass waits for the synth's whole answer; the others
// are queued behind it, which is what makes a pass take one wait rather than four.
const GAP_REQUEST_MS = 20;
const GAP_TRIGGER_MS = 150;		// the dumper runs for about 110
const GAP_READ_MS = 0;
const GAP_ANSWER_MS = 4500;		// measured at about 4100 for four areas

function printUsageAndExit(message) {
	if (message) {
		process.stderr.write(`mksyx_88: ${message}\n\n`);
	}
	process.stderr.write('usage: node tools/mksyx_88.js [--bin build/88] [--out syx]\n');

	process.exit((message) ? 2 : 0);
}

function toAddress(text) {
	const bytes = text.trim().split(/\s+/u).map((token) => parseInt(token, 16));
	if (bytes.length !== 3 || bytes.some((byte) => !(byte >= 0 && byte <= 0x7f))) {
		throw new Error(`${JSON.stringify(text)} is not a bulk dump address`);
	}

	return bytes;
}

// Ask for every area the buffer is made of, and wait for the lot.
function buildReadBack(regions) {
	return regions.map((region, i) => ({
		bytes: buildRequestMessage(toAddress(region.addr), WHOLE_AREA),
		gapMs: (i === regions.length - 1) ? GAP_ANSWER_MS : GAP_READ_MS,
	}));
}

// One pass: put the header and the request in place, call the dumper, then read the buffer back.
function buildPass(chipNo, pass, regions) {
	const groups = pass.size / GROUP_BYTES;
	console.assert(Number.isInteger(groups), 'a pass is a whole number of groups');
	console.assert(toRequestBytes(chipNo, pass.at, groups).length <= ARG_LEN, 'the request fits in Drum Map Name');
	const header = toAddress(regions[0].addr);
	const request = [0x49, (MAP_NO << 4) | (ARG_OFFSET / BLOCK_SIZE), 0x00];

	return [
		{bytes: buildWriteMessage(header, buildPassHeader({at: pass.at, size: pass.size}), {isNibble: false}),
			gapMs: GAP_REQUEST_MS},
		{bytes: buildWriteMessage(request, toRequestBytes(chipNo, pass.at, groups)), gapMs: GAP_REQUEST_MS},
		{bytes: triggerMessage(), gapMs: GAP_TRIGGER_MS},
		...buildReadBack(regions),
	];
}

// The file header is written and read straight back. The dumper is never called, so it takes one wait.
function buildFileHeaderPass(regions, {size, passCount, name}) {
	const header = buildFileHeader({size, passCount, name});

	return [
		{bytes: buildWriteMessage(toAddress(regions[0].addr), header, {isNibble: false}), gapMs: GAP_REQUEST_MS},
		...buildReadBack(regions),
	];
}

function main() {
	let values;
	try {
		({values} = util.parseArgs({
			options: {
				help: {type: 'boolean', short: 'h'},
				bin: {type: 'string', default: 'build/88'},
				out: {type: 'string', default: 'syx'},
			},
		}));
	} catch (e) {
		printUsageAndExit(e.message);
	}
	if (values.help) {
		printUsageAndExit();
	}

	const binDir = path.join(ROOT, values.bin);
	const outDir = path.join(ROOT, values.out);
	fs.mkdirSync(outDir, {recursive: true});
	const catalogue = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'catalogue.json'), 'utf8'));

	const written = [];
	const made = new Set();
	const models = {};
	for (const [key, model] of Object.entries(catalogue.models ?? {})) {
		if ((model.family ?? '55') !== FAMILY) {
			continue;
		}
		const binPath = path.join(binDir, `dumper_${model.dumper}.bin`);
		if (!fs.existsSync(binPath)) {
			process.stderr.write(`mksyx_88: ${key} wants dumper ${model.dumper}, which was not built - skipping\n`);
			continue;
		}
		const dumper = new Uint8Array(fs.readFileSync(binPath));
		if (dumper.length > ARG_OFFSET) {
			throw new Error(`${model.dumper} is ${dumper.length} bytes, which runs into the request at ` +
				`H'${ARG_OFFSET.toString(16).toUpperCase()}`);
		}
		const chips = catalogue.configs?.[model.config]?.chips;
		if (!chips) {
			process.stderr.write(`mksyx_88: ${key} wants config ${model.config}, which lists no chips - skipping\n`);
			continue;
		}
		const regions = model.readRegions ?? [];
		if (!regions.length) {
			throw new Error(`${key} has no readRegions, so there is nothing to read the dumper's result out of`);
		}

		const passBytes = ((regions.reduce((total, one) => (total + one.size), 0) - HEADER_SIZE) / 8) * GROUP_BYTES;
		console.assert(Number.isInteger(passBytes), 'the areas must hold the header and a whole number of groups');
		const loader = [gsResetMessage(), ...buildBulkMessages(dumper, 0, {mapNo: MAP_NO, blockOrder: BLOCK_ORDER})];
		// Named by the layout and the dumper, not by the synth: two synths that need the same file get the same one.
		const stems = chips.map((_, chipNo) => `dump-${model.config}-${model.dumper}-chip${chipNo}`);
		for (const [chipNo, size] of chips.entries()) {
			const stem = stems[chipNo];
			if (made.has(stem)) {
				continue;
			}
			made.add(stem);
			const passes = planPasses(size, passBytes);
			const name = `WAVE_${(chipNo * 2).toString(16).toUpperCase().padStart(2, '0')}.BIN`;
			const messages = [...loader,
				...buildFileHeaderPass(regions, {size, passCount: passes.length, name})];
			for (const pass of passes) {
				messages.push(...buildPass(chipNo, pass, regions));
			}
			const syx = concatSysex(messages);
			fs.writeFileSync(path.join(outDir, `${stem}.syx`), syx);
			fs.writeFileSync(path.join(outDir, `${stem}.mid`), writeSmf(messages, {name: stem}));
			const seconds = (passes.length + 1) * (2 * GAP_REQUEST_MS + GAP_TRIGGER_MS + GAP_ANSWER_MS) / 1000;
			written.push({stem, size, passes: passes.length, bytes: syx.length, seconds});
		}
		models[key] = {
			label: model.label,
			family: FAMILY,
			config: model.config,
			dumper: model.dumper,
			isDumpTested: model.isDumpTested ?? false,
			readRegions: regions,
			dump: stems.map((stem) => `${stem}.syx`),
			...(model.systemInfo) ? {systemInfo: model.systemInfo} : {},
		};
	}

	if (!written.length) {
		process.stderr.write('mksyx_88: nothing to build - run "make" first (it needs asl and p2bin)\n');
		process.exit(1);
	}
	process.stderr.write(`\n  ${'file'.padEnd(28)} ${'chip'.padStart(9)} ${'passes'.padStart(7)} ` +
		`${'bytes'.padStart(7)}  time\n`);
	for (const one of written) {
		process.stderr.write(`  ${one.stem.padEnd(28)} ${`${one.size / 1024 / 1024} MiB`.padStart(9)} ` +
			`${String(one.passes).padStart(7)} ${String(one.bytes).padStart(7)}  ${formatDuration(one.seconds)}\n`);
	}
	process.stderr.write(`\nwritten to ${path.relative(ROOT, outDir)}/  (.syx and .mid of each)\n`);

	// One published table for every family, so the page and the command line tools read one file. mksyx_55
	// writes it first and this adds to it, which is the order the Makefile runs them in.
	const stampPath = path.join(outDir, 'models.json');
	const stamp = (fs.existsSync(stampPath)) ? JSON.parse(fs.readFileSync(stampPath, 'utf8')) : {models: {}};
	stamp.models = {...stamp.models, ...models};
	fs.writeFileSync(stampPath, `${JSON.stringify(stamp, null, '\t')}\n`);
	process.stderr.write(`${Object.keys(models).length} model(s) added to ${path.relative(ROOT, stampPath)}\n`);

	return 0;
}

function concatSysex(messages) {
	const parts = messages.map((entry) => (entry.bytes ?? entry));
	const size = parts.reduce((total, bytes) => (total + bytes.length), 0);
	const out = new Uint8Array(size);
	let at = 0;
	for (const bytes of parts) {
		out.set(bytes, at);
		at += bytes.length;
	}

	return out;
}

process.exit(main());
