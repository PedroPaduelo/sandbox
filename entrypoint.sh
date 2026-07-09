#!/bin/bash
# ============================================
# Entrypoint — inicia VPN FortiClient antes
# do app principal. Roda como root.
# ============================================
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${YELLOW}[VPN]${NC} $1"; }
ok()  { echo -e "${GREEN}[VPN]${NC} $1"; }
err() { echo -e "${RED}[VPN]${NC} $1"; }

# ── Iniciar VPN ────────────────────────────────────────────────────────────────
if [ -f /etc/fortivpn.conf ]; then
    log "Iniciando VPN FortiClient..."
    openfortivpn -c /etc/fortivpn.conf 2>/tmp/vpn.log &
    VPN_PID=$!

    # Esperar túnel ficar pronto (máx 30s)
    RETRIES=0
    MAX_RETRIES=15
    while [ $RETRIES -lt $MAX_RETRIES ]; do
        if ip addr show ppp0 >/dev/null 2>&1; then
            VPN_IP=$(ip addr show ppp0 | grep "inet " | awk '{print $2}' | cut -d'/' -f1)
            ok "VPN conectada! Interface ppp0 — IP: $VPN_IP"
            break
        fi
        RETRIES=$((RETRIES + 1))
        sleep 2
    done

    if [ $RETRIES -eq $MAX_RETRIES ]; then
        err "VPN não conectou em 30s. Verificando log:"
        cat /tmp/vpn.log 2>/dev/null | tail -10
        err "Continuando sem VPN..."
    fi

    # Verificar bancos de dados
    log "Testando conectividade com bancos..."
    if timeout 3 bash -c 'echo > /dev/tcp/172.19.1.77/1433' 2>/dev/null; then
        ok "SQL Server (172.19.1.77:1433) acessível"
    else
        err "SQL Server (172.19.1.77:1433) inacessível"
    fi
    if timeout 3 bash -c 'echo > /dev/tcp/172.19.1.78/3306' 2>/dev/null; then
        ok "MySQL (172.19.1.78:3306) acessível"
    else
        err "MySQL (172.19.1.78:3306) inacessível"
    fi
else
    err "Arquivo /etc/fortivpn.conf não encontrado. VPN não iniciada."
fi

# ── Executar comando principal (app) ───────────────────────────────────────────
log "Iniciando aplicação..."
exec "$@"
