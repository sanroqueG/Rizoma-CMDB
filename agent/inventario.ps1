<#
.SYNOPSIS
  Agente de inventario do Rizoma para Windows. Recolhe hardware/SO e envia para POST /api/v1/ingest.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File inventario.ps1 -Servidor https://cmdb.empresa.pt -Token cmdb_xxx
  powershell -ExecutionPolicy Bypass -File inventario.ps1 -Servidor https://cmdb.empresa.pt -Token cmdb_xxx -Local "Sede Lisboa"
  powershell -ExecutionPolicy Bypass -File inventario.ps1 -Teste   # mostra o JSON sem enviar

.NOTES
  Pode ser distribuido por GPO / Intune / RMM e agendado (ex.: diariamente) como tarefa agendada.
  Compativel com Windows PowerShell 5.1 e PowerShell 7+.
#>
param(
  [string]$Servidor,
  [string]$Token,
  [string]$Local,
  [switch]$Teste
)
$ErrorActionPreference = 'Stop'

function Clean([string]$v) {
  if ([string]::IsNullOrWhiteSpace($v)) { return $null }
  $v = $v.Trim()
  if ($v -match 'O\.E\.M|Default string|System Serial Number|^0+$|^F{8}-F{4}') { return $null }
  return $v
}

$cs      = Get-CimInstance Win32_ComputerSystem
$bios    = Get-CimInstance Win32_BIOS
$os      = Get-CimInstance Win32_OperatingSystem
$cpu     = Get-CimInstance Win32_Processor | Select-Object -First 1
$prod    = Get-CimInstance Win32_ComputerSystemProduct
$chassis = (Get-CimInstance Win32_SystemEnclosure).ChassisTypes
$disk    = (Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Measure-Object -Property Size -Sum).Sum
$ip      = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
            Sort-Object -Property InterfaceMetric | Select-Object -First 1).IPAddress

# Tipo de ativo (nomes iguais aos tipos do Rizoma; acentos via [char] para funcionar em PS 5.1)
$portatil = "Port$([char]0xE1)til"
$vm       = "M$([char]0xE1)quina virtual"
if ($cs.Model -match 'Virtual|VMware|KVM|HVM|Xen') { $type = $vm }
elseif ($os.ProductType -ne 1) { $type = 'Servidor' }
elseif ($chassis | Where-Object { $_ -in 8, 9, 10, 11, 12, 14, 18, 21, 30, 31, 32 }) { $type = $portatil }
else { $type = 'Posto de trabalho' }

$asset = [ordered]@{
  external_id   = Clean $prod.UUID
  hostname      = $env:COMPUTERNAME
  type          = $type
  serial_number = Clean $bios.SerialNumber
  manufacturer  = Clean $cs.Manufacturer
  model         = Clean $cs.Model
  os            = "$($os.Caption) ($($os.Version))".Trim()
  ip_address    = $ip
  attributes    = [ordered]@{
    cpu             = if ($cpu) { $cpu.Name.Trim() } else { $null }
    ram_gb          = [math]::Round($cs.TotalPhysicalMemory / 1GB)
    disco_gb        = if ($disk) { [math]::Round($disk / 1GB) } else { $null }
    dominio         = $cs.Domain
    utilizador      = $cs.UserName
    arquitetura     = $os.OSArchitecture
    ultimo_arranque = $os.LastBootUpTime.ToString('s')
    bios            = Clean $bios.SMBIOSBIOSVersion
  }
}
if ($Local) { $asset.site = $Local }

$json = $asset | ConvertTo-Json -Depth 4
if ($Teste) { $json; return }
if (-not $Servidor -or -not $Token) { throw 'Indique -Servidor e -Token (ou use -Teste).' }

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$resp = Invoke-RestMethod -Method Post -Uri ("{0}/api/v1/ingest" -f $Servidor.TrimEnd('/')) `
  -Headers @{ Authorization = "Bearer $Token" } `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes($json))
$resp.results | ForEach-Object { "Ativo #$($_.id): $($_.action)" }
