;==========================================================================
; sc-mcu-wave-romdumper - dumper for the SC-88 and the SC-88VL
;
; Wave ROM: 2 MiB in each of four chip selects. The two models read the same one.
;
; Assemble with the Macroassembler AS, or just run "make":
;
;   asl -cpu HD6475328 -i src/88 -o build/dumper_sc88.p src/88/dumper_sc88.asm
;   p2bin build/dumper_sc88.p build/dumper_sc88.bin -r '$-$' -l 0
;==========================================================================

		cpu	HD6475328
		maxmode	on
		assume	dp:0,ep:0,tp:0,br:0

LOADADDR	equ	$9104		; DRUM SETUP A, drum map 2. 908 bytes
RAMPAGE		equ	$08
XPPAGE		equ	$0E

; The four user areas, back to back, ending at C060:
;   28 00 00  User Tone Bank #64  AA40  1408      29 00 00  User Drum Set #65  B540  1424
;   28 10 00  User Tone Bank #65  AFC0  1408      29 10 00  User Drum Set #66  BAD0  1424
BUF		equ	$AA40
BUFSIZE		equ	5664

		include	dumper_88.inc

		end
