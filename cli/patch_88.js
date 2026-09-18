#!/usr/bin/env node
/*
	Command line front end for patcher_88.js. SC-88 family.

	  node cli/patch_88.js <rom.bin> [-o out.bin] [--addr 9104] [-n]

	  -o, --out     where to write the patched ROM (default: <rom>_patched.bin)
	  --addr        16 bit RAM address to jump to, hex (default: read out of the ROM's bulk dump table)
	  --page        the page that address sits in, hex (default: detected)
	  --free        ROM offset to put the trampoline at, hex (default: detected)
	  --param       parameter number of the one table entry to patch, hex (default: every entry found)
	  -n, --dry-run analyze only, write nothing
*/

import fs from 'node:fs';
import process from 'node:process';
import util from 'node:util';

import {toHex, toHexBytes} from '../lib/format.js';
import {analyzeRom, patchRom, triggerSysEx, MAGIC_WORD} from '../lib/patcher_88.js';

const REASON_TEXTS = {
	'handler-not-found':
		() => 'the DT1 nibble handler was not found. Is this really an SC-88 family ROM?',
	'handler-ambiguous':
		(d) => `the DT1 nibble handler pattern matched ${d.matchCount} times - ambiguous.`,
	'no-hook':
		() => 'no hook',
	'table-entry-not-found':
		() => 'the parameter table entry for 40 1x 17 was not found',
	'no-table-entry':
		() => 'no parameter table entry',
	'bulk-table-not-found':
		() => 'the bulk dump region table was not found, so the load address cannot be read out of the ROM',
	'bulk-table-ambiguous':
		(d) => `found ${d.candidateCount} possible bulk dump region tables - too many to choose safely.`,
	'load-region-not-found':
		() => 'the bulk dump region table has no drum map 2 entry',
	'bank-has-no-free-run':
		(d) => `this bank has no gap of ${d.neededSize} free (H'FF) bytes between two used areas; ` +
			`its longest run of free bytes is ${d.longestSize}.`,
	'ram-page-not-found':
		() => 'the firmware never loads a page into DP, so the RAM page cannot be read out of the ROM. Give --page.',
	'ram-page-ambiguous':
		(d) => `the RAM page is a toss-up: H'${toHex(d.page)} appears ${d.count} times and ` +
			`H'${toHex(d.runnerUpPage)} ${d.runnerUpCount} times. Give --page.`,
	'load-address-out-of-range':
		() => 'the page must fit in 8 bits and the address in 16',
	'trampoline-outside-bank':
		() => 'the trampoline must be in the same bank as the handler',
	'trampoline-does-not-fit':
		() => 'trampoline does not fit',
	'no-entry-with-that-parameter-number':
		(d) => `no table entry has parameter number H'${toHex(d.paramNo, 4)}`,
};

function getReasonText(what) {
	const text = REASON_TEXTS[what.reasonCode];
	return (text) ? text(what) : String(what.reasonCode);
}

// A human readable summary of analyzeRom() / patchRom().
function describeAnalysis(result) {
	const info = result.info || result;
	const lines = [];
	lines.push(`size            ${info.size} bytes (${(info.size / 1024) | 0} KiB)`);
	lines.push(`CRC32           ${toHex(info.crc32, 8)}${(info.isSwapped) ? '  (of the image the right way round)' : ''}`);
	if (info.isSwapped) {
		lines.push('byte order      the two halves of every word are the other way round. ' +
			'The output is written back the same way');
	}
	for (const [i, model] of info.models.entries()) {
		lines.push(`${((i === 0) ? 'models' : '').padEnd(16)}${model.text}`);
	}

	if (info.hook.isOk) {
		lines.push(`hook site       H'${toHex(info.hook.write, 5)}  (DT1 handler for 40 1x 17)`);
		lines.push(`read handler    H'${toHex(info.hook.read, 5)}  (left alone)`);
	} else {
		lines.push(`hook site       NOT FOUND - ${getReasonText(info.hook)}`);
	}

	if (info.entries.isOk) {
		for (const [i, entry] of info.entries.list.entries()) {
			lines.push(`${((i === 0) ? 'table entry' : '').padEnd(16)}H'${toHex(entry.offset, 5)}  ` +
				`parameter H'${toHex(entry.paramNo, 4)}  handler H'${toHex(entry.write, 4)}`);
		}
	} else if (info.hook.isOk) {
		lines.push(`table entry     NOT FOUND - ${getReasonText(info.entries)}`);
	}

	if (info.bulk.isOk) {
		const {load} = info.bulk;
		lines.push(`load area       H'${toHex(load.addr, 4)}, ${load.size} bytes  ` +
			`(bulk dump ${toHexBytes(load.addr3)}, table at H'${toHex(info.bulk.offset, 5)})`);
	} else {
		lines.push(`load area       NOT FOUND - ${getReasonText(info.bulk)}`);
	}

	if (info.ramPage.isOk) {
		lines.push(`RAM page        H'${toHex(info.ramPage.page)}  ` +
			`(loaded ${info.ramPage.count} times; next is H'${toHex(info.ramPage.runnerUpPage)} ` +
			`at ${info.ramPage.runnerUpCount})`);
	} else {
		lines.push(`RAM page        NOT FOUND - ${getReasonText(info.ramPage)}`);
	}

	if (info.bulk.isOk && info.ramPage.isOk) {
		lines.push(`load address    H'${toHex(info.loadAddr, 6)}`);
	}

	if (info.stub && info.stub.isOk) {
		const why = {
			existing: 'already patched; the stub is there',
			searched: `the largest gap between two used areas; ${info.stub.runSize} bytes of H'FF`,
		}[info.stub.how];
		// --free puts the stub somewhere else. This line is read before burning a ROM, so it has to say where the
		// stub really goes, not where it would have gone.
		const at = (result.trampolineAt === undefined) ? info.stub.at : result.trampolineAt;
		const source = (at === info.stub.at) ? why : `given; the detected one is H'${toHex(info.stub.at, 5)}`;
		lines.push(`stub address    H'${toHex(at, 5)}  (${source})`);
	} else if (info.entries.isOk && info.stub && info.stub.reasonCode) {
		lines.push(`stub address    NOT FOUND - ${getReasonText(info.stub)}`);
	}

	if (result.rom) {
		lines.push('');
		for (const entry of result.entries) {
			lines.push(`table entry     H'${toHex(entry.offset, 5)}: ` +
				`${toHexBytes(entry.replaced)} -> ${toHexBytes(entry.written)}  ` +
				`(parameter H'${toHex(entry.paramNo, 4)})`);
		}
		lines.push(`trampoline at   H'${toHex(result.trampolineAt, 5)}`);
		const s = result.stub;
		lines.push(`  ${toHexBytes(s.slice(0, 2)).padEnd(18)}STC.B   DP,@-SP`);
		lines.push(`  ${toHexBytes(s.slice(2, 5)).padEnd(18)}LDC.B   #H'${toHex(result.ramPage)},DP`);
		lines.push(`  ${toHexBytes(s.slice(5, 11)).padEnd(18)}CMP:G.W #H'${toHex(MAGIC_WORD, 4)},` +
			`@H'${toHex((result.loadAddr + 2) & 0xffff, 4)}:16`);
		lines.push(`  ${toHexBytes(s.slice(11, 13)).padEnd(18)}BNE     .+4`);
		lines.push(`  ${toHexBytes(s.slice(13, 17)).padEnd(18)}PJSR    @H'${toHex(result.loadAddr, 6)}`);
		lines.push(`  ${toHexBytes(s.slice(17, 19)).padEnd(18)}LDC.B   @SP+,DP`);
		lines.push(`  ${toHexBytes(s.slice(19, 22)).padEnd(18)}JMP     @H'${toHex(result.handler & 0xffff, 4)}`);
		lines.push(`CRC32 after     ${toHex(result.crc32, 8)}${
			(result.isUnchanged) ? '  (unchanged: it was already patched like this)' : ''}`);
		lines.push('');
		lines.push(`trigger SysEx   ${toHexBytes(triggerSysEx())}`);
	}

	return lines.join('\n');
}

function printUsageAndExit(message) {
	if (message) {
		process.stderr.write(`patch_88: ${message}\n\n`);
	}
	process.stderr.write('usage: node cli/patch_88.js <rom.bin> [-o out.bin] [--addr HHHH] [--page HH]\n' +
		'                             [--free HHHHH] [--param HHHH] [-n]\n');

	process.exit((message) ? 2 : 0);
}

function parseHexOption(values, name) {
	if (values[name] === undefined) {
		return undefined;
	}
	const text = values[name].replace(/^(0x|H')/iu, '');
	if (!/^[0-9a-f]+$/iu.test(text)) {
		printUsageAndExit(`--${name} wants a hex number, not "${values[name]}"`);
	}

	return parseInt(text, 16);
}

// Read the command-line arguments.
const args = process.argv.slice(2);
if (args.length === 0) {
	printUsageAndExit();
}
let values, positionals;
try {
	({values, positionals} = util.parseArgs({
		args,
		options: {
			'help': {type: 'boolean', short: 'h'},
			'out': {type: 'string', short: 'o'},
			'addr': {type: 'string'},
			'page': {type: 'string'},
			'free': {type: 'string'},
			'param': {type: 'string'},
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
const {out} = values;
const isDryRun = values['dry-run'];

const addr = parseHexOption(values, 'addr');
const ramPage = parseHexOption(values, 'page');
const free = parseHexOption(values, 'free');
const paramNo = parseHexOption(values, 'param');

if (positionals.length > 1) {
	printUsageAndExit('more than one input file');
}
const input = positionals[0];
if (input === undefined) {
	printUsageAndExit('no input file');
}

// Read the ROM file.
let rom;
try {
	rom = new Uint8Array(fs.readFileSync(input));
} catch (e) {
	printUsageAndExit(`cannot read ${input}: ${e.message}`);
}

const patchOptions = {
	...((addr !== undefined) ? {loadAddr: addr} : {}),
	...((ramPage !== undefined) ? {ramPage} : {}),
	...((free !== undefined) ? {freeOffset: free} : {}),
	...((paramNo !== undefined) ? {paramNo} : {}),
};

// A dry run has to predict the real run, so it patches in memory with the same options and reports that. Only the
// write is skipped.
if (isDryRun) {
	let preview = null;
	try {
		preview = patchRom(rom, patchOptions);
	} catch (e) {
		// An image this could not be patched is a failure to report, whether it is the hook, the table, the load area
		// or the room for the stub that is missing.
		process.stdout.write(`${describeAnalysis(analyzeRom(rom))}\n`);
		process.stderr.write(`patch_88: ${
			(e.reasonCode) ? getReasonText({reasonCode: e.reasonCode, ...e.details}) : e.message}\n`);
		process.exit(1);
	}
	process.stdout.write(`${describeAnalysis(preview)}\n`);
	process.exit(0);
}

// Patch it.
let result;
try {
	result = patchRom(rom, patchOptions);
} catch (e) {
	// patchRom() says why with a code; anything else really is an exception
	process.stderr.write(`patch_88: ${
		(e.reasonCode) ? getReasonText({reasonCode: e.reasonCode, ...e.details}) : e.message}\n`);
	process.exit(1);
}

// Print the report.
process.stderr.write(`${describeAnalysis(result)}\n`);

// A byte for byte copy of the input under a second _patched is a file nobody wants, so say what is true instead:
// it is already done.
if (result.isUnchanged) {
	process.stderr.write(`\npatch_88: already patched at H'${toHex(result.trampolineAt, 5)} -- nothing to write\n`);
	process.stderr.write(`trigger with: ${toHexBytes(triggerSysEx())}\n`);
	process.exit(0);
}

// Write the patched ROM.
const target = out || input.replace(/(\.[^./\\]+)?$/u, '_patched$1');
fs.writeFileSync(target, result.rom);
process.stderr.write(`\nwrote ${target}\n`);
process.stderr.write(`trigger with: ${toHexBytes(triggerSysEx())}\n`);
