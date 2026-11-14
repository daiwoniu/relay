param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('protect', 'unprotect')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'

try {
    Add-Type -AssemblyName System.Security
    $inputValue = [Console]::In.ReadToEnd()
    if ($Action -eq 'protect') {
        $plainBytes = [Text.Encoding]::UTF8.GetBytes($inputValue)
        $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
            $plainBytes,
            $null,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [Console]::Out.Write([Convert]::ToBase64String($protectedBytes))
        exit 0
    }

    $protectedBytes = [Convert]::FromBase64String($inputValue.Trim())
    $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
        $protectedBytes,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plainBytes))
    exit 0
} catch {
    [Console]::Error.Write('DPAPI operation failed')
    exit 1
}
