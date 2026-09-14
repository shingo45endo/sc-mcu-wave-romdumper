#!/usr/bin/env node
/*
	Work out an unknown model's wave ROM layout from a probe dump.

	  node cli/probe.js capture.syx [-o src/wave-XXX.asm] [--name FOO]

	The capture may be raw SysEx, a MIDI file, or hex text; the form is recognised by content, not by extension.

	  -o, --out     write an assembler file table here (default: stdout)
	  --name        prefix for the generated file names (default: DUMP)
	  --mcu         include an MCU internal ROM entry (default: only if the probe found one)
*/

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import util from 'node:util';

import {FileDumpReceiver} from '../lib/file_dump.js';
import {toHex} from '../lib/format.js';
import {findDevices, isPlausibleSize} from '../lib/probe_map.js';
import {loadCapture} from '../lib/sysex.js';
import {convertToRomImage, toHeaderText, looksLikeWaveRom} from '../lib/wave_scramble.js';

// The source tags a file table entry carries. Defined for real by SRC_MCU and SRC_PCM in src/dumper.inc;
// nothing here reads a built table, it only writes the assembler source for one.
const SRC_MCU = 0;
const SRC_PCM = 1;

function printUsageAndExit(message) {
	if (message) {
		process.stderr.write(`probe: ${message}\n\n`);
	}
	process.stderr.write('usage: node cli/probe.js <capture> [more...] [-o table.asm]\n' +
		'                         [--name FOO] [--mcu]\n' +
		'  the capture may be raw SysEx, a MIDI file, or hex text\n');

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
			help: {type: 'boolean', short: 'h'},
			out: {type: 'string', short: 'o'},
			name: {type: 'string', default: 'DUMP'},
			mcu: {type: 'boolean', default: false},
		},
		allowPositionals: true,
	}));
} catch (e) {
	printUsageAndExit(e.message);
}
if (values.help) {
	printUsageAndExit();
}
const {out} = values;
const model = values.name.toUpperCase();
const isMcuForced = values.mcu;
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

const files = rx.getResults();
if (!files.length) {
	printUsageAndExit('no file dump headers found - was MIDI Out recorded?');
}

// The probe table names its wave windows W<base>.BIN.
const windows = [];
let mcu = null;
let header = null;
for (const file of files) {
	const m = /^W([0-9A-Fa-f]{6})\.BIN$/u.exec(file.name);
	if (m) {
		windows.push({base: parseInt(m[1], 16), bytes: file.bytes, file});
	} else if (/^HEADER\.BIN$/iu.test(file.name)) {
		header = file;
	} else if (/MCU/iu.test(file.name)) {
		mcu = file;
	}
}
windows.sort((a, b) => a.base - b.base);
if (windows.length < 2) {
	printUsageAndExit('this does not look like a probe capture (no W<addr>.BIN files)');
}

// Classify the results.
const toHexKey = (bytes) => Array.from(bytes, (e) => e.toString(16).padStart(2, '0')).join('');
const seenBases = new Map();
for (const window of windows) {
	const isConstant = window.bytes.every((e) => (e === window.bytes[0]));
	window.isConstant = isConstant;
	if (isConstant) {
		continue;
	}

	const k = toHexKey(window.bytes);
	if (seenBases.has(k)) {
		window.mirrorOf = seenBases.get(k);
	} else {
		seenBases.set(k, window.base);
	}
}

const step = windows[1].base - windows[0].base;

const devices = findDevices(windows, step);
const slot = (devices.length > 1) ? devices[1].base - devices[0].base : null;

// Output a report.
process.stderr.write('\n');
process.stderr.write(`  ${'window'.padEnd(10)}  what it is\n`);
for (const window of windows) {
	const windowDescription = (window.isConstant)
		? `nothing mapped (all H'${window.bytes[0].toString(16).toUpperCase().padStart(2, '0')})`
		: (window.mirrorOf !== undefined) ? `mirror of H'${window.mirrorOf.toString(16).toUpperCase().padStart(6, '0')}`
			: 'distinct data';
	process.stderr.write(`  H'${window.base.toString(16).toUpperCase().padStart(6, '0')}    ${windowDescription}\n`);
}

process.stderr.write('\n');
if (header) {
	const raw = toHeaderText(header.bytes);
	const desc = toHeaderText(convertToRomImage(header.bytes.slice(0, 112), 20).slice(0, 32));
	process.stderr.write(`  window at address 0, as received : ${raw}\n`);
	process.stderr.write(`  ...as a ROM image                : ${desc}\n`);
	process.stderr.write((looksLikeWaveRom(convertToRomImage(header.bytes.slice(0, 112), 20)))
		? '  that reads as a Roland header, so this model uses the scrambling we know\n'
		: '  that is not a Roland header - this model scrambles differently, so\n' +
			'  cli/rom_image.js will not produce a usable image for it\n');
}

process.stderr.write('\n');
process.stderr.write(`  devices found : ${devices.length}\n`);
for (const [i, device] of devices.entries()) {
	const oddSizeNote = (isPlausibleSize(device.size)) ? ''
		: '   <- not a power of two, so this is more than one device and the windows are too far apart to see the seam';
	process.stderr.write(`    ${i}: H'${device.base.toString(16).toUpperCase().padStart(6, '0')}` +
		`, ${device.size / 1024} KiB populated${oddSizeNote}\n`);
}
if (slot !== null) {
	process.stderr.write(`  slot stride   : ${slot / 1024} KiB\n`);
}
if (mcu) {
	process.stderr.write(`  MCU ROM       : ${mcu.size} bytes were dumped\n`);
}

// Make a file table.
const hasMcu = (mcu || isMcuForced);
const entries = [];
if (hasMcu) {
	entries.push({source: SRC_MCU, addr: 0, size: 0x8000, name: 'MCU.BIN'});
}
for (const device of devices) {
	entries.push({
		source: SRC_PCM, addr: device.base, size: device.size,
		name: `WAVE_${(device.base >> 16).toString(16).toUpperCase().padStart(2, '0')}.BIN`,	// 8.3 filename
	});
}

// Layouts are named by their device sizes, one per 2 MiB slot, because several synths share one.
const configName = `${(hasMcu) ? 'mcu-' : ''}wave-${devices.map((device) => `${device.size >> 20}m`).join('')}`;

// Assembler source for a table, in the form src/table-*.asm uses. Lives here rather than in lib/ because turning a
// probe result into something that can be assembled is the one thing this tool is for.
function formatTableAssembly({files}, {title = '', notes = []} = {}) {
	const lines = [];
	lines.push(';==========================================================================');
	lines.push(`; File table${(title) ? ` - ${title}` : ''}`);
	if (notes.length) {
		lines.push(';');
		for (const note of notes) {
			lines.push(`; ${note}`);
		}
	}
	lines.push(';==========================================================================');
	lines.push('');
	lines.push('                cpu     HD6475328');
	lines.push('                maxmode on');
	lines.push('                assume  dp:0,ep:0,tp:0,br:0');
	lines.push('');
	lines.push('                include dumper.inc');
	lines.push('');
	lines.push('                org     LOADADDR+TABLEOFS');
	lines.push('');
	// No IOWRITE lines: a probe cannot tell what registers a model needs. The terminator is not optional though -
	// the dumper reads it to find where the file entries start.
	lines.push('                IOEND');
	lines.push('');
	for (const file of files) {
		const sourceTag = (file.source === SRC_MCU) ? 'SRC_MCU' : 'SRC_PCM';
		lines.push(`                FILE    ${sourceTag},$${toHex(file.addr, 6)},$${toHex(file.size, 6)},'${file.name}'`);
	}
	lines.push('');
	lines.push('                TABLEEND');
	lines.push('');
	lines.push('                end');
	return `${lines.join('\n')}\n`;
}

const asm = formatTableAssembly({files: entries}, {
	title: `${configName}${(model === 'DUMP') ? '' : `  (from a ${model} probe)`}`,
	notes: [
		'Generated by cli/probe.js from a probe capture. Check it before',
		'trusting it: a device whose halves happen to hold identical data would',
		'be reported as smaller than it is.',
		'',
		`Save as src/${configName}.asm, add the synth to src/catalogue.json`,
		`with "config": "${configName}", and run make.`,
	],
});

if (out) {
	fs.writeFileSync(out, asm);
	process.stderr.write(`\nwrote ${out}\n`);
	process.stderr.write('run "make" to turn it into syx/dump-*.syx\n');
} else {
	process.stdout.write(`\n${asm}`);
}
