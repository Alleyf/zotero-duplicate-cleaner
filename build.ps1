$ErrorActionPreference = 'Stop'
$pluginDirectory = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $pluginDirectory 'manifest.json') -Raw | ConvertFrom-Json
$outputPath = Join-Path (Split-Path $pluginDirectory -Parent) "zotero-dedup-plugin-$($manifest.version).xpi"
Add-Type -AssemblyName System.IO.Compression
$stream = [System.IO.File]::Open($outputPath, [System.IO.FileMode]::Create)
$archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($name in @('manifest.json', 'icons/icon.svg')) {
        $entry = $archive.CreateEntry($name)
        $input = [System.IO.File]::OpenRead((Join-Path $pluginDirectory $name))
        try { $output = $entry.Open(); try { $input.CopyTo($output) } finally { $output.Dispose() } } finally { $input.Dispose() }
    }
    $entry = $archive.CreateEntry('bootstrap.js')
    $writer = [System.IO.StreamWriter]::new($entry.Open(), [System.Text.UTF8Encoding]::new($false))
    try {
        $writer.WriteLine((Get-Content -LiteralPath (Join-Path $pluginDirectory 'resource-locations.js') -Raw -Encoding UTF8))
        $writer.WriteLine((Get-Content -LiteralPath (Join-Path $pluginDirectory 'resource-cleanup.js') -Raw -Encoding UTF8))
        $writer.WriteLine((Get-Content -LiteralPath (Join-Path $pluginDirectory 'bootstrap.js') -Raw -Encoding UTF8))
    } finally { $writer.Dispose() }
} finally {
    $archive.Dispose()
}
Copy-Item -LiteralPath $outputPath -Destination (Join-Path (Split-Path $pluginDirectory -Parent) 'zotero-dedup-plugin.xpi') -Force
Get-Item -LiteralPath $outputPath
