;==========================================================================
; Wave ROM read module: the PCM chip's read port, as the H8/532 models decode it
;
; The port is three registers in page 0. The write to the low half of the address is what starts the fetch, so the two
; address writes have to stay in this order.
;
; These are board addresses, not CPU addresses. The H8/510 models put the same three registers somewhere else -
; see rd_pcm510.inc.
;
; Included from dumper_maincpu532.asm and dumper_subcpu.asm. See dumper_body.inc for the entry point, and tx_*.inc for
; the branch table that holds it.
;==========================================================================

PCMAH		equ	$E021		; wave ROM address A23-A16
PCMAL		equ	$E022		; wave ROM address A15-A0
					;   (the write to A7-A0 fetches)
PCMDAT		equ	$E03F		; wave ROM read-back latch

;--------------------------------------------------------------------------
; pcmread: R0 = the wave ROM byte at R2:R1
;--------------------------------------------------------------------------
pcmread:	STC.W	SR,@-SP				; Save the mask: the sub-CPU module needs
		ORC.W	#$0700,SR			;   interrupts back on afterwards.
		MOV:G.B	R2,@PCMAH:16			; A23-A16
		MOV:G.W	R1,@PCMAL:16			; A15-A0
		MOV:G.B	@PCMDAT:16,R0
		LDC.W	@SP+,SR
		RTS
