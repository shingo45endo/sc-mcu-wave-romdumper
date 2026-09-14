#!/usr/bin/env node
/*
	Write out the files carried in a recorded MIDI File Dump (RP-009).

	  node cli/extract.js capture.syx [-d outdir] [--prefix P]

	The capture can be any of three things and is recognised by its content, so the extension does not matter:

	  raw SysEx      what most librarians and .syx files hold
	  a MIDI file    what a MIDI sequencer records; the SysEx events are pulled out
	  hex text       "F0 41 10 42 ..."
*/

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import util from 'node:util';

import {FileDumpReceiver} from '../lib/file_dump.js';
import {loadCapture} from '../lib/sysex.js';

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

// Decode each capture and feed it into the receiver.
const rx = new FileDumpReceiver();
for (const input of inputs) {
	let bytes;
	try {
		bytes = new Uint8Array(fs.readFileSync(input));
	} catch (e) {
		printUsageAndExit(`cannot read ${input}: ${e.message}`);
	}
	const messages = loadCapture(bytes);
	for (const message of messages) {
		rx.feed(message);
	}
	process.stderr.write(`read ${path.basename(input)}: ${bytes.length} bytes, ${messages.length} message(s)\n`);
}

// Pull the results out.
const files = rx.getResults();
if (rx.errors.length) {
	process.stderr.write('\nstream problems:\n');
	for (const error of rx.errors) {
		process.stderr.write(`  ${error}\n`);
	}
}
if (!files.length) {
	process.stderr.write('\nno file dump headers found - was MIDI Out recorded?\n');
	process.exit(1);
}

// Print the summary table.
process.stderr.write('\n');
process.stderr.write(`  ${'file'.padEnd(20)} ${'declared'.padStart(9)} ${'received'.padStart(9)} ${'packets'.padStart(7)}  status\n`);
let badCount = 0;
for (const file of files) {
	const missingBytes = file.size - file.bytes.length;
	const status = (file.errors.length) ? `${file.errors.length} error(s)` : (missingBytes > 0) ? `INCOMPLETE, ${missingBytes} bytes missing` : 'complete';
	if (file.errors.length || missingBytes > 0) {
		badCount++;
	}
	process.stderr.write(`  ${file.name.padEnd(20)} ${String(file.size).padStart(9)} ${String(file.bytes.length).padStart(9)} ${String(file.packets).padStart(7)}  ${status}\n`);
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
