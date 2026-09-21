;==========================================================================
; sc-mcu-wave-romdumper - dumper for the SC-88Pro
;
; The same code as the SC-88 and the SC-88VL. What moves is where the RAM and the tone generator answer, and with
; them the whole bulk dump area, which sits H'3000 lower.
;
; Wave ROM: 4 MiB in each of five chip selects, which is more than the SC-88 has. Untested: there is no machine here.
;
; The Pro also has USER PATCH PART, 8192 bytes in one run, which would carry half again as much per pass. Untested
; as well, so this keeps to the user tone banks and drum sets that the whole family has.
;
; Assemble with the Macroassembler AS, or just run "make":
;
;   asl -cpu HD6475328 -i src/88 -o build/dumper_sc88pro.p src/88/dumper_sc88pro.asm
;   p2bin build/dumper_sc88pro.p build/dumper_sc88pro.bin -r '$-$' -l 0
;==========================================================================

		cpu	HD6475328
		maxmode	on
		assume	dp:0,ep:0,tp:0,br:0

LOADADDR	equ	$6104		; DRUM SETUP A, drum map 2. 908 bytes
RAMPAGE		equ	$C0
XPPAGE		equ	$C8

; The four user areas, back to back, ending at 9060:
;   28 00 00  User Tone Bank #64  7A40  1408      29 00 00  User Drum Set #65  8540  1424
;   28 10 00  User Tone Bank #65  7FC0  1408      29 10 00  User Drum Set #66  8AD0  1424
BUF		equ	$7A40
BUFSIZE		equ	5664

		include	dumper_88.inc

		end
