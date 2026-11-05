# Digestor: run the app locally.
#   make dev   Colima + postgres/chroma/worker in Docker, migrations, then the web app on http://localhost:3000
#   make help  all targets

.DEFAULT_GOAL := help
.PHONY: help dev up wait-db migrate web down stop logs restart-worker test test-worker typecheck

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-15s %s\n", $$1, $$2}'

dev: up migrate web ## Start everything and run the web app (Ctrl-C stops the web app; containers keep running)

up: ## Start Colima (if needed) and postgres, chroma and the worker
	@colima status >/dev/null 2>&1 || colima start --cpu 4 --memory 8
	@[ -d node_modules ] || pnpm install
	docker compose up -d
	@$(MAKE) --no-print-directory wait-db

wait-db:
	@printf "Waiting for postgres"; \
	for i in $$(seq 1 60); do \
	  docker compose exec -T postgres pg_isready -q && { echo " ready"; exit 0; }; \
	  printf "."; sleep 2; \
	done; echo " timed out"; exit 1

migrate: ## Apply database migrations (idempotent)
	pnpm db:migrate

web: ## Run the Next.js dev server in the foreground
	pnpm --filter @digestor/web dev

down: ## Stop the containers (Colima keeps running)
	docker compose down

stop: down ## Stop the containers and Colima
	colima stop

logs: ## Follow the worker logs
	docker compose logs -f worker

restart-worker: ## Restart the worker (use `docker compose up -d worker` after .env changes)
	docker compose restart worker

test: ## Host-safe tests (core, web)
	pnpm test

test-worker: ## Worker tests (in the container)
	pnpm test:worker

typecheck: ## Typecheck all packages
	pnpm typecheck
