#!/bin/sh
# Agente de inventário do Rizoma para Linux e macOS.
# Recolhe hardware/SO e envia para POST /api/v1/ingest.
#
# Uso:
#   sh inventario.sh -s https://cmdb.empresa.pt -t cmdb_xxx [-l "Sede Lisboa"]
#   sh inventario.sh --teste                     # mostra o JSON sem enviar
#   curl -fsSL https://cmdb.empresa.pt/agent/inventario.sh | sh -s -- -s https://cmdb.empresa.pt -t cmdb_xxx
#
# Para inventário diário (cron):  0 9 * * * /usr/local/bin/inventario.sh -s URL -t TOKEN >/dev/null 2>&1
# Em Linux, correr como root permite ler o nº de série e o UUID do hardware (/sys/class/dmi).
set -u

SERVIDOR=""
TOKEN=""
LOCAL=""
TESTE=0

usage() { sed -n '2,12p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    -s|--servidor) SERVIDOR="${2:-}"; shift 2 ;;
    -t|--token)    TOKEN="${2:-}"; shift 2 ;;
    -l|--local)    LOCAL="${2:-}"; shift 2 ;;
    --teste)       TESTE=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- utilitários
# String JSON (ou null se vazia). Remove caracteres de controlo e escapa \ e ".
json_str() {
  if [ -z "${1:-}" ]; then printf 'null'; return; fi
  printf '"%s"' "$(printf '%s' "$1" | tr '\t\r\n' '   ' | tr -d '\000-\010\013\014\016-\037' \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}
json_num() {
  case "${1:-}" in ''|*[!0-9]*) printf 'null' ;; *) printf '%s' "$1" ;; esac
}
trim() { printf '%s' "${1:-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }
clean() {
  v=$(trim "${1:-}")
  case "$v" in
    *O.E.M*|*"Default string"*|*"System Serial Number"*|*"Not Specified"*|*"To Be Filled"*|None|0|00000000-0000-0000-0000-000000000000|FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF) v="" ;;
  esac
  printf '%s' "$v"
}
read_file() { [ -r "$1" ] && clean "$(cat "$1" 2>/dev/null | head -n 1)"; }

HOSTNAME_V=""; SERIAL=""; UUID=""; MANUF=""; MODEL=""; OSNAME=""; IP=""; CPU=""; RAM_GB=""; DISK_GB=""
DOMINIO=""; UTILIZADOR=""; ARQ=$(uname -m 2>/dev/null); ARRANQUE=""; TIPO="Servidor"

# ---------------------------------------------------------------- recolha
case "$(uname -s)" in
  Linux)
    HOSTNAME_V=$(hostname 2>/dev/null || uname -n)
    DMI=/sys/class/dmi/id
    SERIAL=$(read_file $DMI/product_serial)
    UUID=$(read_file $DMI/product_uuid)
    [ -z "$UUID" ] && UUID=$(read_file /etc/machine-id)
    MANUF=$(read_file $DMI/sys_vendor)
    MODEL=$(read_file $DMI/product_name)
    CHASSIS=$(read_file $DMI/chassis_type)
    if [ -r /etc/os-release ]; then
      OSNAME=$(. /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-${NAME:-Linux}}")
    else
      OSNAME="Linux"
    fi
    OSNAME="$OSNAME ($(uname -r))"
    CPU=$(awk -F: '/^model name/ {print $2; exit}' /proc/cpuinfo 2>/dev/null)
    [ -z "$CPU" ] && CPU=$(lscpu 2>/dev/null | awk -F: '/Model name/ {print $2; exit}')
    CPU=$(trim "$CPU")
    RAM_KB=$(awk '/^MemTotal/ {print $2}' /proc/meminfo 2>/dev/null)
    [ -n "$RAM_KB" ] && RAM_GB=$(( (RAM_KB + 524288) / 1048576 ))
    DISK_GB=$(df -Pk 2>/dev/null | awk 'NR>1 && $1 ~ /^\/dev\// && $1 !~ /loop/ {s+=$2} END {if (s>0) printf "%d", s/1048576}')
    IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="src") {print $(i+1); exit}}')
    [ -z "$IP" ] && IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    DOMINIO=$(hostname -d 2>/dev/null)
    UTILIZADOR=$(who 2>/dev/null | awk 'NR==1 {print $1}')
    ARRANQUE=$(uptime -s 2>/dev/null)
    VIRT=$(systemd-detect-virt 2>/dev/null)
    [ "$VIRT" = "none" ] && VIRT=""
    if [ -n "$VIRT" ]; then
      TIPO="Máquina virtual"
    else
      case "${CHASSIS:-}" in
        8|9|10|11|12|14|18|21|30|31|32) TIPO="Portátil" ;;
        3|4|5|6|7|13|15|16|24|35|36)    TIPO="Posto de trabalho" ;;
        *)                              TIPO="Servidor" ;;
      esac
    fi
    ;;
  Darwin)
    HW=$(system_profiler SPHardwareDataType 2>/dev/null)
    hw() { printf '%s\n' "$HW" | awk -F': ' -v k="$1" 'index($1, k) {print $2; exit}'; }
    HOSTNAME_V=$(scutil --get ComputerName 2>/dev/null || hostname -s)
    SERIAL=$(clean "$(hw 'Serial Number')")
    UUID=$(clean "$(hw 'Hardware UUID')")
    MANUF="Apple"
    MODEL=$(hw 'Model Name')
    MODEL_ID=$(hw 'Model Identifier')
    [ -n "$MODEL_ID" ] && MODEL="$MODEL ($MODEL_ID)"
    CPU=$(hw 'Chip')
    [ -z "$CPU" ] && CPU=$(hw 'Processor Name')
    RAM_GB=$(hw 'Memory' | awk '$2=="GB" {print $1} $2=="TB" {print $1*1024}')
    OSNAME="$(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null) ($(sw_vers -buildVersion 2>/dev/null))"
    IFACE=$(route -n get default 2>/dev/null | awk '/interface:/ {print $2}')
    [ -n "$IFACE" ] && IP=$(ipconfig getifaddr "$IFACE" 2>/dev/null)
    DISK_GB=$(df -k / 2>/dev/null | awk 'NR==2 {printf "%d", $2/1048576}')
    UTILIZADOR=$(stat -f '%Su' /dev/console 2>/dev/null)
    case "$MODEL_ID" in
      VirtualMac*) TIPO="Máquina virtual" ;;
      *) case "$MODEL" in *Book*) TIPO="Portátil" ;; *) TIPO="Posto de trabalho" ;; esac ;;
    esac
    ;;
  *)
    echo "Aviso: sistema $(uname -s) não suportado oficialmente; a enviar dados básicos." >&2
    HOSTNAME_V=$(hostname 2>/dev/null || uname -n)
    OSNAME="$(uname -s) $(uname -r)"
    ;;
esac

JSON=$(cat <<EOF
{
  "external_id": $(json_str "$UUID"),
  "hostname": $(json_str "$HOSTNAME_V"),
  "type": $(json_str "$TIPO"),
  "site": $(json_str "$LOCAL"),
  "serial_number": $(json_str "$SERIAL"),
  "manufacturer": $(json_str "$MANUF"),
  "model": $(json_str "$MODEL"),
  "os": $(json_str "$OSNAME"),
  "ip_address": $(json_str "$IP"),
  "attributes": {
    "cpu": $(json_str "$CPU"),
    "ram_gb": $(json_num "$RAM_GB"),
    "disco_gb": $(json_num "$DISK_GB"),
    "dominio": $(json_str "$DOMINIO"),
    "utilizador": $(json_str "$UTILIZADOR"),
    "arquitetura": $(json_str "$ARQ"),
    "ultimo_arranque": $(json_str "$ARRANQUE")
  }
}
EOF
)

if [ "$TESTE" = 1 ]; then printf '%s\n' "$JSON"; exit 0; fi
if [ -z "$SERVIDOR" ] || [ -z "$TOKEN" ]; then
  echo "Indique -s <servidor> e -t <token> (ou use --teste). Ajuda: -h" >&2
  exit 2
fi

URL="${SERVIDOR%/}/api/v1/ingest"
if command -v curl >/dev/null 2>&1; then
  RESP=$(printf '%s' "$JSON" | curl -fsS -X POST -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json; charset=utf-8' --data-binary @- "$URL") || { echo "Erro ao enviar para $URL" >&2; exit 1; }
elif command -v wget >/dev/null 2>&1; then
  RESP=$(wget -qO- --header="Authorization: Bearer $TOKEN" --header='Content-Type: application/json; charset=utf-8' \
    --post-data="$JSON" "$URL") || { echo "Erro ao enviar para $URL" >&2; exit 1; }
else
  echo "É necessário curl ou wget." >&2
  exit 1
fi
printf '%s\n' "$RESP" | sed -e 's/.*"id":\([0-9]*\),"action":"\([a-z]*\)".*/Ativo #\1: \2/'
