# Flash the firmware that firmware/build.sh left in firmware/out (run on Windows).
#
#   .\firmware\flash.ps1               # COM3
#   .\firmware\flash.ps1 -Port COM5
#
# Writes the bootloader, partition table, OTA selector and the app into ota_0.
# NVS (Wi-Fi, pairing keys) and the vendor's data partitions are left alone.
# To go back to the vendor firmware, see backup/README.md.
param([string]$Port = "COM3")

$ErrorActionPreference = "Stop"
$out = Join-Path $PSScriptRoot "out"
foreach ($f in "bootloader.bin", "partition-table.bin", "ota_data_initial.bin", "codetalky.bin") {
    if (-not (Test-Path (Join-Path $out $f))) { throw "missing ${f}: run firmware/build.sh in WSL first" }
}
uvx --from esptool==4.8.1 esptool --chip esp32s3 --port $Port --baud 921600 `
    --before default_reset --after hard_reset `
    write_flash --flash_mode dio --flash_size 16MB --flash_freq 80m `
    0x0 (Join-Path $out "bootloader.bin") `
    0x8000 (Join-Path $out "partition-table.bin") `
    0xd000 (Join-Path $out "ota_data_initial.bin") `
    0x80000 (Join-Path $out "codetalky.bin")
if ($LASTEXITCODE -ne 0) { throw "esptool failed ($LASTEXITCODE)" }
