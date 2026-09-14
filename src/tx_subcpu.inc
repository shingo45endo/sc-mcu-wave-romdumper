;==========================================================================
; Transmit module: the sub-CPU, the M37409
;
; In the SC-55mkII family (the mkII, the ST, and the K), a second processor handles MIDI, and the H8/532's SCI is not
; connected to anything. The two processors talk through a shared RAM window at page 0 H'EC00.
; The firmware keeps a 256-byte output ring there, and a handover routine feeds it to the sub-CPU sixteen bytes at a
; time.
;
; That routine lives in the MCU's internal ROM, which the patcher never sees. It is short, and every address in it is
; fixed. So it is copied here instead, instruction for instruction - the payload still holds no firmware address,
; which is the whole point of the body.
;
; Do not assume from a machine's shared RAM window that its MIDI goes through it. The SD-35 has the same window,
; and the same ring at the same addresses, and still puts MIDI Out on the H8's own SCI.
;
;   TXBUF   256-byte MIDI Out ring
;   TXRD    read pointer, the handover's own
;   TXWR    write pointer
;   TXGATE  bit 0 is a one-token permit to hand a batch over. It is not
;           hardware - it is a byte of the firmware's own RAM. That is why
;           it is named by the including file, rather than fixed here.
;
;           Initialisation grants the token. Handing a batch over spends
;           it. The sub-CPU grants it again by raising bit 4 of the
;           notification byte a read of SMKICK returns; the firmware's
;           interrupt handler turns that back into this bit. So "set"
;           means the sub-CPU has finished with the last batch, and
;           SMSTAGE is free.
;
;           Honouring it is not optional even when we are the only one with
;           something to send, because the firmware's own handover is behind
;           the same token. Leave it set and both run, and they halve the
;           ring between them - two bytes in three are lost on hardware
;   SMSTAGE where the batch is written in the window
;   SMFLAG  bit 1 tells the sub-CPU a batch is waiting
;   SMSEM   bit 7 is the window's semaphore
;   SMKICK  a write here interrupts the sub-CPU
;
; Everything but TXGATE is the same across the SC-55mkII, SC-55ST and SC-55K ROMs, which is every model known to
; transmit this way.
;
; Interrupts must stay ENABLED for the whole dump - the handler that sets TXGATE is an interrupt.
; They are masked only around the ring pointers and the handover itself, which is also why dumper_body.inc saves and
; restores SR around the wave ROM read instead of just unmasking.
;
; Included from dumper_subcpu.asm, which is where TXGATE is defined. See dumper_body.inc for the four entry points and
; why they are branches.
;==========================================================================

TXBUF		equ	$A6D0
TXRD		equ	$ACD2
TXWR		equ	$ACD4
SMSTAGE		equ	$EC00
SMFLAG		equ	$ECB9
SMKICK		equ	$ECF8
SMSEM		equ	$ECFF

BATCH		equ	16		; bytes per handover, as the firmware

txopen:		BRA	subopen
txs:		BRA	subtxs
tx:		BRA	subtx
txclose:	BRA	subclose

; interrupts stay on, so there is nothing to set up or to put back
subopen:
subclose:	RTS

;--------------------------------------------------------------------------
; subtxs: send R0 and fold it into the checksum
; subtx:  queue R0, then hand the queue to the sub-CPU
;
; One byte per handover. Waiting for the gate is what paces us, and it
; paces us at the speed of the wire.
;--------------------------------------------------------------------------
subtxs:		MOV:G.W	R1,@-SP
		MOV:F.B	@(V_CSUM,FP),R1
		XOR:G.B	R0,R1
		MOV:F.B	R1,@(V_CSUM,FP)
		MOV:G.W	@SP+,R1
subtx:		STM.W	(R0-R3),@-SP			; Only R0 may come back changed.
; queue the byte. The	pointers are shared with the firmware's interrupts
		ORC.W	#$0700,SR			; Mask while the pointers move.
		MOV:G.W	@TXWR:16,R1
		MOV:G.B	R0,@(TXBUF,R1)
		ADD:Q.W	#1,R1
		CMP:I.W	#$0100,R1			; The ring is 256 bytes.
		BCS	txwrap
		CLR.W	R1				; Wrap to the start.
txwrap:		MOV:G.W	R1,@TXWR:16
		ANDC.W	#$F8FF,SR			; Unmask: the gate arrives as an interrupt.
; wait for the sub-CPU to be ready. Not forever: if the gate never came
; back we would rather send late than stop the synth dead
		MOV:I.W	#0,R2				; Count down from 65536, then give up.
txwait:		BTST.B	#0,@TXGATE:16			; Do we hold the permit?
		BNE	txgo
		ADD:Q.W	#-1,R2
		BNE	txwait
; hand over up to BATCH	bytes, exactly as the firmware's routine does
txgo:		ORC.W	#$0700,SR
		MOV:G.W	@TXRD:16,R0
		CMP:G.W	@TXWR:16,R0
		BEQ	txdone				; The ring is empty, so there is nothing to send.
		MOV:I.W	#SMSTAGE,R2
		MOV:I.W	#BATCH-1,R3
txcopy:		MOV:G.B	@(TXBUF,R0),R1
		MOV:G.B	R1,@R2+				; into the shared window
		ADD:Q.W	#1,R0
		CMP:I.W	#$0100,R0
		BCS	txnowrap
		CLR.W	R0
txnowrap:	CMP:G.W	@TXWR:16,R0
		BEQ	txstore				; Caught up with the writer.
		SCB/F	R3,txcopy			; SCB/F counts down to zero, so this is BATCH bytes.
txstore:	MOV:G.W	R0,@TXRD:16
txsem:		BTST.B	#7,@SMSEM:16			; Wait for the window's semaphore.
		BEQ	txsem
		BSET.B	#1,@SMFLAG:16			; A batch is waiting.
		BCLR.B	#0,@TXGATE:16			; Spend the permit.
		CLR.B	@SMKICK:16			; Interrupt the sub-CPU.
txdone:		ANDC.W	#$F8FF,SR
		LDM.W	@SP+,(R0-R3)
		RTS
