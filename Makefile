# sc-mcu-wave-romdumper
#
#   src/NN/*.asm  --asl-->  build/NN/*.p  --p2bin-->  build/NN/*.bin  --mksyx-->  syx/*
#
# The two directories are ways of working, not model numbers.
#
#   src/55  the synth puts the dump on MIDI Out itself, as a MIDI File Dump.
#           The RA-30, XP-10 and PMA-5 are in here too
#   src/88  the dumper leaves the dump in RAM and the host reads it back
#           with bulk dump requests
#
# src/55/dumper_*.asm are the dumpers (body plus one transmit module each).
# src/55/[mcu-]wave-*.asm and src/55/probe.asm are the file tables. The name
# says what a table dumps, so the mcu- ones start with the MCU internal ROM.
#
# Needs The Macro Assembler AS (asl and p2bin) and Node.
# There is no Python and there are no npm packages.
#
#   make            build syx/ from src/
#   make check      re-run the build and fail if syx/ is out of date
#   make check-tools  report which tools were found
#   make clean      remove build/
#   make distclean  also remove the generated syx/

ASL       ?= asl
P2BIN     ?= p2bin
NODE      ?= node

CPU        = HD6475328
ASFLAGS    = -cpu $(CPU) -q
# p2bin defaults to the range 0-$7fff and the dumper lives at H'8CD4, so
# without -r the output would be empty.  '$-$' means "whatever was used".
P2BINFLAGS = -r '$$-$$' -l 0

SRC55 := $(wildcard src/55/dumper_*.asm) $(wildcard src/55/*wave-*.asm) src/55/probe.asm
SRC88 := $(wildcard src/88/dumper_*.asm)
INC55 := $(wildcard src/55/*.inc)
INC88 := $(wildcard src/88/*.inc)
BIN   := $(patsubst src/55/%.asm,build/55/%.bin,$(SRC55)) $(patsubst src/88/%.asm,build/88/%.bin,$(SRC88))
STAMP := syx/models.json

.PHONY: all check check-tools clean distclean
.PRECIOUS: build/55/%.p build/88/%.p

all: $(STAMP)

build/55 build/88:
	@mkdir -p $@

build/55/%.p: src/55/%.asm $(INC55) | build/55
	$(ASL) $(ASFLAGS) -i src/55 -o $@ $<

build/88/%.p: src/88/%.asm $(INC88) | build/88
	$(ASL) $(ASFLAGS) -i src/88 -o $@ $<

build/%.bin: build/%.p
	$(P2BIN) $< $@ $(P2BINFLAGS)

$(STAMP): $(BIN) tools/mksyx_55.js tools/mksyx_88.js tools/bulk_load.js tools/file_table_55.js \
          tools/smf_write.js src/55/dumper.inc tools/catalogue.json \
          lib/format.js lib/sysex.js lib/wave_plan_88.js lib/bulk_dump.js lib/gs_message.js
	@rm -f syx/*.syx syx/*.mid
	$(NODE) tools/mksyx_55.js
	$(NODE) tools/mksyx_88.js

# Rebuild into a scratch directory and compare, so a stale syx/ is caught.
check: $(BIN)
	@rm -rf build/_check && mkdir -p build/_check
	@$(NODE) tools/mksyx_55.js --out build/_check >/dev/null
	@$(NODE) tools/mksyx_88.js --out build/_check >/dev/null
	@if diff -r -q syx build/_check >/dev/null 2>&1; then \
		echo "syx/ is up to date"; \
	else \
		echo "syx/ is stale - run make"; diff -r -q syx build/_check; exit 1; \
	fi

check-tools:
	@printf '%-8s ' asl;   $(ASL) -h 2>&1 | head -1 || echo 'NOT FOUND'
	@printf '%-8s ' p2bin; $(P2BIN) 2>&1 | head -1 || echo 'NOT FOUND'
	@printf '%-8s ' node;  $(NODE) --version 2>/dev/null || echo 'NOT FOUND'

clean:
	rm -rf build

distclean: clean
	rm -f syx/*.syx syx/*.mid $(STAMP)
