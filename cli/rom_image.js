#!/usr/bin/env node
/*
	Turn a wave ROM dump into an ordinary ROM image.

	  node cli/rom_image.js WAVE_00.BIN [more...] [-d outdir] [--suffix S]
	  node cli/rom_image.js --check sc55_waverom1.bin WAVE_00.BIN

	  -d, --dir     where to write (default: .)
	  --suffix      appended before the extension (default: _rom)
	  --check       compare against a known chip dump instead of writing
	  -r, --reverse go the other way: chip image -> what the port would return
*/

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import util from 'node:util';

import {convertToRomImage, convertToPortOrder, toHeaderText, looksLikeWaveRom} from '../lib/wave_scramble.js';

function printUsageAndExit(message) {
	if (message) {
		process.stderr.write(`rom_image: ${message}\n\n`);
	}
	process.stderr.write('usage: node cli/rom_image.js <dump.bin> [more...] [-d outdir]\n' +
		'                            [--suffix S] [-r] [--check <chip.bin> <dump.bin>]\n');
	process.exit((message) ? 2 : 0);
}

function readInputFile(input) {
	try {
		return new Uint8Array(fs.readFileSync(input));
	} catch (e) {
		printUsageAndExit(`cannot read ${input}: ${e.message}`);
		throw e;    // not reached: printUsageAndExit() exits, but the linter cannot know
	}
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
			dir: {type: 'string', short: 'd', default: '.'},
			suffix: {type: 'string', default: '_rom'},
			reverse: {type: 'boolean', short: 'r', default: false},
			check: {type: 'boolean', default: false},
		},
		allowPositionals: true,
	}));
} catch (e) {
	printUsageAndExit(e.message);
}
if (values.help) {
	printUsageAndExit();
}
const {dir, suffix, reverse: isReverse, check: isCheck} = values;

// Compare the two, and stop here.
if (isCheck) {
	if (inputs.length !== 2) {
		printUsageAndExit('--check takes exactly two files');
	}
	const expected = readInputFile(inputs[0]);
	const actual = convertToRomImage(readInputFile(inputs[1]));
	const n = Math.min(expected.length, actual.length);
	let badCount = 0;
	let first = -1;
	for (let i = 0; i < n; i++) {
		if (expected[i] !== actual[i]) {
			if (first < 0) {
				first = i;
			}
			badCount++;
		}
	}
	process.stderr.write(`${path.basename(inputs[0])}: ${expected.length} bytes\n`);
	process.stderr.write(`${path.basename(inputs[1])}: ${actual.length} bytes as a ROM image\n`);
	process.stderr.write(`compared ${n} bytes, ${badCount} differ${(first < 0) ? '' : ` (first at H'${first.toString(16).toUpperCase()})`}\n`);

	process.exit((badCount > 0) ? 1 : 0);
}

if (!inputs.length) {
	printUsageAndExit('no input file');
}
fs.mkdirSync(dir, {recursive: true});

// Convert each input file, and write it out.
let failCount = 0;
for (const input of inputs) {
	const sourceBytes = readInputFile(input);
	// one device per file, and a device is a whole power of two: how many address bits are permuted depends on which
	if (sourceBytes.length === 0 || (sourceBytes.length & (sourceBytes.length - 1)) !== 0) {
		process.stderr.write(`${path.basename(input)}: ${sourceBytes.length} bytes is not a power of two - dump one whole device per file\n`);
	}
	let out;
	try {
		out = (isReverse) ? convertToPortOrder(sourceBytes) : convertToRomImage(sourceBytes);
	} catch (e) {
		process.stderr.write(`${path.basename(input)}: ${e.message}\n`);
		failCount++;
		continue;
	}

	const ext = path.extname(input);
	const name = `${path.basename(input, ext)}${suffix}${ext || '.bin'}`;
	fs.writeFileSync(path.join(dir, name), out);

	const isValidWaveRom = (isReverse || looksLikeWaveRom(out));
	process.stderr.write(`${path.basename(input)} -> ${path.join(dir, name)}\n`);
	process.stderr.write(`  header: ${toHeaderText(out)}\n`);
	if (!isValidWaveRom) {
		failCount++;
		process.stderr.write('  this does not start with "Roland", so either the dump is not\n' +
			'  a wave ROM or this model scrambles differently\n');
	}
}

process.exit((failCount > 0) ? 1 : 0);
