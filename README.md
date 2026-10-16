sc-mcu-wave-romdumper
=====================


What is this?
-------------

Dump the wave ROMs of a Roland Sound Canvas over MIDI, and the MCU's internal ROM where it has one.

The MCU's internal ROM cannot be read from outside the chip. The wave ROMs could be read with a chip programmer, but they are soldered to the board rather than socketed, and sometimes surface-mounted, so pulling one out is not easy.

But code running on the MCU itself can read both. This tool puts a small program into the synth's RAM. That program reads the ROMs, and the data comes back over MIDI as System Exclusive (SysEx) messages.

Everything happens in your browser. No file is uploaded anywhere.


How to Use
----------

1. **[Patch the firmware ROM](index.html)** -- give it the external ROM image, get a patched one back, and burn it. Only 17 bytes change, or 24 on the SC-88 family.
2. **[Dump over MIDI](dump.html)** -- the browser loads the dumper into RAM and starts it. Then it collects the reply and saves the ROM images.

### What you need

* A Roland SC-55 or SC-88, or a close relative of either, and a way to burn its external ROM
* A MIDI interface, In and Out both connected
* A browser with Web MIDI for the dump page: Chrome, Edge or Firefox. Safari has none.
	* Chrome and Edge: just show a permission popup the first time
	* Firefox: needs a site permission add-on instead


Supported Models
----------------

| Model name                  | ROM images it produces         | MCU    | MIDI Out via | Testing on a real device |
| --------------------------- | ------------------------------ | ------ | ------------ | ------------------------ |
| Roland SC-55                | MCU 32 KiB, wave 1 MiB x 3     | H8/532 | its own SCI  | done                     |
| Roland SC-155               | MCU 32 KiB, wave 1 MiB x 3     | H8/532 | its own SCI  | done                     |
| Roland SC-55mkII, SC-55ST/K | MCU 32 KiB, wave 2 MiB + 1 MiB | H8/532 | sub-CPU      | done                     |
| Roland SC-50                | MCU 32 KiB, wave 2 MiB         | H8/532 | sub-CPU      | not yet                  |
| Roland SC-33                | MCU 32 KiB, wave 2 MiB         | H8/532 | its own SCI  | done                     |
| Boss DS-330                 | MCU 32 KiB, wave 2 MiB         | H8/532 | its own SCI  | not yet                  |
| Roland SD-35                | MCU 32 KiB, wave 1 MiB         | H8/532 | its own SCI  | done                     |
| Roland RA-30                | wave 1 MiB                     | H8/510 | its own SCI  | done                     |
| Roland XP-10                | wave 2 MiB x 2                 | H8/510 | its own SCI  | not yet                  |

The following models probably work too, but because it is difficult to replace their firmware ROMs, they are not directly supported on the website. The command-line tool does not have this limitation.

| Model name           | ROM images it produces     | MCU    | MIDI Out via | Testing on a real device |
| -------------------- | -------------------------- | ------ | ------------ | ------------------------ |
| Roland CM-300, SCC-1 | MCU 32 KiB, wave 1 MiB x 3 | H8/532 | its own SCI  | not yet                  |
| Roland PMA-5         | wave 2 MiB                 | H8/510 | its own SCI  | not yet                  |

The SC-88 family gets the data back another way. Its main CPU has no MIDI Out of its own, so the dumper leaves the wave ROM in RAM and the host reads it back a piece at a time. The website and the command line tool both do this.

| Model name      | ROM images it produces | MCU    | How it comes back  | Testing on a real device |
| --------------- | ---------------------- | ------ | ------------------ | ------------------------ |
| Roland SC-88    | wave 2 MiB x 4         | H8/510 | read back from RAM | not yet                  |
| Roland SC-88VL  | wave 2 MiB x 4         | H8/510 | read back from RAM | done                     |
| Roland SC-88Pro | wave 4 MiB x 5         | H8/510 | read back from RAM | done                     |

One chip takes about half an hour on the SC-88 and SC-88VL, and about an hour on the SC-88Pro. The chips are offered one at a time. **The user tone banks and user drum sets are lost**: the dumper uses them as its buffer, and nothing puts them back.


How the patch works
-------------------

### The SC-55 family

The patch changes one entry in the SysEx handler's jump table. That entry is for the GS parameter "Pitch Offset Fine (`40 1x 17`)". It now points to a 15-byte "stub" placed in unused ROM space:

	CMP:G.W #H'C0DA,@H'8CD6:16      ; Is the dumper loaded in RAM?
	BNE     .+4
	PJSR    @H'08CD4                ; Yes: run it
	JMP     @H'14DF                 ; then, either way, the real handler


`H'C0DA` ("coda" - the jump-here mark) is a signature the dumper writes at the start of its RAM area. The stub determines whether the dumper has been loaded based on the presence or absence of this magic number, and then jumps to `H'8CD4`.

`H'8CD4` is the area used for Drum Set 2 settings, and can be stored any value there using Sound Canvas bulk dump SysEx.

In other words, with this patch, you can:

1. Store a "user program" built in advance for the H8/500 using bulk dump SysEx for Drum Set 2 (`49 1n 00`).
2. Trigger the user program using the Pitch Offset Fine SysEx (`40 1x 17`).

**When the dumper is not loaded, the synth behaves exactly like before the patch.**

### The SC-88 family

The patch changes the same entry, for the same parameter. The stub is 22 bytes, because the handler it returns to expects the page register (DP) to hold its own value. So the stub saves it, points it at RAM, and puts it back afterwards:

	STC.B   DP,@-SP                 ; Save the page register
	LDC.B   #H'08,DP                ; Point it at RAM
	CMP:G.W #H'C0DA,@H'9106:16      ; Is the dumper loaded in RAM?
	BNE     .+4
	PJSR    @H'089104               ; Yes: run it
	LDC.B   @SP+,DP                 ; Put the page register back
	JMP     @H'46E6                 ; then, either way, the real handler

This is the SC-88VL. The addresses are read out of each ROM, not fixed: the load address from the ROM's table of the areas bulk dump can reach (drum map 2, `49 10 00`), and the RAM page from how the firmware sets DP. On the SC-88Pro, the dumper goes to `H'C06104`.


What the dumper does
--------------------

### The SC-55 family

The dumper reads the MCU's internal ROM (if present) and the waveform ROM(s), and transmits the data via MIDI.

As shown below, the ROM configuration varies by synth, and accordingly, the areas that need to be dumped by the dumper also differ.

* **MCU's internal ROM**: Depends on the type of MCU used in the synth. Only the H8/532 has 32 KiB of ROM.
* **Wave ROM(s)**: Depends on the wiring layout between the PCM chip and the waveform ROM(s). Consequently, the size and number of waveform ROM are also determined by this.

As for MIDI transmission and reception, some synths use the main MCU's serial port, while others use a separate sub-MCU dedicated to MIDI communication. Consequently, the processing of the dumper differs for each type.

* **Main CPU**: MIDI Out uses the CPU's own serial port. The dumper polls it directly, with interrupts turned off.
* **Sub-CPU**: A second processor controls MIDI, and the serial port is not connected to anything. So the dumper places each byte in a shared RAM area and hands it to that processor. Here, interrupts must stay ON, because the handover itself relies on one.

The dump page can select the appropriate dumper - one with processing tailored to the specific synth model - simply by selecting the model.

The dumper uses the standard MIDI File Dump (RP-009) format (open loop - no handshake needed) to transmit ROM data. First, a header names each file. Then, data packets follow, each carrying 112 bytes. The dump page receives these SysEx messages, reconstructs them as files, and saves them.

The wave ROM data arrives exactly as the PCM chip receives it - not as a plain ROM dump. That is because the circuit board scrambles both the address and data wiring between the chip and the ROM chips. So, dump page rearranges it into the ROM's own order automatically before saving.

### The SC-88 family

The main CPU of the SC-88 family has no MIDI Out of its own, so the dumper sends nothing. It reads one piece of the wave ROM into the user tone banks and user drum sets, seven bytes into every eight so that each one fits in a MIDI data byte. The dump page then asks for those areas with bulk dump requests, and the synth sends them back.

That is one pass: about 4.9 KB of the wave ROM, in about four seconds. The dump page repeats it until the chip is read. Every pass says where in the ROM it came from, so a pass that goes missing can be read again on its own (see [cli/README.md](cli/README.md)).

The wiring between the PCM chip and the wave ROMs is scrambled here too, but not the same way as on the SC-55 family. The dump page undoes that as well.


Doing it without a browser
--------------------------

See [cli/README.md](cli/README.md) for the command-line tools, the file formats, and how to add support for a new model.

For building from source, see [BUILD.md](BUILD.md).


License
-------

MIT


Author
------

[shingo45endo](https://github.com/shingo45endo)
