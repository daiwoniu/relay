param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('query', 'terminate')]
    [string]$Action,
    [Parameter(Mandatory = $true, Position = 1)]
    [string]$ProfilePath
)

$ErrorActionPreference = 'Stop'
try {
    $fullProfile = [IO.Path]::GetFullPath($ProfilePath)
    if ($fullProfile -notmatch '[\\/]\.relay-dev[\\/]acceptance[\\/]run-[a-f0-9]{16,64}[\\/]profile$') {
        throw 'invalid profile path'
    }
    $plainArgument = "--user-data-dir=$fullProfile"
    $quotedArgument = "--user-data-dir=`"$fullProfile`""
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and
        $_.Name -ieq 'msedge.exe' -and
        $_.CommandLine -and
        ($_.CommandLine.IndexOf($plainArgument, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
         $_.CommandLine.IndexOf($quotedArgument, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
    $pids = @($processes | ForEach-Object { [int]$_.ProcessId })
    if ($Action -eq 'terminate') {
        foreach ($processId in $pids) { Stop-Process -Id $processId -Force -ErrorAction Stop }
    }
    [Console]::Out.Write((@{ pids = $pids } | ConvertTo-Json -Compress))
    exit 0
} catch {
    [Console]::Error.Write('process control failed')
    exit 1
}
