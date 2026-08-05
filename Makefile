DOCKER_COMPOSE := docker compose -f deploy/docker-compose.yml
HELM_CHART     := deploy/helm/async-long-request-proxy
HELM_RELEASE   := async-proxy
HELM_NAMESPACE := default
KIND_CLUSTER   := dev
IMAGE_NAME     := async-long-request-proxy
IMAGE_TAG      := local

.DEFAULT_GOAL := help
.PHONY: help \
        up down restart build logs ps \
        migrate exec-api exec-worker \
        kind-up kind-down kind-load \
        k8s-deploy k8s-redeploy k8s-logs k8s-debug \
        helm-deps helm-lint helm-install helm-upgrade helm-uninstall helm-status helm-template \
        env-check \
        test test-e2e


CLR_HEADER := \033[33m
CLR_TARGET := \033[36m
CLR_PARAM  := \033[33m
CLR_RESET  := \033[0m

help:
	@printf "\nUsage: make $(CLR_TARGET)<target>$(CLR_RESET)\n\n"
	@printf "  $(CLR_HEADER)Docker Compose$(CLR_RESET)\n"
	@printf "    $(CLR_TARGET)up$(CLR_RESET)             Start all services (detached)\n"
	@printf "    $(CLR_TARGET)down$(CLR_RESET)           Stop and remove containers\n"
	@printf "    $(CLR_TARGET)restart$(CLR_RESET)        down + up\n"
	@printf "    $(CLR_TARGET)build$(CLR_RESET)          Build / rebuild docker images\n"
	@printf "    $(CLR_TARGET)logs$(CLR_RESET)           Follow logs (Ctrl+C to exit)\n"
	@printf "    $(CLR_TARGET)ps$(CLR_RESET)             Show running containers\n"
	@printf "    $(CLR_TARGET)migrate$(CLR_RESET)        Run DB migrations via dedicated migrate service\n"
	@printf "    $(CLR_TARGET)exec-api$(CLR_RESET)       Open a shell inside the running api container\n"
	@printf "    $(CLR_TARGET)exec-worker$(CLR_RESET)    Open a shell inside the running worker container\n"
	@printf "\n  $(CLR_HEADER)Kind (local k8s cluster)$(CLR_RESET)\n"
	@printf "    $(CLR_TARGET)kind-up$(CLR_RESET)        Create the local kind cluster\n"
	@printf "    $(CLR_TARGET)kind-down$(CLR_RESET)      Delete the local kind cluster\n"
	@printf "    $(CLR_TARGET)kind-load$(CLR_RESET)      Build image and side-load it into kind (no registry)\n"
	@printf "\n  $(CLR_HEADER)K8s local workflow$(CLR_RESET)\n"
	@printf "    $(CLR_TARGET)k8s-deploy$(CLR_RESET)     Full deploy: kind-load + helm-install\n"
	@printf "    $(CLR_TARGET)k8s-redeploy$(CLR_RESET)   Rebuild image, reload into kind, upgrade release\n"
	@printf "    $(CLR_TARGET)k8s-logs$(CLR_RESET)       Tail logs for a component: make k8s-logs $(CLR_PARAM)C=api$(CLR_RESET)\n"
	@printf "    $(CLR_TARGET)k8s-debug$(CLR_RESET)      Exec into a pod: make k8s-debug $(CLR_PARAM)C=worker$(CLR_RESET)\n"
	@printf "\n  $(CLR_HEADER)Helm$(CLR_RESET)\n"
	@printf "    $(CLR_TARGET)helm-deps$(CLR_RESET)      Update chart dependencies (bitnami postgresql/redis)\n"
	@printf "    $(CLR_TARGET)helm-lint$(CLR_RESET)      Lint the chart\n"
	@printf "    $(CLR_TARGET)helm-install$(CLR_RESET)   Install the release (uses values-local.yaml)\n"
	@printf "    $(CLR_TARGET)helm-upgrade$(CLR_RESET)   Upgrade an existing release\n"
	@printf "    $(CLR_TARGET)helm-uninstall$(CLR_RESET) Remove the release from the cluster\n"
	@printf "    $(CLR_TARGET)helm-status$(CLR_RESET)    Show release status and resources\n"
	@printf "    $(CLR_TARGET)helm-template$(CLR_RESET)  Render templates to stdout for inspection\n"
	@printf "\n  $(CLR_HEADER)Other$(CLR_RESET)\n"
	@printf "    $(CLR_TARGET)env-check$(CLR_RESET)      Ensure required .env files exist (copies from .example)\n"
	@printf "    $(CLR_TARGET)test$(CLR_RESET)           Run unit tests\n"
	@printf "    $(CLR_TARGET)test-e2e$(CLR_RESET)       Run end-to-end tests\n\n"


env-check:
	@[ -f .env ] || { cp .env.example .env 2>/dev/null && echo "Created .env from .env.example" || echo "WARNING: .env not found and no .env.example to copy from"; }
	@[ -f deploy/.env.infra ] || { cp deploy/.env.infra.example deploy/.env.infra && echo "Created deploy/.env.infra from example"; }

up: env-check
	$(DOCKER_COMPOSE) up -d

down:
	$(DOCKER_COMPOSE) down

restart: down up

build:
	$(DOCKER_COMPOSE) build

logs:
	$(DOCKER_COMPOSE) logs -f

ps:
	$(DOCKER_COMPOSE) ps

migrate: env-check
	$(DOCKER_COMPOSE) run --rm migrate

# Drops you into a live shell; the service must already be running via `make up`
exec-api:
	$(DOCKER_COMPOSE) exec api sh

exec-worker:
	$(DOCKER_COMPOSE) exec worker sh


# Builds the image locally and side-loads it into kind - no registry required
kind-up:
	kind create cluster --name $(KIND_CLUSTER)

kind-down:
	kind delete cluster --name $(KIND_CLUSTER)

kind-load: build
	kind load docker-image $(IMAGE_NAME):$(IMAGE_TAG) --name $(KIND_CLUSTER)

# Full local k8s deploy: build → load into kind → helm install
k8s-deploy: kind-load helm-install

# Iterate on local k8s: rebuild → reload image → helm upgrade (no chart re-init)
k8s-redeploy: kind-load helm-upgrade

# Tail logs for a specific component. Usage: make k8s-logs C=api
C ?= api
k8s-logs:
	kubectl logs -n $(HELM_NAMESPACE) -l app.kubernetes.io/component=$(C) --all-containers -f

# Exec into the first pod of a component. Usage: make k8s-debug C=worker
k8s-debug:
	kubectl exec -n $(HELM_NAMESPACE) -it \
		$$(kubectl get pod -n $(HELM_NAMESPACE) -l app.kubernetes.io/component=$(C) -o jsonpath='{.items[0].metadata.name}') \
		-- sh


helm-deps:
	helm dependency update $(HELM_CHART)

helm-lint:
	helm lint $(HELM_CHART) -f $(HELM_CHART)/values-local.yaml

helm-install: helm-deps
	helm install $(HELM_RELEASE) $(HELM_CHART) \
		--namespace $(HELM_NAMESPACE) \
		--create-namespace \
		-f $(HELM_CHART)/values-local.yaml \
		--wait

helm-upgrade:
	helm upgrade $(HELM_RELEASE) $(HELM_CHART) \
		--namespace $(HELM_NAMESPACE) \
		-f $(HELM_CHART)/values-local.yaml \
		--wait

helm-uninstall:
	helm uninstall $(HELM_RELEASE) --namespace $(HELM_NAMESPACE)

helm-status:
	helm status $(HELM_RELEASE) --namespace $(HELM_NAMESPACE)
	@echo ""
	kubectl get all -n $(HELM_NAMESPACE) -l app.kubernetes.io/instance=$(HELM_RELEASE)

helm-template:
	helm template $(HELM_RELEASE) $(HELM_CHART) \
		-f $(HELM_CHART)/values-local.yaml


test:
	pnpm test

test-e2e:
	pnpm test:e2e
