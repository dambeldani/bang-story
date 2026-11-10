# Pintasan untuk menjalankan Google Flow (flow-mcp) dan menarik pembaruan dari repo asli.
# Lihat `make help`. Catatan lengkap git: docs/git-fork.md

# flow-mcp ada di folder sebelah proyek ini; ganti lewat `make flow FLOW_DIR=/path/lain`
FLOW_DIR ?= $(abspath $(CURDIR)/../flow-mcp)
BRANCH   ?= main

.DEFAULT_GOAL := help
.PHONY: help dev flow flow-login flow-build flow-status flow-update sync-check sync remotes

help: ## Tampilkan daftar perintah
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-14s %s\n", $$1, $$2}'

dev: ## Jalankan Bang Story (mode pengembangan)
	npm run dev

# ---- Google Flow ----------------------------------------------------------------

flow-login: ## Login Google di Chrome flow-mcp (sekali saja, atau saat sesi habis)
	cd "$(FLOW_DIR)" && npm run login

flow: ## Jalankan flow-mcp studio; biarkan terbuka selama Bang Story memakai Flow
	@test -d "$(FLOW_DIR)" || { echo "flow-mcp tidak ada di $(FLOW_DIR). Pakai: make flow FLOW_DIR=/path"; exit 1; }
	cd "$(FLOW_DIR)" && npm run studio

flow-build: ## Build ulang flow-mcp (wajib setelah mengubah kodenya, lalu jalankan ulang make flow)
	cd "$(FLOW_DIR)" && npm run build

flow-status: ## Cek apakah flow-mcp sedang berjalan (tanpa menampilkan token)
	@if [ -f "$$HOME/.flow-mcp/token" ]; then \
	  curl -s -o /dev/null -w "API flow-mcp (127.0.0.1:8787): HTTP %{http_code}\n" \
	    -H "Authorization: Bearer $$(cat $$HOME/.flow-mcp/token)" http://127.0.0.1:8787/ || echo "Tidak berjalan. Jalankan: make flow"; \
	else echo "Token belum ada. Jalankan: make flow-login lalu make flow"; fi

flow-update: ## Tarik pembaruan flow-mcp dari origin-nya lalu build ulang
	cd "$(FLOW_DIR)" && git fetch --all --prune && git status -sb && npm install && npm run build

# ---- Git: fork dan repo asli ----------------------------------------------------

remotes: ## Tampilkan remote (origin harus forkmu, upstream repo asli)
	git remote -v

sync-check: ## Lihat apa yang baru di repo asli (hanya membaca)
	git fetch upstream
	@echo "--- Commit baru di upstream/$(BRANCH) yang belum ada di sini ---"
	@git log HEAD..upstream/$(BRANCH) --oneline || true
	@echo "--- Selesai (kosong = tidak ada pembaruan) ---"

sync: ## Gabungkan upstream/main ke branch ini (wajib commit dulu), lalu cek typecheck
	@if [ -n "$$(git status --porcelain --untracked-files=no)" ]; then \
	  echo "Ada perubahan yang belum di-commit. Commit dulu, baru make sync."; exit 1; fi
	git fetch upstream
	git merge upstream/$(BRANCH)
	npm run typecheck
	@echo "Selesai. Kalau sudah yakin: git push origin $(BRANCH)"
