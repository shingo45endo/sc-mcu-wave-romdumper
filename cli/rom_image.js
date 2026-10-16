#!/usr/bin/env node
/*
	Turn a wave ROM dump into an ordinary ROM image.

	  node cli/rom_image.js WAVE_00.BIN [more...] [-d outdir] [--suffix S]
	  node cli/rom_image.js --check sc55_waverom1.bin WAVE_00.BIN

	  -d, --dir     where to write (default: .)
	  --scramble    which family the dump came from: sc55 or sc88. Required
	  --suffix      appended before the extension (default: _rom)
	  --check       compare against a known chip dump instead of writing
	  -r, --reverse go the other way: chip image -> what the port would return
*/

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import util from 'node:util';
import crypto from 'node:crypto';

import {toHex} from '../lib/format.js';
import {calcCrc32, swapBytes} from '../lib/rom_search.js';
import {convertToRomImage, convertToPortOrder, getScrambleNames, getHeaderText, looksLikeWaveRom} from '../lib/wave_scramble.js';

function printUsageAndExit(message) {
	if (message) {
		process.stderr.write(`rom_image: ${message}\n\n`);
	}
	process.stderr.write('usage: node cli/rom_image.js --scramble sc55|sc88 <dump.bin> [more...] [-d outdir]\n' +
		'                            [--suffix S] [-r] [--check <chip.bin> <dump.bin>]\n');
	process.exit((message) ? 2 : 0);
}

function isSame(left, right) {
	return (left.length === right.length) && left.every((byte, i) => (byte === right[i]));
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
			scramble: {type: 'string'},
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
const {dir, scramble, suffix, reverse: isReverse, check: isCheck} = values;
// No default: the two families scramble differently and a wrong guess is a whole ROM of wrong bytes.
if (!getScrambleNames().includes(scramble)) {
	printUsageAndExit(`--scramble must be given, as one of: ${getScrambleNames().join(', ')}`);
}

// Compare the two, and stop here.
if (isCheck) {
	if (inputs.length !== 2) {
		printUsageAndExit('--check takes exactly two files');
	}
	const chipBytes = readInputFile(inputs[0]);
	const dumpImage = convertToRomImage(readInputFile(inputs[1]), {scramble});
	const compareSize = Math.min(chipBytes.length, dumpImage.length);
	let badCount = 0;
	let firstBadAt = -1;
	for (let i = 0; i < compareSize; i++) {
		if (chipBytes[i] !== dumpImage[i]) {
			if (firstBadAt < 0) {
				firstBadAt = i;
			}
			badCount++;
		}
	}
	process.stderr.write(`${path.basename(inputs[0])}: ${chipBytes.length} bytes\n`);
	process.stderr.write(`${path.basename(inputs[1])}: ${dumpImage.length} bytes as a ROM image\n`);
	process.stderr.write(`compared ${compareSize} bytes, ${badCount} differ${(firstBadAt < 0) ? '' : ` (first at H'${firstBadAt.toString(16).toUpperCase()})`}\n`);
	// A wave ROM is 16 bits wide, so a reader can hand one back the other way round.
	if (badCount > 0 && isSame(swapBytes(chipBytes), dumpImage)) {
		process.stderr.write('  they are the same image: one of them was read out the other way round,\n' +
			'  which a 16 bit wide ROM allows\n');
	}

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
		out = (isReverse) ? convertToPortOrder(sourceBytes, {scramble}) : convertToRomImage(sourceBytes, {scramble});
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
	process.stderr.write(`  header: ${getHeaderText(out)}\n`);
	// The two a ROM set lists, so that this can be compared against one without keeping a copy of it here.
	process.stderr.write(`  crc32:  ${toHex(calcCrc32(out), 8)}\n`);
	process.stderr.write(`  sha1:   ${crypto.createHash('sha1').update(out).digest('hex')}\n`);
	if (!isValidWaveRom) {
		failCount++;
		process.stderr.write('  this does not start with "Roland", so either the dump is not\n' +
			'  a wave ROM or this model scrambles differently\n');
	}
}

process.exit((failCount > 0) ? 1 : 0);
