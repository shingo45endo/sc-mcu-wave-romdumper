;==========================================================================
; sc-mcu-wave-romdumper - payload for the SC-55mkII family, whose sub-CPU puts the bytes on MIDI Out
;
; Models:
;   SC-55mkII, SC-55ST, SC-55K
;
; Body, transmit module and wave ROM read module, in that order. Everything model specific is either in the file
; table or in one of the modules.
;
; Assemble with the Macroassembler AS, or just run "make":
;
;   asl -cpu HD6475328 -i src -o build/dumper_subcpu.p src/dumper_subcpu.asm
;   p2bin build/dumper_subcpu.p build/dumper_subcpu.bin -r '$-$' -l 0
;==========================================================================

		cpu	HD6475328
		maxmode	on
		assume	dp:0,ep:0,tp:0,br:0

		include	dumper.inc
		include	dumper_body.inc

;--------------------------------------------------------------------------
; The modules start on a bulk dump block boundary, so that a loader message never straddles the seam between the body
; and the modules.
;--------------------------------------------------------------------------
		if	*>LOADADDR+TXOFS
		 fatal	"the body has grown past TXOFS - raise it in dumper.inc"
		endif

		org	LOADADDR+TXOFS

; The one address the sub-CPU models do not agree on. Everything else the module touches is the same on all of them.
; It is a byte of the firmware's own RAM, so it moves with the firmware build rather than with the board.
TXGATE		equ	$D464		; SC-55mkII, SC-55ST, SC-55K

		include	tx_subcpu.inc
		include	rd_pcm532.inc

;--------------------------------------------------------------------------
; The modules have to stay clear of the file table.
;--------------------------------------------------------------------------
		if	*>LOADADDR+TABLEOFS
		 fatal	"the modules have grown past TABLEOFS - raise it in dumper.inc"
		endif

		org	LOADADDR+TABLEOFS

		end
