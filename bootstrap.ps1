param(
  [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectDir = $PSScriptRoot
$ManifestPath = Join-Path $ProjectDir "scripts\runtime-manifest.env"

function Read-RuntimeManifest {
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "Runtime manifest is missing: $ManifestPath"
  }

  $values = @{}
  foreach ($rawLine in Get-Content -LiteralPath $ManifestPath) {
    $line = $rawLine.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith("#")) {
      continue
    }
    $parts = $line.Split(@("="), 2, [System.StringSplitOptions]::None)
    if ($parts.Count -ne 2) {
      throw "Invalid runtime manifest line: $line"
    }
    $values[$parts[0]] = $parts[1]
  }
  return $values
}

function Test-NodeSupported([string]$NodePath, [string]$MinimumVersion) {
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    return $false
  }
  $rawVersion = & $NodePath --version 2>$null
  if ($LASTEXITCODE -ne 0) {
    return $false
  }
  try {
    $current = [version]$rawVersion.Trim().TrimStart("v")
    $minimum = [version]$MinimumVersion
    return $current -ge $minimum
  } catch {
    return $false
  }
}

function Test-LocalNodeReady(
  [string]$NodePath,
  [string]$RuntimeDir,
  [string]$ExpectedVersion
) {
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    return $false
  }
  if (-not (Test-Path -LiteralPath (Join-Path $RuntimeDir "npm.cmd") -PathType Leaf)) {
    return $false
  }
  if (-not (Test-Path -LiteralPath (Join-Path $RuntimeDir "npx.cmd") -PathType Leaf)) {
    return $false
  }
  $installedVersion = & $NodePath -p "process.versions.node" 2>$null
  return $LASTEXITCODE -eq 0 -and $installedVersion -eq $ExpectedVersion
}

function Get-TargetArchitecture {
  $rawArchitecture = if ($env:PROCESSOR_ARCHITEW6432) {
    $env:PROCESSOR_ARCHITEW6432
  } else {
    $env:PROCESSOR_ARCHITECTURE
  }
  switch ($rawArchitecture.ToUpperInvariant()) {
    "AMD64" { return "x64" }
    "ARM64" { return "arm64" }
    default { throw "Unsupported CPU architecture: $rawArchitecture" }
  }
}

function Install-LocalNode(
  [hashtable]$Manifest,
  [string]$Architecture,
  [string]$Archive,
  [string]$ExpectedSha256,
  [string]$CacheRoot,
  [string]$RuntimeDir,
  [string]$NodePath
) {
  New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
  $lockPath = Join-Path $CacheRoot ".node-v$($Manifest.NODE_VERSION)-win-$Architecture.lock"
  $lockStream = $null
  for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
    try {
      $lockStream = [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
      )
      break
    } catch [System.IO.IOException] {
      if (Test-LocalNodeReady $NodePath $RuntimeDir $Manifest.NODE_VERSION) {
        return
      }
      Start-Sleep -Seconds 1
    }
  }
  if ($null -eq $lockStream) {
    throw "Another installation is still using the runtime cache. Try again shortly."
  }

  $tempDir = Join-Path $CacheRoot (".node-install-" + [guid]::NewGuid().ToString("N"))
  try {
    if (Test-LocalNodeReady $NodePath $RuntimeDir $Manifest.NODE_VERSION) {
      return
    }

    New-Item -ItemType Directory -Path $tempDir | Out-Null
    $archivePath = Join-Path $tempDir $Archive
    $downloadUrl = "$($Manifest.NODE_BASE_URL)/v$($Manifest.NODE_VERSION)/$Archive"
    Write-Host "Downloading Node.js $($Manifest.NODE_VERSION) for Windows $Architecture..."
    Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $archivePath

    $actualSha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $ExpectedSha256) {
      throw "Node.js download verification failed. Expected $ExpectedSha256 but received $actualSha256."
    }

    Write-Host "Installing the verified Node.js runtime in the user cache..."
    Expand-Archive -LiteralPath $archivePath -DestinationPath $tempDir
    $extractedName = [System.IO.Path]::GetFileNameWithoutExtension($Archive)
    $extractedDir = Join-Path $tempDir $extractedName
    if (-not (Test-Path -LiteralPath $extractedDir -PathType Container)) {
      throw "The Node.js archive did not contain the expected directory."
    }
    if (Test-Path -LiteralPath $RuntimeDir) {
      throw "The target runtime directory already exists but is incomplete: $RuntimeDir"
    }
    Move-Item -LiteralPath $extractedDir -Destination $RuntimeDir

    if (-not (Test-LocalNodeReady $NodePath $RuntimeDir $Manifest.NODE_VERSION)) {
      throw "The local Node.js runtime could not be verified after extraction."
    }
  } finally {
    if (Test-Path -LiteralPath $tempDir) {
      Remove-Item -LiteralPath $tempDir -Recurse -Force
    }
    $lockStream.Dispose()
  }
}

try {
  $manifest = Read-RuntimeManifest
  if ($manifest.NODE_BASE_URL -ne "https://nodejs.org/dist") {
    throw "The Node.js download source is not the expected official URL."
  }

  $architecture = Get-TargetArchitecture
  $targetKey = "WIN_$($architecture.ToUpperInvariant())"
  $archive = $manifest["NODE_${targetKey}_ARCHIVE"]
  $expectedSha256 = $manifest["NODE_${targetKey}_SHA256"]
  if (-not $archive -or -not $expectedSha256) {
    throw "No Node.js runtime is configured for Windows $architecture."
  }

  $localAppData = [Environment]::GetFolderPath("LocalApplicationData")
  if (-not $localAppData) {
    $localAppData = $env:LOCALAPPDATA
  }
  if (-not $localAppData) {
    throw "Windows did not provide a LOCALAPPDATA directory."
  }
  $cacheRoot = Join-Path $localAppData "whoami_\runtime"
  $runtimeDir = Join-Path $cacheRoot "node-v$($manifest.NODE_VERSION)-win-$architecture"
  $localNode = Join-Path $runtimeDir "node.exe"

  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  $systemNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  $systemNpx = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if ($systemNode -and $systemNpm -and $systemNpx -and
      (Test-NodeSupported $systemNode.Source $manifest.NODE_MINIMUM_VERSION)) {
    $nodePath = $systemNode.Source
    $nodeSource = "system"
  } elseif (Test-LocalNodeReady $localNode $runtimeDir $manifest.NODE_VERSION) {
    $nodePath = $localNode
    $nodeSource = "local cache"
  } else {
    $nodePath = $localNode
    $nodeSource = "official download"
  }

  if ($Check) {
    Write-Host "Bootstrap check passed: win-$architecture; Node source: $nodeSource."
    exit 0
  }

  if ($nodeSource -eq "official download") {
    Install-LocalNode $manifest $architecture $archive $expectedSha256 $cacheRoot $runtimeDir $localNode
  }
  if ($nodeSource -ne "system") {
    $env:Path = "$runtimeDir;$env:Path"
    $nodePath = $localNode
  }

  Set-Location -LiteralPath $ProjectDir
  & $nodePath (Join-Path $ProjectDir "scripts\launch-editor.mjs")
  exit $LASTEXITCODE
} catch {
  Write-Host "whoami_ could not start: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
