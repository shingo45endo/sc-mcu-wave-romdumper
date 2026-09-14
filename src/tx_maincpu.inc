;==========================================================================
; Transmit module: the main CPU, through its own SCI
;
; What the SC-55 and everything before the SC-55mkII uses. MIDI Out hangs off the CPU's own serial port.
; So sending a byte is one write to TDR, once TDRE says the shift register is free.
;
; Interrupts stay masked for the whole dump. The firmware's active sensing interrupt writes TDR directly and would land
; in the middle of ours. That is safe because no SC-55 firmware ever programmes the H8/532 watchdog.
;
; Included from dumper_maincpu.asm. See dumper_body.inc for the four entry points a transmit module has to provide,
; and why they are branches.
;==========================================================================

SSR		equ	$FFDC				; SCI status  (bit 7 = TDRE)
TDR		equ	$FFDB				; SCI transmit data

txopen:		BRA	sciopen
txs:		BRA	scitxs
tx:		BRA	scitx
txclose:	BRA	sciclose

sciopen:	ORC.W	#$0700,SR			; Mask interrupts for the whole dump.
		RTS

;--------------------------------------------------------------------------
; scitxs: send R0 and fold it into the checksum
; scitx:  polled SCI transmit
;--------------------------------------------------------------------------
scitxs:		MOV:G.W	R1,@-SP
		MOV:F.B	@(V_CSUM,FP),R1
		XOR:G.B	R0,R1				; The packet checksum is an XOR.
		MOV:F.B	R1,@(V_CSUM,FP)
		MOV:G.W	@SP+,R1
scitx:		BTST.B	#7,@SSR:16			; TDRE: is the shift register free?
		BEQ	scitx				; Poll until it is.
		MOV:G.B	R0,@TDR:16
		BCLR.B	#7,@SSR:16			; Clear TDRE, as the H8 asks.
		RTS

sciclose:	ANDC.W	#$F8FF,SR			; interrupts back on
		RTS
