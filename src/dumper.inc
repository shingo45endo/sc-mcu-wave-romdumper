;==========================================================================
; sc-mcu-wave-romdumper - definitions shared by the body and every table
;
; Include this from each dumper_*.asm and from each wave-*.asm. Nothing here is model specific except LOADADDR.
; Even that only matters to the loader and to the PJSR in the ROM hook - the body itself is position independent.
;==========================================================================

;--------------------------------------------------------------------------
; Where the parts are loaded.
;
;   +H'000  block  0  the body, the same on every model byte for byte
;   +H'1C0  block  7  the transmit module, one per way out to MIDI
;   +H'280  block 10  the file table, one per wave ROM layout
;   +H'380  block 14  the argument block, shared with the host
;   +H'38C            end of the drum map, and of what may be loaded
;--------------------------------------------------------------------------
LOADADDR	equ	$8CD4		; SC-55: drum set 2 parameter area
TXOFS		equ	$1C0		; body must fit below this
TABLEOFS	equ	$280		; transmit module must fit below this
ARGOFS		equ	$380		; file table must fit below this
ARGLEN		equ	12		; DRUM MAP NAME, the drum map's last field

;--------------------------------------------------------------------------
; Source kinds, used in the file table and in V_SRC
;--------------------------------------------------------------------------
SRC_MCU		equ	0		; page 0 of the CPU address space
SRC_PCM		equ	1		; via the PCM chip's read port
SRC_END		equ	$FF		; end of the file table

;--------------------------------------------------------------------------
; Table block layout, in order:
;
;   IOWRITE ...     zero or more register pokes, done once before anything
;   IOEND           terminator
;   FILE ...        one per file to dump
;   TABLEEND        terminator
;
; IOWRITE exists so that anything model specific about the *hardware* can live in the table too.
; The SC-55 firmware contains two routines that read the wave ROM with different bank strides (H'418C1 uses ROM number x
; H'100000, H'422F7 uses x H'200000), so bank selection is evidently not fixed; if a model needs a control register set
; before its wave ROM reads the right chip, put it here rather than forking the body.
;--------------------------------------------------------------------------

IOWRITE		macro	addr,value	; write one byte to a page-0 register
		DC.W	addr
		DC.B	value,0
		endm

IOEND		macro
		DC.W	0
		endm

;--------------------------------------------------------------------------
; One file to dump.
;
;   src    SRC_MCU or SRC_PCM
;   addr   24-bit start address in that source
;   len    24-bit length in bytes. The transfer is padded up to a multiple
;          of 112; the receiver truncates using the length in the header.
;   name   file name sent in the file dump header, in quotes
;
; The first eight bytes deliberately match the payload's variable block, so starting a file is a straight 8-byte copy.
; The zero at +5 lands on the packet number, which is what restarts numbering for each file.
;--------------------------------------------------------------------------
FILE		macro	src,addr,len,name
		align	2
		DC.B	src,(addr)>>16
		DC.W	(addr)&$FFFF
		DC.B	((len)>>16)&$FF,0
		DC.W	(len)&$FFFF
		DC.B	name,0
		endm

TABLEEND	macro
		align	2
		DC.B	SRC_END
		endm
