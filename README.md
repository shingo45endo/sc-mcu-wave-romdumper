sc-mcu-wave-romdumper
=====================

Dump the wave ROMs (and the MCU's internal ROM) of a Roland SC series over MIDI, all at once.

The MCU's internal ROM cannot be read from outside the chip. The wave ROMs could be read with a chip programmer, but they are soldered to the board rather than socketed, and sometimes surface-mounted, so pulling one out is not easy.

But code running on the MCU itself can read both. This tool puts a small program into the synth's RAM. That program reads the ROMs and sends the data back as MIDI System Exclusive (SysEx).

Two steps:

1. **[Patch the firmware ROM](index.html)** -- give it the external ROM image, get a patched one back, and burn it. Only 17 bytes change.
2. **[Dump over MIDI](dump.html)** -- the browser loads the dumper into RAM and starts it. Then it collects the reply and saves the ROM images.

Everything happens in your browser. No file is uploaded anywhere.


What you need
-------------

* A Roland SC-55 or a close relative, and a way to burn its external ROM
* A MIDI interface, In and Out both connected
* A browser with Web MIDI for the dump page: Chrome, Edge or Firefox. Safari has none.
    * Chrome and Edge: just show a permission popup the first time
    * Firefox: needs a site permission add-on instead


Supported Models
----------------

| Model name                | ROM images it produces         | MCU    | MIDI Out via | Testing on a real device |
| ------------------------- | ------------------------------ | ------ | ------------ | ------------------------ |
| Roland SC-55              | MCU 32 KiB, wave 1 MiB x 3     | H8/532 | main CPU     | done                     |
| Roland SC-155             | MCU 32 KiB, wave 1 MiB x 3     | H8/532 | main CPU     | not yet                  |
| Roland SC-55mkII, SC-55ST | MCU 32 KiB, wave 2 MiB + 1 MiB | H8/532 | sub-CPU      | done                     |
| Roland SC-33              | MCU 32 KiB, wave 2 MiB         | H8/532 | main CPU     | done                     |
| Boss DS-330               | MCU 32 KiB, wave 2 MiB         | H8/532 | main CPU     | not yet                  |
| Roland SD-35              | MCU 32 KiB, wave 1 MiB         | H8/532 | main CPU     | done                     |
| Roland RA-30              | wave 1 MiB                     | H8/510 | main CPU     | not yet                  |
| Roland XP-10              | wave 2 MiB x 2                 | H8/510 | main CPU     | not yet                  |

The following models probably work too, but because it is difficult to replace their firmware ROMs, they are not directly supported on the website. The command-line tool does not have this limitation.

| Model name           | ROM images it produces     | MCU    | MIDI Out via | Testing on a real device |
| -------------------- | -------------------------- | ------ | ------------ | ------------------------ |
| Roland CM-300, SCC-1 | MCU 32 KiB, wave 1 MiB x 3 | H8/532 | main CPU     | not yet                  |
| Roland PMA-5         | wave 2 MiB                 | H8/510 | main CPU     | not yet                  |


How the patch works
-------------------

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


What the dumper does
--------------------

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
