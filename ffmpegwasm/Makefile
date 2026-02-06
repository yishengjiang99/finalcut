SHELL := /bin/bash

IMAGE      ?= ffmpeg-wasm
BUILD_MODE ?= dev          # dev | release
FFMPEG_REF ?= n6.1.1
PORT       ?= 8000
DIST_DIR   ?= dist

DOCKER_BUILDKIT ?= 1
export DOCKER_BUILDKIT

.PHONY: help build dev release clean dist serve test

help:
	@echo "Targets:"
	@echo "  make dev        # fast build (no LTO/closure)"
	@echo "  make release    # smaller wasm (LTO + closure)"
	@echo "  make build      # build with BUILD_MODE=$(BUILD_MODE)"
	@echo "  make serve      # serve dist/ on http://localhost:$(PORT)"
	@echo "  make clean      # remove dist outputs"
	@echo ""
	@echo "Vars:"
	@echo "  BUILD_MODE=dev|release"
	@echo "  FFMPEG_REF=n6.1.1"
	@echo "  IMAGE=ffmpeg-wasm"
	@echo "  DIST_DIR=dist"
	@echo "  PORT=8000"

dist:
	@mkdir -p "$(DIST_DIR)"

# Build artifacts directly into dist/ (no docker create/cp)
build: dist
	@echo "==> Building $(IMAGE) (mode=$(BUILD_MODE), ref=$(FFMPEG_REF))"
	@docker build \
		--build-arg BUILD_MODE="$(BUILD_MODE)" \
		--build-arg FFMPEG_REF="$(FFMPEG_REF)" \
		--output "$(DIST_DIR)" \
		-t "$(IMAGE):$(BUILD_MODE)" \
		.

dev:
	@$(MAKE) build BUILD_MODE=dev

release:
	@$(MAKE) build BUILD_MODE=release

clean:
	@rm -f "$(DIST_DIR)/ffmpeg.js" "$(DIST_DIR)/ffmpeg.wasm"
	@rmdir "$(DIST_DIR)" 2>/dev/null || true

serve:
	@echo "==> Serving dist/ at http://localhost:$(PORT)"
	@cd "$(DIST_DIR)" && python3 -m http.server "$(PORT)"

# Optional convenience: build dev + serve
test:
	@$(MAKE) dev
	@$(MAKE) serve