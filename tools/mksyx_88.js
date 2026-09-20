#!/usr/bin/env node
/*
	Build the SC-88 family dump files.

	  node tools/mksyx_88.js [--bin build/88] [--out syx]
	  node tools/mksyx_88.js --model sc-88vl --chip 0 --at 78A78,168F82

	The second form writes one file for the passes covering those offsets, which is what cli/extract.js prints when
	something did not arrive.

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
import {CHIP_SELECT_SIZE, GAP_ANSWER_MS, GAP_REQUEST_MS, GAP_TRIGGER_MS, buildFileHeaderPass, buildPass, getPassBytes, planPasses, toRegions} from '../lib/wave_plan_88.js';
import {gsResetMessage} from '../lib/gs_message.js';
import {buildBulkMessages} from './bulk_load.js';
import {writeSmf} from './smf_write.js';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');

const FAMILY = '88';
const BLOCK_ORDER = 'sc88';
const SCRAMBLE = 'sc88';	// how this generation's board wires its wave ROMs
const MAP_NO = 1;

// The dumper takes its arguments in Drum Map Name, so it must not reach that far itself.
 const ARG_OFFSET = 0x380;

function printUsageAndExit(message) {
	if (message) {
		process.stderr.write(`mksyx_88: ${message}\n\n`);
	}
	process.stderr.write('usage: node tools/mksyx_88.js [--bin build/88] [--out syx]\n' +
		'       node tools/mksyx_88.js --model KEY --chip N --at HHHH[,HHHH...]\n');

	process.exit((message) ? 2 : 0);
}

function main() {
	let values;
	try {
		({values} = util.parseArgs({
			options: {
				help: {type: 'boolean', short: 'h'},
				bin: {type: 'string', default: 'build/88'},
				out: {type: 'string', default: 'syx'},
				model: {type: 'string'},
				chip: {type: 'string'},
				at: {type: 'string'},
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

	const wanted = (values.at === undefined)
		? null
		: values.at.split(',').map((text) => parseInt(text.trim(), 16));
	if (wanted && (values.model === undefined || values.chip === undefined)) {
		printUsageAndExit('--at needs --model and --chip as well');
	}
	if (wanted && wanted.some((at) => !Number.isInteger(at))) {
		printUsageAndExit('--at takes hexadecimal offsets, separated by commas');
	}

	const written = [];
	const loaderStems = [];
	const made = new Set();
	const models = {};
	const configs = {};
	for (const [key, model] of Object.entries(catalogue.models ?? {})) {
		if (wanted && key !== values.model) {
			continue;
		}
		if ((model.family ?? '55') !== FAMILY) {
			continue;
		}
		const binPath = path.join(binDir, `dumper_${model.dumper}.bin`);
		if (!fs.existsSync(binPath)) {
			process.stderr.write(`mksyx_88: ${key} wants dumper ${model.dumper}, which was not built - skipping\n`);
			continue;
		}
		const body = new Uint8Array(fs.readFileSync(binPath));
		if (body.length > ARG_OFFSET) {
			throw new Error(`${model.dumper} is ${body.length} bytes, which runs into the request at ` +
				`H'${ARG_OFFSET.toString(16).toUpperCase()}`);
		}
		const chips = catalogue.configs?.[model.config]?.chips;
		if (!chips) {
			process.stderr.write(`mksyx_88: ${key} wants config ${model.config}, which lists no chips - skipping\n`);
			continue;
		}
		const files = [];
		if (!model.readRegions?.length) {
			throw new Error(`${key} has no readRegions, so there is nothing to read the dumper's result out of`);
		}

		const regions = toRegions(model.readRegions);
		const passBytes = getPassBytes(regions);
		// The dumper on its own, so the page can send it the way it sends the other family's: one file per part.
		const dumperMessages = buildBulkMessages(body, 0, {mapNo: MAP_NO, blockOrder: BLOCK_ORDER});
		const loader = [gsResetMessage(), ...dumperMessages];
		const loaderStem = `01-dumper-${model.dumper}`;
		if (!wanted && !made.has(loaderStem)) {
			made.add(loaderStem);
			fs.writeFileSync(path.join(outDir, `${loaderStem}.syx`), concatSysex(dumperMessages));
			fs.writeFileSync(path.join(outDir, `${loaderStem}.mid`), writeSmf(dumperMessages, {name: loaderStem}));
			loaderStems.push(loaderStem);
		}
		// Named by the layout and the dumper, not by the synth: two synths that need the same file get the same one.
		const stems = chips.map((_, chipNo) => `dump-${model.config}-${model.dumper}-chip${chipNo}`);
		for (const [chipNo, size] of chips.entries()) {
			if (wanted && chipNo !== Number(values.chip)) {
				continue;
			}
			const stem = (wanted) ? `retry-${model.config}-${model.dumper}-chip${chipNo}` : stems[chipNo];
			const whole = planPasses(size, passBytes);
			const passes = (wanted)
				? whole.filter((pass) => wanted.some((at) => (at >= pass.at && at < pass.at + pass.size)))
				: whole;
			if (!passes.length) {
				printUsageAndExit(`nothing in ${key} chip ${chipNo} covers those offsets`);
			}
			// Named after where it starts, as the other family names its wave ROM files: WAVE_00, WAVE_20, ...
			const start = chipNo * CHIP_SELECT_SIZE;
			const name = `WAVE_${(start >> 16).toString(16).toUpperCase().padStart(2, '0')}.BIN`;
			const seconds = Math.round((passes.length + 1) *
				(2 * GAP_REQUEST_MS + GAP_TRIGGER_MS + GAP_ANSWER_MS) / 1000);
			files.push({name, size, source: 'wave', start, dump: `${stem}.syx`, seconds});
			// Two synths that need the same file share it, so it is only built once.
			if (made.has(stem)) {
				continue;
			}
			made.add(stem);
			const messages = [...loader,
				...buildFileHeaderPass(regions, {size, passCount: whole.length, name})];
			for (const pass of passes) {
				messages.push(...buildPass(chipNo, pass, regions));
			}
			const syx = concatSysex(messages);
			fs.writeFileSync(path.join(outDir, `${stem}.syx`), syx);
			fs.writeFileSync(path.join(outDir, `${stem}.mid`), writeSmf(messages, {name: stem}));
			written.push({stem, size, passes: passes.length, bytes: syx.length, seconds});
		}
		if (wanted) {
			continue;
		}
		// The same four things the other family publishes about a layout, so that one table describes both.
		const declared = catalogue.configs?.[model.config] ?? {};
		configs[model.config] = {
			note: declared.note ?? '',
			isLayoutConfirmed: declared.isLayoutConfirmed ?? false,
			files: files.map((file) => ({name: file.name, size: file.size, source: file.source, start: file.start,
				seconds: file.seconds})),
			seconds: files.reduce((total, file) => (total + file.seconds), 0),
		};
		models[key] = {
			label: model.label,
			family: FAMILY,
			config: model.config,
			dumper: model.dumper,
			scramble: SCRAMBLE,
			isDumpTested: model.isDumpTested ?? false,
			loader: ['00-gsreset.syx', `${loaderStem}.syx`],
			readRegions: model.readRegions,
			dump: files.map((file) => file.dump),
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
	for (const stem of loaderStems) {
		process.stderr.write(`  ${stem.padEnd(28)} the dumper on its own\n`);
	}
	process.stderr.write(`\nwritten to ${path.relative(ROOT, outDir)}/  (.syx and .mid of each)\n`);

	if (wanted) {
		return 0;	// a retry is not a release: the published table is left alone
	}

	// One published table for every family, so the page and the command line tools read one file. mksyx_55
	// writes it first and this adds to it, which is the order the Makefile runs them in.
	const stampPath = path.join(outDir, 'models.json');
	const stamp = (fs.existsSync(stampPath)) ? JSON.parse(fs.readFileSync(stampPath, 'utf8')) : {configs: {}, models: {}};
	stamp.configs = {...stamp.configs, ...configs};
	stamp.models = {...stamp.models, ...models};
	fs.writeFileSync(stampPath, `${JSON.stringify(stamp, null, '\t')}\n`);
	process.stderr.write(`${Object.keys(models).length} model(s) and ${Object.keys(configs).length} layout(s) ` +
		`added to ${path.relative(ROOT, stampPath)}\n`);

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
