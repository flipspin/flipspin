.DEFAULT_GOAL := help
.PHONY: help start stop dev dev-reset dev-check backend frontend tauri app \
        install install-frontend install-backend \
        lint lint-backend test test-unit test-integration test-fast test-rust test-worker \
        build build-frontend build-backend dist-mac dist-win clean qa-install

# Repo-root virtualenv used by the backend
VENV   := .venv
ifeq ($(OS),Windows_NT)
PYTHON := $(VENV)/Scripts/python.exe
else
PYTHON := $(VENV)/bin/python
endif

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

## ---- Run (dev) ----
dev: ## Run the isolated backend and desktop together
	$(PYTHON) scripts/dev.py start

start: dev ## Alias for `dev`

stop: ## Stop the backend and desktop started by make dev
	$(PYTHON) scripts/dev.py stop

dev-reset: ## Stop dev and delete its isolated data
	$(PYTHON) scripts/dev.py reset

dev-check: ## Start and seed a dev backend; require an empty temporary HOME
	$(PYTHON) scripts/dev.py check

backend: ## Run the FastAPI backend on :8000 (start this before Tauri)
	cd backend && KROBI_LOG_LEVEL=$${KROBI_LOG_LEVEL:-DEBUG} $(abspath $(PYTHON)) -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

frontend: ## Run the Vite dev server on :5173
	npm run dev

tauri: ## Run the Tauri shell and its Vite dev server (backend must be up)
	npm start

app: ## Alias for the Tauri desktop app (backend must already be up)
	npm start

## ---- Install ----
# Use the supported Python baseline; a bare `python3` may be newer.
# Override with PYTHON312=...
PYTHON312 ?= $(shell command -v python3.12 2>/dev/null || echo python3.12)

install: ## Install toolchain (if mise is available) + backend and frontend deps
	@if command -v mise >/dev/null 2>&1; then \
		mise install && mise exec -- $(MAKE) install-backend install-frontend; \
	else \
		$(MAKE) install-backend install-frontend; \
	fi

install-frontend: ## npm install
	npm install

install-backend: ## Create venv and install backend requirements
	test -d $(VENV) || $(PYTHON312) -m venv $(VENV)
	$(PYTHON) -m pip install -r backend/requirements.txt

## ---- Lint & test ----
lint: lint-backend ## Area guides, Python imports, Ruff, ESLint, TypeScript, and Rust checks
	node scripts/check-areas.mjs
	npm run lint
	npm run typecheck
	cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

lint-backend: ## Python lint and import direction checks
	cd backend && $(abspath $(PYTHON)) -m ruff check .
	cd backend && $(abspath $(VENV))/bin/lint-imports

test: ## Backend test suite with coverage
	cd backend && $(abspath $(PYTHON)) -m pytest

test-unit: ## Unit tests only
	cd backend && $(abspath $(PYTHON)) -m pytest tests/unit/

test-integration: ## Integration tests only
	cd backend && $(abspath $(PYTHON)) -m pytest tests/integration/

test-fast: ## Skip slow-marked tests
	cd backend && $(abspath $(PYTHON)) -m pytest -m "not slow"

test-rust: ## Desktop shell (Rust) unit tests
	cargo test --manifest-path src-tauri/Cargo.toml

# Model libraries load lazily, so pure helper tests need only pytest + numpy.
# Use the backend venv instead of installing the full engine for tests.
test-worker: ## Lyrics/stems worker tests (helper/tests)
	cd helper && $(abspath $(PYTHON)) -m pytest tests

qa-install: ## Test clean install, setup log and root songs (QA_PLATFORM optional)
	QA_PLATFORM="$(QA_PLATFORM)" QA_BUILDER="$(QA_BUILDER)" python3 scripts/qa/install.py

## ---- Build & package ----
build: build-frontend ## Build the frontend bundle (Vite -> build/)

build-frontend: ## Vite build -> build/
	npm run build:frontend

build-backend: ## PyInstaller backend binary
	npm run build:backend

dist-mac: ## Full macOS dmg
	npm run dist:mac

dist-win: ## Full Windows installer
	npm run dist:win

clean: ## Remove build artifacts
	rm -rf build build-temp
