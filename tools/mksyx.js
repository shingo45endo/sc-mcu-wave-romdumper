#!/usr/bin/env node
/*
	Build the fixed SysEx and MIDI files that drive the dumper.

	Input is what the assembler produced in build/, plus the model catalogue in src/catalogue.json. Output is syx/.

	    node tools/mksyx.js [--bin build] [--src src] [--out syx]

	  --bin         where the assembler output is (default: build)
	  --src         where dumper.inc and catalogue.json are (default: src)
	  --out         where to write the .syx and .mid files (default: syx)
*/

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';
import util from 'node:util';

import {formatDuration, toHex} from '../lib/format.js';

import {buildBulkMessages, gsResetMessage, triggerMessage} from './bulk_load.js';
import {parseTable, estimateDumpTime, SOURCE_NAMES} from './file_table.js';
import {writeSmf, concatSysex} from './smf_write.js';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');

const DEFAULT_PAYLOAD = 'maincpu';

function formatSmfTitle(stepNo, what) {
	const PROJECT = 'sc-mcu-wave-romdumper';
	const STEPS = 4;
	return `${PROJECT}${(stepNo) ? ` ${stepNo}/${STEPS}` : ''} - ${what}`;
}

function parseEquates(text) {
	const equates = {};
	for (const line of text.split(/\r?\n/u)) {
		const m = /^([A-Za-z_.][A-Za-z_.0-9]*)\s+equ\s+([^;]+)/iu.exec(line);
		if (!m) {
			continue;
		}
		const raw = m[2].trim();
		let v = null;
		if (/^\$[0-9A-Fa-f]+$/u.test(raw)) {
			v = parseInt(raw.slice(1), 16);
		} else if (/^\d+$/u.test(raw)) {
			v = parseInt(raw, 10);
		}
		if (v !== null) {
			equates[m[1].toUpperCase()] = v;
		}
	}

	return equates;
}

function getCpuLabel(kind) {
	return (kind === 'subcpu') ? 'sub-CPU' : 'main CPU';
}

function printUsageAndExit(message) {
	if (message) {
		process.stderr.write(`mksyx: ${message}\n\n`);
	}

	process.stderr.write('usage: node tools/mksyx.js [--bin build] [--src src] [--out syx]\n' +
		'  --bin   where the assembler output is\n' +
		'  --src   where dumper.inc and catalogue.json are\n' +
		'  --out   where to write the .syx and .mid files\n');
	process.exit((message) ? 2 : 0);
}

function main() {
	// Read the command-line arguments.
	// Unlike the tools in cli/ this one is run by make with no arguments at all, so no arguments is the normal case rather than a usage request.
	let values;
	try {
		({values} = util.parseArgs({
			args: process.argv.slice(2),
			options: {
				help: {type: 'boolean', short: 'h'},
				bin: {type: 'string', default: 'build'},
				src: {type: 'string', default: 'src'},
				out: {type: 'string', default: 'syx'},
			},
			allowPositionals: true,
		}));
	} catch (e) {
		printUsageAndExit(e.message);
	}
	if (values.help) {
		printUsageAndExit();
	}

	// Resolve where the assembler output, the source, and the output go.
	const binDir = path.join(ROOT, values.bin);
	const srcDir = path.join(ROOT, values.src);
	const outDir = path.join(ROOT, values.out);

	if (!fs.existsSync(binDir)) {
		process.stderr.write(`mksyx: ${binDir} is missing - run "make" first (it needs asl and p2bin)\n`);
		process.exit(1);
	}

	// Read the load address and offsets out of dumper.inc, and the model catalogue.
	const equ = parseEquates(fs.readFileSync(path.join(srcDir, 'dumper.inc'), 'utf8'));
	const {TXOFS: txOfs, TABLEOFS: tableOfs, LOADADDR: loadAddr} = equ;
	if (txOfs === undefined || tableOfs === undefined || loadAddr === undefined) {
		throw new Error('dumper.inc has no LOADADDR / TXOFS / TABLEOFS');
	}

	const catalogue = JSON.parse(fs.readFileSync(path.join(srcDir, 'catalogue.json'), 'utf8'));

	// Discover the payloads the assembler built, and read each one in.
	const payloads = fs.readdirSync(binDir).
		filter((f) => (/^dumper_.+[.]bin$/u).test(f)).
		map((f) => f.slice('dumper_'.length, -'.bin'.length)).
		sort();
	if (!payloads.length) {
		process.stderr.write(`mksyx: no dumper_*.bin in ${binDir} - run "make" first (it needs asl and p2bin)\n`);
		process.exit(1);
	}
	const bodies = {};
	for (const kind of payloads) {
		const body = new Uint8Array(fs.readFileSync(path.join(binDir, `dumper_${kind}.bin`)));
		if (body.length > tableOfs) {
			throw new Error(`payload ${kind} is ${body.length} bytes, past TABLEOFS ${tableOfs}`);
		}
		bodies[kind] = body;
	}

	// Discover the tables the assembler built.

	const tables = fs.readdirSync(binDir).
		filter((f) => f.endsWith('.bin')).
		map((f) => f.slice(0, -'.bin'.length)).
		filter((f) => (f === 'probe' || (/^(mcu-)?wave-/u).test(f))).
		sort();

	fs.mkdirSync(outDir, {recursive: true});
	const writtenFiles = [];

	// The .syx is just the messages; only the .mid has somewhere to put a name, so that is where the title goes.
	function writeSyxAndMid(stem, messages, name) {
		const bytes = concatSysex(messages);
		fs.writeFileSync(path.join(outDir, `${stem}.syx`), bytes);
		fs.writeFileSync(path.join(outDir, `${stem}.mid`), writeSmf(messages, {name}));
		writtenFiles.push([stem, messages.length, bytes.length]);
		return messages;
	}

	// The GS reset goes out before any of it.
	const resetMessages = writeSyxAndMid(
		'00-gsreset', [gsResetMessage()],
		formatSmfTitle(0, 'GS reset'),
	);

	// Write the shared body, then each payload's own transmit module and the trigger.
	// The body is the same in every payload, byte for byte. (That is what the branches at the top of a transmit module are for.)
	// So it goes out once, and each module follows on its own - both start on a bulk dump block boundary,
	// so this is only a matter of where the messages are addressed.
	//
	// Sending them apart is what lets someone work out an unsupported model: try the other transmit module,
	// or another file table, without resending anything else.
	const [firstKind] = payloads;
	const body = bodies[firstKind].slice(0, txOfs);
	for (const kind of payloads) {
		const also = bodies[kind].slice(0, txOfs);
		if (also.length !== body.length || also.some((e, i) => (e !== body[i]))) {
			throw new Error(`payload ${kind} has a different body from ${firstKind}: ` +
				'the transmit modules are meant to be the only difference');
		}
	}
	const bodyMessages = writeSyxAndMid(
		'01-body', buildBulkMessages(body, 0),
		formatSmfTitle(1, 'body'),
	);
	const loaders = {};
	for (const kind of payloads) {
		loaders[kind] = [...bodyMessages, ...writeSyxAndMid(
			`02-tx-${kind}`,
			buildBulkMessages(bodies[kind].slice(txOfs), txOfs),
			formatSmfTitle(2, `transmit module, ${getCpuLabel(kind)}`),
		)];
	}
	const triggerMessages = writeSyxAndMid(
		'04-trigger', [triggerMessage()],
		formatSmfTitle(4, 'trigger'),
	);

	// Write each file table, and build its config entry for models.json.
	const configs = {};
	const tableMessages = {};
	for (const name of tables) {
		const bytes = new Uint8Array(fs.readFileSync(path.join(binDir, `${name}.bin`)));
		const files = parseTable(bytes);
		const {seconds} = estimateDumpTime({files});

		tableMessages[name] = writeSyxAndMid(
			`03-${name}`,
			buildBulkMessages(bytes, tableOfs),
			formatSmfTitle(3, `file table ${name}, ${files.length} file(s) (${formatDuration(seconds)})`),
		);

		const declared = catalogue.configs?.[name] ?? {};
		configs[name] = {
			note: declared.note ?? '',
			isLayoutConfirmed: declared.isLayoutConfirmed ?? false,
			table: `03-${name}.syx`,
			trigger: '04-trigger.syx',
			files: files.map((file) => ({
				name: file.name,
				size: file.size,
				source: SOURCE_NAMES[file.source] ?? String(file.source),
				start: file.addr,
			})),
			seconds,
		};
	}

	// Build the model index for models.json.
	// Only models whose payload and table were both built are offered.
	const models = {};
	const pairs = new Map();
	// Which layout each system information block has already been claimed by, so the check below can see across models.
	const configByBlock = new Map();
	for (const [key, model] of Object.entries(catalogue.models ?? {})) {
		const kind = model.dumper ?? DEFAULT_PAYLOAD;
		if (!configs[model.config]) {
			process.stderr.write(`mksyx: ${key} wants config ${model.config}, which was not built - skipping\n`);
			continue;
		}
		if (!loaders[kind]) {
			process.stderr.write(`mksyx: ${key} wants payload ${kind}, which was not built - skipping\n`);
			continue;
		}
		pairs.set(`${kind}/${model.config}`, [kind, model.config]);
		// Whether this synth itself has been dumped, which is not the same as whether its layout was measured.
		// A dump can run to completion while it reads the wrong addresses, so neither one implies the other.
		models[key] = {
			label: model.label,
			config: model.config,
			dumper: kind,
			isDumpTested: model.isDumpTested ?? false,
			loader: ['00-gsreset.syx', '01-body.syx', `02-tx-${kind}.syx`],
			dump: `dump-${model.config}-${kind}.syx`,
		};
		if (model.systemInfo) {
			// The catalogue holds the 32 bytes, written either as the 32 characters or as 64 hex digits.
			// An editor that trims the trailing spaces off the readable form would silently break every match,
			// so it is worth stopping the build over.
			for (const entry of model.systemInfo) {
				const isHexEncoded = ((entry.length === 64) && (/^[0-9a-fA-F]{64}$/u).test(entry));
				if (!isHexEncoded && entry.length !== 32) {
					throw new Error(`${key}: systemInfo ${JSON.stringify(entry)} is ${entry.length} characters, ` +
						'not the 32 bytes the synth returns (or 64 hex digits)');
				}
				// One block, one layout. The page names the synth from these 32 bytes and then dumps what that
				// layout needs, so a block two layouts both claim would quietly have one of them picked for it.
				// Two models sharing a block is fine - the SC-55 and the SC-155 do - as long as they agree here.
				// Both spellings of the same bytes have to land on the same key, so the hex form is decoded first.
				const block = (isHexEncoded) ? entry.replace(/../gu, (pair) => String.fromCharCode(parseInt(pair, 16))) : entry;
				const owner = configByBlock.get(block);
				if (owner && owner.config !== model.config) {
					throw new Error(`${key}: systemInfo ${JSON.stringify(entry)} is also ${owner.key}'s, ` +
						`but ${key} is ${model.config} and ${owner.key} is ${owner.config}. ` +
						'One block cannot name two wave ROM layouts');
				}
				configByBlock.set(block, {key, config: model.config});
			}
			models[key].systemInfo = model.systemInfo;
		}
	}

	// The probe is not a model's table, so nothing above pairs it with a payload. Give it one of each,
	// so it can be played at any synth.
	for (const kind of payloads) {
		if (configs.probe) {
			pairs.set(`${kind}/probe`, [kind, 'probe']);
		}
	}

	// Write one combined dump file per (payload, table) pair in use.
	// One combined file per pair in use: loader, table and trigger back to back, for playing straight at the synth.
	for (const [kind, name] of pairs.values()) {
		const allMessages = [...resetMessages, ...loaders[kind], ...tableMessages[name], ...triggerMessages];
		const stem = `dump-${name}-${kind}`;

		// Named by the synths it is for, because that is what someone picks it by. A label can hold a comma of its own
		// - "Roland CM-300, SCC-1" - so synths are separated with a slash, and the time goes in parentheses at the end.
		// The probe belongs to no model, so it names its transmit path instead.
		const users = Object.values(models).
			filter((m) => (m.dumper === kind && m.config === name)).
			map((m) => m.label);
		const what = (users.length) ? users.join(' / ') : `${name} over the ${getCpuLabel(kind)}`;

		fs.writeFileSync(path.join(outDir, `${stem}.syx`), concatSysex(allMessages));
		fs.writeFileSync(path.join(outDir, `${stem}.mid`), writeSmf(
			allMessages,
			{name: formatSmfTitle(0, `${what} (${formatDuration(configs[name].seconds)})`)},
		));
		writtenFiles.push([stem, allMessages.length, concatSysex(allMessages).length]);
	}

	// Write the models.json index.
	fs.writeFileSync(
		path.join(outDir, 'models.json'),
		`${JSON.stringify({configs, models}, null, '\t')}\n`,
	);

	// Remove anything left over from an earlier build.
	// Drop anything left from an earlier build. Dropping a payload or a layout would otherwise leave its files behind,
	// and a stale 02-tx-*.syx that no model asks for any more is worse than confusing: someone could still find it and
	// play it.
	const keepFiles = new Set(writtenFiles.flatMap(([stem]) => [`${stem}.syx`, `${stem}.mid`]));
	keepFiles.add('models.json');
	for (const file of fs.readdirSync(outDir)) {
		if ((file.endsWith('.syx') || file.endsWith('.mid')) && !keepFiles.has(file)) {
			fs.unlinkSync(path.join(outDir, file));
			process.stderr.write(`mksyx: removed stale ${file}\n`);
		}
	}
	writtenFiles.push(['models.json', Object.keys(models).length, fs.readFileSync(path.join(outDir, 'models.json')).length]);

	// Print the build summary. Every column is measured from what is about to be printed, so a longer payload, layout or
	// file name widens its column instead of pushing everything after it out of line.
	process.stderr.write(`loads at H'${toHex(loadAddr)}, table at +H'${toHex(tableOfs)}\n`);
	const kindWidth = Math.max(...payloads.map((kind) => kind.length)) + 1;
	for (const kind of payloads) {
		const users = Object.entries(models).filter(([, model]) => (model.dumper === kind)).map(([k]) => k);
		process.stderr.write(`  payload ${kind.padEnd(kindWidth)}${String(bodies[kind].length).padStart(4)}` +
			` bytes   ${(users.length) ? users.join(', ') : '(no synth uses it)'}\n`);
	}
	const nameWidth = Math.max(...tables.map((name) => name.length)) + 1;
	for (const name of tables) {
		const config = configs[name];
		const users = Object.entries(models).filter(([, model]) => (model.config === name)).map(([k]) => k);
		process.stderr.write(`  ${name.padEnd(nameWidth)}${String(config.files.length).padStart(3)} file(s)` +
			// a column of its own, so the synths below start in the same place whether or not this one is flagged
			`  ${((config.isLayoutConfirmed) ? '' : 'unconfirmed').padEnd('unconfirmed'.length)}` +
			// which synths use it, from the catalogue - not which ones the page offers, which is the page's business
			`${(users.length) ? `   ${users.join(', ')}` : '   (no synth uses it)'}\n`);
	}

	// Printed so that a misspelled isDumpTested in the catalogue shows here as every synth at once,
	// rather than reading as false everywhere and saying nothing.
	const untestedKeys = Object.entries(models).filter(([, model]) => (!model.isDumpTested)).map(([key]) => key);
	if (untestedKeys.length > 0) {
		process.stderr.write(`  not yet tested on hardware: ${untestedKeys.join(', ')}\n`);
	}

	// The name a file is reported under is the one it was written under, and both the header and the rows line up to it.
	const fileRows = writtenFiles.map(([stem, messageCount, size]) => {
		const name = (stem.endsWith('.json')) ? stem : `${stem}.syx`;
		return [name, messageCount, size];
	});
	const fileWidth = Math.max(...fileRows.map(([name]) => name.length)) + 1;
	process.stderr.write('\n');
	process.stderr.write(`  ${'file'.padEnd(fileWidth)}${'messages'.padStart(8)}${'bytes'.padStart(8)}\n`);
	for (const [name, messageCount, size] of fileRows) {
		process.stderr.write(`  ${name.padEnd(fileWidth)}${String(messageCount).padStart(8)}${String(size).padStart(8)}\n`);
	}
	process.stderr.write(`\nwritten to ${path.basename(outDir)}/  (.syx and .mid of each)\n`);
}

main();
