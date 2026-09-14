const SUB_HEADER = 0x01;
const SUB_PACKET = 0x02;

export class FileDumpReceiver {
	constructor() {
		this.files = [];
		this.errors = [];
		this.current = null;
		this.pendingBytes = [];	// partial SysEx while scanning a raw stream
		this.isInSysex = false;
		this.strayBytes = 0;
	}

	// Accept a complete message, a fragment, or a whole capture.
	feed(bytes) {
		for (const byte of bytes) {
			if (byte === 0xf0) {
				if (this.isInSysex) {
					this.errors.push('a SysEx message was truncated');
				}
				this.isInSysex = true;
				this.pendingBytes = [0xf0];
			} else if (this.isInSysex) {
				this.pendingBytes.push(byte);
				if (byte === 0xf7) {
					this.isInSysex = false;
					this.handleMessage(this.pendingBytes);
					this.pendingBytes = [];
				} else if (byte >= 0x80 && byte !== 0xf7) {
					// a status byte inside SysEx: real time bytes are allowed through
					if (byte < 0xf8) {
						this.isInSysex = false;
						this.errors.push(`SysEx interrupted by ${byte.toString(16)}`);
						this.pendingBytes = [];
					} else {
						this.pendingBytes.pop();
					}
				}
			} else if (byte < 0xf8) {
				this.strayBytes++;
			}
		}

		return this;
	}

	handleMessage(message) {
		if (message.length < 6 || message[1] !== 0x7e || message[3] !== 0x07) {
			return;
		}

		if (message[4] === SUB_HEADER) {
			const body = message.slice(5, -1);
			if (body.length < 9) {
				this.errors.push('a file dump header was too short');
				return;
			}
			const size = body.slice(5, 9).reduce((a, b, k) => a + (b << (7 * k)), 0);
			this.current = {
				name: String.fromCharCode(...body.slice(9)).replace(/\0.*$/u, ''),
				type: String.fromCharCode(...body.slice(1, 5)),
				sender: body[0],
				size,
				bytes: new Uint8Array(size + 128),
				received: 0,
				packets: 0,
				nextPacketNo: 0,
				errors: [],
			};
			this.files.push(this.current);
			return;
		}

		if (message[4] !== SUB_PACKET) {
			return;
		}
		const file = this.current;
		if (!file) {
			this.errors.push('a data packet arrived before any header');
			return;
		}

		const packetNo = message[5];
		console.assert(packetNo === (packetNo & 0x7f), 'a packet number cannot have its top bit set');
		const count = message[6];
		const body = message.slice(7, -2);
		const checksum = message[message.length - 2];

		let sum = 0;
		for (let i = 1; i < message.length - 2; i++) {
			sum ^= message[i];
		}
		if (sum !== checksum) {
			file.errors.push(`packet ${packetNo}: checksum ${toHexByte(checksum)}, computed ${toHexByte(sum)}`);
		}
		if (count !== body.length - 1) {
			file.errors.push(`packet ${packetNo}: byte count ${count} but ${body.length} bytes`);
		}
		if (packetNo !== file.nextPacketNo) {
			file.errors.push(`packet ${packetNo} arrived where ${file.nextPacketNo} was expected`);
		}
		file.nextPacketNo = (packetNo + 1) & 0x7f;
		file.packets++;

		for (let g = 0; g + 7 < body.length; g += 8) {
			const msb = body[g];
			for (let k = 0; k < 7; k++) {
				if (file.received >= file.bytes.length) {
					break;
				}
				file.bytes[file.received++] = body[g + 1 + k] | (((msb >> (6 - k)) & 1) << 7);
			}
		}
	}

	// How each file is doing, without copying any of it.
	getProperties() {
		return this.files.map(getFileProperties);
	}

	// One file, trimmed to the size its header declared.
	getFile(index) {
		const file = this.files[index];
		if (!file) {
			return null;
		}
		return {...getFileProperties(file), bytes: file.bytes.slice(0, Math.min(file.size, file.received))};
	}

	// Every file, trimmed to the size its header declared.
	getResults() {
		return this.files.map((_, i) => this.getFile(i));
	}
}

function toHexByte(value) {
	return value.toString(16).toUpperCase().padStart(2, '0');
}

function getFileProperties(file) {
	return {
		name: file.name,
		type: file.type,
		sender: file.sender,
		size: file.size,
		packets: file.packets,
		errors: file.errors,
		isComplete: file.received >= file.size,
		received: Math.min(file.size, file.received),
		padding: Math.max(0, file.received - file.size),
	};
}
