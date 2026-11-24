# 애드온 로컬 빌드용: 빌드에 필요한 소스만 haos\zigbee2matter\app\ 로 복사한다.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root 'haos\zigbee2matter\app'
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force (Join-Path $dest 'data') | Out-Null
Push-Location $root
try {
    foreach ($f in 'package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','tsconfig.types.json','index.js','cli.js','LICENSE','.npmrc') {
        if (Test-Path $f) { Copy-Item $f $dest }
    }
    Copy-Item -Recurse lib (Join-Path $dest 'lib')
    Copy-Item 'data\configuration.example.yaml' (Join-Path $dest 'data')
} finally { Pop-Location }
Write-Host "Prepared $dest. Copy haos\zigbee2matter to /addons/zigbee2matter on HAOS."
