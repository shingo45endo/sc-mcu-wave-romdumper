;==========================================================================
; sc-mcu-wave-romdumper - payload for the SC-55mkII family, whose sub-CPU puts the bytes on MIDI Out
;
; Models:
;   SC-55mkII, SC-55ST, SC-55K
;
; Body and transmit module, in that order. Everything model specific is either in the file table or in the module.
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
; The module starts on a bulk dump block boundary, so that a loader message never straddles the seam between the body
; and the module.
;--------------------------------------------------------------------------
		if	*>LOADADDR+TXOFS
		 fatal	"the body has grown past TXOFS - raise it in dumper.inc"
		endif

		org	LOADADDR+TXOFS

; The one address the sub-CPU models do not agree on. Everything else the module touches is the same on all of them.
; It is a byte of the firmware's own RAM, so it moves with the firmware build rather than with the board.
TXGATE		equ	$D464		; SC-55mkII, SC-55ST, SC-55K

		include	tx_subcpu.inc

;--------------------------------------------------------------------------
; The module has to stay clear of the file table.
;--------------------------------------------------------------------------
		if	*>LOADADDR+TABLEOFS
		 fatal	"the transmit module has grown past TABLEOFS - raise it in dumper.inc"
		endif

		org	LOADADDR+TABLEOFS

		end
