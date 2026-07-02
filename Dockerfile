# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --include=dev && npm cache clean --force

COPY tsconfig.json tsup.config.ts ./
COPY src ./src

RUN npm run build



# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PORT=8080 \
    WORKSPACE=/workspace \
    SANDBOX_MEMORY_MAX=4G \
    SANDBOX_MEMORY_HIGH=3G \
    SANDBOX_CPU_QUOTA=200% \
    SANDBOX_TASKS_MAX=4096

# Base enxuta — ferramentas essenciais pra o agent operar.
# Stacks específicas (Java, Go, Rust, PHP, etc.) NÃO precisam vir pré-instaladas
# nesta imagem: o agent usa as tools MCP `sys_install` (apt-get) e
# `sys_install_script` (installers oficiais: rustup, deno, bun, dotnet, kotlin,
# dart, swift, julia) que rodam como root FORA do bwrap — decisão consciente,
# documentada em src/mcp/handler.ts:46-51 e src/tools/system.ts. O modelo é
# "sandbox por-usuário/projeto, cliente confiável": o agente instala o que o
# projeto pede e os binários aparecem no PATH dos próximos run_command
# (porque /usr é bindado read-only no bwrap). Mudança de escopo deste
# comentário: 2026-06-16 — antes dizia "removidos do registro", o que era falso.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl wget ca-certificates gnupg unzip xz-utils sudo \
      build-essential pkg-config \
      ripgrep procps bubblewrap \
      iproute2 lsof \
      python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 # bwrap setuid-root: permite criar namespaces sem CAP_SYS_ADMIN no container.
 && chmod u+s /usr/bin/bwrap

# npm tunado pra redes instáveis + menos ruído
RUN npm config set --global fetch-retries 5 \
 && npm config set --global fetch-retry-mintimeout 10000 \
 && npm config set --global fetch-retry-maxtimeout 60000 \
 && npm config set --global prefer-offline true \
 && npm config set --global audit false \
 && npm config set --global fund false \
 && npm config set --global update-notifier false

# User sandbox (uid 1001) — setpriv dropa pra esse no bwrap
RUN useradd --create-home --uid 1001 --shell /bin/bash sandbox \
 && mkdir -p /workspace \
 && chown -R sandbox:sandbox /workspace /home/sandbox

# sandbox-agent (app que expõe MCP)
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# /app root-only: processo filho (uid 1001 via setpriv) não lê código do agent
RUN chmod -R go-rwx /app

EXPOSE 8080
VOLUME ["/workspace"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "dist/server.cjs"]
