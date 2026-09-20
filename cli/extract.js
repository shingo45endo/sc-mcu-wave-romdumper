#!/usr/bin/env node
/*
	Write out the files carried in a recorded dump.

	  node cli/extract.js capture.syx [-d outdir] [--prefix P]

	The capture can be any of three things and is recognized by its content, so the extension does not matter:

	  raw SysEx      what most librarians and .syx files hold
	  a MIDI file    what a MIDI sequencer records; the SysEx events are pulled out
	  hex text       "F0 41 10 42 ..."

	A synth that sends its own dump sends a MIDI File Dump (RP-009); one that cannot leaves it in RAM for the host
	to read back, which arrives as Roland bulk dump replies. In both cases, it accepts the input and outputs the file.
*/

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';
import util from 'node:util';

import {BulkDumpReceiver} from '../lib/bulk_dump.js';
import {FileDumpReceiver} from '../lib/file_dump.js';
import {loadCapture} from '../lib/sysex.js';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(ROOT, 'syx', 'models.json');

function printUsageAndExit(message) {
	if (message) {
		process.stderr.write(`extract: ${message}\n\n`);
	}
	process.stderr.write('usage: node cli/extract.js <capture> [more...] [-d outdir] [--prefix P] [-n]\n' +
		'  the capture may be raw SysEx, a MIDI file, or hex text\n' +
		'  -d, --dir     where to write the files (default: .)\n' +
		'  --prefix      prepend this to every output file name\n' +
		'  -n, --dry-run report what was decoded, write nothing\n');

	process.exit((message) ? 2 : 0);
}

// Read the command-line arguments.
const args = process.argv.slice(2);
if (args.length === 0) {
	printUsageAndExit();
}
let values, inputs;
try {
	({values, positionals: inputs} = util.parseArgs({
		args,
		options: {
			'help': {type: 'boolean', short: 'h'},
			'dir': {type: 'string', short: 'd', default: '.'},
			'prefix': {type: 'string', default: ''},
			'dry-run': {type: 'boolean', short: 'n', default: false},
		},
		allowPositionals: true,
	}));
} catch (e) {
	printUsageAndExit(e.message);
}
if (values.help) {
	printUsageAndExit();
}
const {dir, prefix} = values;
const isDryRun = values['dry-run'];
if (!inputs.length) {
	printUsageAndExit('no input file');
}

// Read every capture once.
const messages = [];
for (const input of inputs) {
	let bytes;
	try {
		bytes = new Uint8Array(fs.readFileSync(input));
	} catch (e) {
		printUsageAndExit(`cannot read ${input}: ${e.message}`);
	}
	const one = loadCapture(bytes);
	messages.push(...one);
	process.stderr.write(`read ${path.basename(input)}: ${bytes.length} bytes, ${one.length} message(s)\n`);
}

const isFileDump = messages.some((m) => (m[1] === 0x7e && m[3] === 0x07));
const files = (isFileDump) ? readFileDump() : readBulkDump();

if (!files.length) {
	process.stderr.write('\nnothing recognized in the capture - was MIDI Out recorded?\n');
	process.exit(1);
}

// Print the summary table.
process.stderr.write('\n');
process.stderr.write(`  ${'file'.padEnd(20)} ${'declared'.padStart(9)} ${'received'.padStart(9)} ` +
	`${'packets'.padStart(7)}  status\n`);
let badCount = 0;
for (const file of files) {
	const missingBytes = file.size - file.received;
	const status = (file.errors.length)
		? `${file.errors.length} problem(s)`
		: (missingBytes > 0) ? `INCOMPLETE, ${missingBytes} bytes missing` : 'complete';
	if (file.errors.length || missingBytes > 0) {
		badCount++;
	}
	process.stderr.write(`  ${file.name.padEnd(20)} ${String(file.size).padStart(9)} ` +
		`${String(file.received).padStart(9)} ${String(file.packets).padStart(7)}  ${status}\n`);
	for (const error of file.errors.slice(0, 4)) {
		process.stderr.write(`      ${error}\n`);
	}
	if (file.errors.length > 4) {
		process.stderr.write(`      ...and ${file.errors.length - 4} more\n`);
	}
}

// Write the decoded files to disk.
if (!isDryRun) {
	fs.mkdirSync(dir, {recursive: true});
	process.stderr.write('\n');
	for (const file of files) {
		const name = `${prefix}${(file.name || 'unnamed.bin').replace(/[\\/:*?"<>|]/gu, '_')}`;
		fs.writeFileSync(path.join(dir, name), file.bytes);
		process.stderr.write(`wrote ${path.join(dir, name)} (${file.bytes.length} bytes)\n`);
	}
}

process.exit((badCount > 0) ? 1 : 0);

// A MIDI File Dump says everything about itself in its own headers.
function readFileDump() {
	const rx = new FileDumpReceiver();
	for (const message of messages) {
		rx.feed(message);
	}
	reportStreamProblems(rx.errors);

	return rx.getResults().map((file) => ({
		name: file.name,
		size: file.size,
		received: file.received,
		packets: file.packets,
		errors: file.errors,
		bytes: file.bytes,
	}));
}

// A bulk dump says everything about itself too, but only once it is back in the areas it was read out of.
function readBulkDump() {
	const sets = getRegionSets();
	if (!sets.length) {
		process.stderr.write('\nno model in syx/models.json reads a dump back out of RAM\n');

		return [];
	}
	let best = null;
	for (const set of sets) {
		const rx = new BulkDumpReceiver(set.regions);
		for (const message of messages) {
			rx.feed(message);
		}
		const result = rx.getResult();
		if (!best || result.holes.length < best.result.holes.length || (!best.result.size && result.size)) {
			best = {set, rx, result};
		}
	}
	if (!best.result.size) {
		process.stderr.write('\nno file header in the capture, so its size and name are not known\n');

		return [];
	}
	process.stderr.write(`areas: ${best.set.names.join(', ')}\n`);

	const passes = best.rx.getProperties();
	const errors = [...best.rx.errors];
	for (const pass of passes) {
		for (const problem of pass.problems) {
			errors.push(`pass ${pass.passNo}: ${problem}`);
		}
	}
	for (const hole of best.result.holes) {
		errors.push(`nothing covers ${hole.size} bytes at H'${hole.at.toString(16).toUpperCase()}`);
	}

	return [{
		name: best.result.name,
		size: best.result.size,
		received: best.result.size - best.result.holes.reduce((total, hole) => (total + hole.size), 0),
		packets: best.rx.packets,
		errors,
		bytes: best.result.bytes,
	}];
}

// Every distinct set of areas the published models read back, with the models that use it.
function getRegionSets() {
	let catalogue;
	try {
		catalogue = JSON.parse(fs.readFileSync(MODELS, 'utf8'));
	} catch (e) {
		printUsageAndExit(`cannot read ${MODELS}: ${e.message}`);
	}
	const sets = new Map();
	for (const [key, model] of Object.entries(catalogue.models ?? {})) {
		if (!model.readRegions?.length) {
			continue;
		}
		const regions = model.readRegions.map((region) => ({
			addr: region.addr.trim().split(/\s+/u).map((token) => parseInt(token, 16)),
			size: region.size,
		}));
		const id = JSON.stringify(regions);
		if (!sets.has(id)) {
			sets.set(id, {regions, names: []});
		}
		sets.get(id).names.push(key);
	}

	return [...sets.values()];
}

function reportStreamProblems(errors) {
	if (!errors.length) {
		return;
	}
	process.stderr.write('\nstream problems:\n');
	for (const error of errors) {
		process.stderr.write(`  ${error}\n`);
	}
}
