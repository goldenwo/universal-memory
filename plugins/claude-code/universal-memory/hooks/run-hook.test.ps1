# hooks/run-hook.test.ps1 - tests for run-hook.cmd (Windows PowerShell 5.1).
# CI: the hook-tests-windows job in .github/workflows/smoke.yml.
#
# Codex runs a Windows hook through the SESSION shell: codex 0.155.1 exec/TUI was measured
# (2026-09-22, parent-process probe inside a real hook) running
#     powershell.exe -NoProfile -Command "<command>"
# and Codex falls back to  %COMSPEC% /C "<command>"  when a session has no shell
# (codex-rs/hooks/src/engine/command_runner.rs). Every hooks.json commandWindows is run in BOTH
# shapes, with ${CLAUDE_PLUGIN_ROOT} replaced by a fixture root containing spaces and parentheses.
# (A root containing '&' is a documented limitation of the cmd /d /c form - measured.) Stub hook
# scripts record the stdin bytes they receive and print fixture stdout bytes, so byte transport,
# exit codes and the fail-open paths are observed from outside, the way Codex sees them.
#
# Harness rules, both learned the hard way (2026-09-22):
#  - Variables are set on THIS process and inherited. Rebuilding a child's environment through
#    ProcessStartInfo.EnvironmentVariables made cmd and bash lookups fail intermittently.
#  - Payloads reach stdin through an outer cmd's "<" redirection from a file. A .NET stdin pipe
#    writer adds a UTF-8 BOM when the console runs code page 65001.
# Non-ASCII test data is built from byte values: this file stays ASCII-only, because Windows
# PowerShell 5.1 decodes a BOM-less script with the ANSI code page.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8 = New-Object System.Text.UTF8Encoding($false)
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script:failures = 0

function Check([bool]$Condition, [string]$Name) {
    if ($Condition) { Write-Output "PASS: $Name" } else { Write-Output "FAIL: $Name"; $script:failures++ }
}

function Same-Bytes([byte[]]$A, [byte[]]$B) {
    if ($A.Length -ne $B.Length) { return $false }
    for ($i = 0; $i -lt $A.Length; $i++) { if ($A[$i] -ne $B[$i]) { return $false } }
    return $true
}

function Join-Bytes([object[]]$Parts) {
    $ms = New-Object System.IO.MemoryStream
    foreach ($p in $Parts) {
        if ($p -is [string]) { $b = $utf8.GetBytes($p) } else { $b = [byte[]]$p }
        $ms.Write($b, 0, $b.Length)
    }
    return , $ms.ToArray()
}

# Run <command> in a Codex hook shape ('PS' or 'CMD'), with the console at code page $Cp (or
# untouched), stdin from a file, in $Cwd, with $Vars applied to this process for the call (null
# removes a variable). Returns exit code + stdout bytes.
function Invoke-Hook([string]$Shape, [string]$Command, [string]$StdinFile, [string]$Cwd, [hashtable]$Vars, [string]$Cp = '') {
    if ($Shape -eq 'PS') {
        # Codex passes the command as ONE argument (Rust quoting: inner quotes become \").
        $inner = $psExe + ' -NoProfile -Command "' + ($Command -replace '"', '\"') + '"'
    } else {
        $inner = $env:ComSpec + ' /C "' + $Command + '"'
    }
    $prefix = if ($Cp) { "chcp $Cp >nul & " } else { '' }
    $saved = @{}
    foreach ($k in $Vars.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
        [Environment]::SetEnvironmentVariable($k, $Vars[$k], 'Process')
    }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $env:ComSpec
        $psi.Arguments = '/C "' + $prefix + $inner + ' < "' + $StdinFile + '""'
        $psi.UseShellExecute = $false
        $psi.WorkingDirectory = $Cwd
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $out = New-Object System.IO.MemoryStream
        $outCopy = $p.StandardOutput.BaseStream.CopyToAsync($out)
        $err = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit(60000)) { $p.Kill(); throw "timed out: $Command" }
        $outCopy.Wait()
        return @{ Exit = $p.ExitCode; Out = $out.ToArray(); Err = $err.Result }
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    }
}

function Hook-LogText([string]$HomeDir) {
    $log = Join-Path $HomeDir '.um\hook.log'
    if (Test-Path -LiteralPath $log) { return [System.IO.File]::ReadAllText($log) }
    return ''
}

# A tiny console program compiled in-test (no external tools): writes its argv to the file named
# by MARKER_FILE and exits 0. The fake bash.exe that proves resolution order.
function New-MarkerExe([string]$Path) {
    $src = 'public static class MarkerMain { public static int Main(string[] a) { ' +
           'System.IO.File.WriteAllText(System.Environment.GetEnvironmentVariable("MARKER_FILE"), string.Join("|", a)); return 0; } }'
    Add-Type -TypeDefinition $src -OutputType ConsoleApplication -OutputAssembly $Path
}

# --- fixture -----------------------------------------------------------------------------
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('um run-hook (t) ' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$fixHooks = Join-Path $tmp 'hooks'
$fakeHome = Join-Path $tmp 'home'
$empty = Join-Path $tmp 'empty'
New-Item -ItemType Directory -Path $fixHooks, $fakeHome, $empty -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $here 'run-hook.cmd') -Destination $fixHooks
$stubDir = $tmp -replace '\\', '/'

$stub = "#!/usr/bin/env bash`n" +
        "cat > `"`$STUB_DIR/stdin-`$(basename `"`$0`").bin`"`n" +
        "cat `"`$STUB_DIR/stdout.bin`"`n" +
        "exit `"`${STUB_EXIT:-0}`"`n"
$scripts = @('session-start.sh', 'user-prompt-submit.sh', 'stop.sh', 'session-end.sh')
foreach ($s in $scripts) { [System.IO.File]::WriteAllText((Join-Path $fixHooks $s), $stub, $utf8) }

# e-acute, em dash, CJK, emoji: multi-byte UTF-8 in both directions.
$payload = Join-Bytes @('{"hook_event_name":"UserPromptSubmit","prompt":"caf', [byte[]](0xC3, 0xA9), ' ',
                        [byte[]](0xE2, 0x80, 0x94), ' ', [byte[]](0xE6, 0x97, 0xA5), ' ',
                        [byte[]](0xF0, 0x9F, 0x99, 0x82), '"}')
$payloadFile = Join-Path $tmp 'payload.bin'
[System.IO.File]::WriteAllBytes($payloadFile, $payload)
$stdoutFixture = Join-Bytes @('{"hookSpecificOutput":{"additionalContext":"na', [byte[]](0xC3, 0xAF), 've ',
                              [byte[]](0xE2, 0x80, 0x94), '"}}')
[System.IO.File]::WriteAllBytes((Join-Path $tmp 'stdout.bin'), $stdoutFixture)

$hooksJson = [System.IO.File]::ReadAllText((Join-Path $here 'hooks.json')) | ConvertFrom-Json
$base = @{ CLAUDE_PLUGIN_ROOT = $tmp; STUB_DIR = $stubDir; HOME = $fakeHome; STUB_EXIT = '0';
           UM_GIT_BASH = $null; MARKER_FILE = $null; NoDefaultCurrentDirectoryInExePath = $null }
function With([hashtable]$Extra) { $h = $base.Clone(); foreach ($k in $Extra.Keys) { $h[$k] = $Extra[$k] }; return $h }
$launcher = '"' + (Join-Path $fixHooks 'run-hook.cmd') + '" '
$received = { param($s) Join-Path $tmp "stdin-$s.bin" }
function CommandFor([string]$Event) {
    $h = $hooksJson.hooks.$Event[0].hooks[0]
    return $h.commandWindows.Replace('${CLAUDE_PLUGIN_ROOT}', $tmp)
}

try {
    # 1. Each hooks.json commandWindows in both Codex hook shapes and under both console code pages:
    #    stdin reaches the script byte-exact (no BOM), stdout comes back byte-exact, exit 0.
    foreach ($shape in @('PS', 'CMD')) {
        foreach ($cp in @('65001', '437')) {
            foreach ($event in $hooksJson.hooks.PSObject.Properties) {
                $handler = $event.Value[0].hooks[0]
                $s = ($scripts | Where-Object { $handler.command -like "*/hooks/$_*" } | Select-Object -First 1)
                Remove-Item -LiteralPath (& $received $s) -ErrorAction SilentlyContinue
                $r = Invoke-Hook $shape (CommandFor $event.Name) $payloadFile $tmp $base $cp
                $got = if (Test-Path -LiteralPath (& $received $s)) { [System.IO.File]::ReadAllBytes((& $received $s)) } else { [byte[]]@() }
                Check (($r.Exit -eq 0) -and (Same-Bytes $got $payload) -and (Same-Bytes $r.Out $stdoutFixture)) "$shape cp$cp $($event.Name): exit 0, stdin + stdout byte-exact"
            }
        }
    }

    # 2. A failing script is never reported as success. The CMD shape carries the exact code;
    #    Windows PowerShell -Command reports any failing native command as exit 1 (measured: the
    #    same for today's bare-bash command), so there the assertion is "1", not "3".
    $r = Invoke-Hook 'CMD' (CommandFor 'Stop') $payloadFile $tmp (With @{ STUB_EXIT = '3' })
    Check ($r.Exit -eq 3) 'CMD exit code propagates exactly (3)'
    $r = Invoke-Hook 'PS' (CommandFor 'Stop') $payloadFile $tmp (With @{ STUB_EXIT = '3' })
    Check ($r.Exit -eq 1) 'PS failing script reported as failure (1)'

    # 3. Shape-check refusals (launcher invoked directly): exit 0, skip, nothing run, empty stdout.
    foreach ($bad in @('..\stop.sh', 'sub/stop.sh', 'x.txt', 'c:stop.sh')) {
        Remove-Item -LiteralPath (& $received 'stop.sh') -ErrorAction SilentlyContinue
        $r = Invoke-Hook 'CMD' ($launcher + '"' + $bad + '"') $payloadFile $tmp $base
        Check (($r.Exit -eq 0) -and ($r.Out.Length -eq 0) -and -not (Test-Path -LiteralPath (& $received 'stop.sh'))) "refuse '$bad': exit 0, empty stdout, nothing run"
    }
    Check ((Hook-LogText $fakeHome) -match 'run-hook skip=unknown-script') 'refusals: skip=unknown-script logged'

    # 4. Well-formed names that match no single script: fail open with skip=no-script.
    foreach ($missing in @('absent.sh', '*.sh')) {
        $r = Invoke-Hook 'CMD' ($launcher + '"' + $missing + '"') $payloadFile $tmp $base
        Check (($r.Exit -eq 0) -and ($r.Out.Length -eq 0)) "no script '$missing': exit 0, empty stdout"
    }
    Check ((Hook-LogText $fakeHome) -match 'absent skip=no-script') 'no script: skip=no-script logged'

    # 5. UM_GIT_BASH is exclusive: a missing path fails open; a real path runs.
    Remove-Item -LiteralPath (& $received 'session-end.sh') -ErrorAction SilentlyContinue
    $r = Invoke-Hook 'PS' (CommandFor 'SessionEnd') $payloadFile $tmp (With @{ UM_GIT_BASH = (Join-Path $empty 'bash.exe') })
    Check (($r.Exit -eq 0) -and ($r.Out.Length -eq 0) -and -not (Test-Path -LiteralPath (& $received 'session-end.sh'))) 'UM_GIT_BASH missing: exit 0, empty stdout, nothing run'
    Check ((Hook-LogText $fakeHome) -match 'session-end skip=no-git-bash') 'UM_GIT_BASH missing: skip=no-git-bash logged'
    $realBash = Join-Path ${env:ProgramFiles} 'Git\bin\bash.exe'
    $r = Invoke-Hook 'PS' (CommandFor 'SessionEnd') $payloadFile $tmp (With @{ UM_GIT_BASH = $realBash })
    Check ((Test-Path -LiteralPath (& $received 'session-end.sh')) -and ($r.Exit -eq 0)) 'UM_GIT_BASH real: runs'

    # 6. Walk-up precedence: a fake Git layout whose bin\bash.exe is a marker program. The walk
    #    from git.exe must find it before the registry and ProgramFiles fallbacks, which would
    #    find the machine's real Git. A freshly compiled, unsigned executable cannot run where
    #    Device Guard / Smart App Control enforces (measured on a dev machine 2026-09-22), so
    #    the case is SKIPPED there - loudly, never counted as a pass. CI runners run it.
    $fakeGit = Join-Path $tmp 'G'
    foreach ($d in @('cmd', 'bin', 'mingw64\bin')) { New-Item -ItemType Directory -Path (Join-Path $fakeGit $d) -Force | Out-Null }
    New-MarkerExe (Join-Path $fakeGit 'bin\bash.exe')
    foreach ($d in @('cmd', 'mingw64\bin')) { [System.IO.File]::WriteAllBytes((Join-Path $fakeGit "$d\git.exe"), [byte[]]@()) }
    $probe = Join-Path $tmp 'marker-probe.txt'
    $env:MARKER_FILE = $probe
    try { & (Join-Path $fakeGit 'bin\bash.exe') 'probe' 2>$null | Out-Null } catch { }
    Remove-Item Env:\MARKER_FILE
    if (-not (Test-Path -LiteralPath $probe)) {
        Write-Output 'SKIP: walk-up precedence (x2) - this machine blocks compiled test executables (Device Guard / Smart App Control); CI runs these cases'
    } else {
        foreach ($d in @('cmd', 'mingw64\bin')) {
            $marker = Join-Path $tmp "walk-$($d -replace '\\','-').txt"
            $path = (Join-Path $fakeGit $d) + ';' + $env:SystemRoot + '\System32;' + $env:SystemRoot + '\System32\WindowsPowerShell\v1.0'
            $r = Invoke-Hook 'PS' (CommandFor 'Stop') $payloadFile $tmp (With @{ MARKER_FILE = $marker; PATH = $path })
            Check ((Test-Path -LiteralPath $marker) -and ([System.IO.File]::ReadAllText($marker) -like '*/hooks/stop.sh')) "walk-up from Git\$d wins"
        }
    }

    # 7. HOME unset: the skip line lands under HOMEDRIVE+HOMEPATH when that exists, like Git Bash.
    $altHome = Join-Path $tmp 'alt home'
    New-Item -ItemType Directory -Path $altHome -Force | Out-Null
    $r = Invoke-Hook 'CMD' ($launcher + '"absent.sh"') $payloadFile $tmp (With @{ HOME = $null; HOMEDRIVE = $altHome.Substring(0, 2); HOMEPATH = $altHome.Substring(2) })
    Check ((Hook-LogText $altHome) -match 'absent skip=no-script') 'HOME unset: log under HOMEDRIVE+HOMEPATH'

    # 8. cwd hijack: look-alikes planted in the session directory must never run. Batch files, not
    #    executables: cmd tries every PATHEXT extension in the working directory before PATH, and
    #    Device Guard does not block batch files - a planted .exe would be blocked on such a machine
    #    and the check would pass without testing anything (caught by a mutation control).
    #    Covers the launcher's bash run, registry fallback (PATH without git) and skip path, plus the
    #    commandWindows 'cmd' token in the PowerShell shape (PowerShell never searches the cwd).
    #    Not asserted: the CMD fallback shape resolves that 'cmd' token cwd-first (documented).
    $evil = Join-Path $tmp 'evil repo'
    New-Item -ItemType Directory -Path $evil -Force | Out-Null
    foreach ($n in @('bash', 'git', 'reg', 'powershell', 'where', 'findstr', 'cmd')) {
        [System.IO.File]::WriteAllText((Join-Path $evil "$n.cmd"), "@echo hijack> `"%~dp0$n.cmd.marker`"`r`n")
    }
    Remove-Item -LiteralPath (& $received 'stop.sh') -ErrorAction SilentlyContinue
    $r1 = Invoke-Hook 'CMD' ($launcher + 'stop.sh') $payloadFile $evil $base
    $r2 = Invoke-Hook 'CMD' ($launcher + 'stop.sh') $payloadFile $evil (With @{ PATH = ($env:SystemRoot + '\System32') })
    $r3 = Invoke-Hook 'CMD' ($launcher + '"absent.sh"') $payloadFile $evil $base
    $r4 = Invoke-Hook 'PS' (CommandFor 'Stop') $payloadFile $evil $base
    $markers = @(Get-ChildItem -LiteralPath $evil -Filter '*.marker' -ErrorAction SilentlyContinue)
    Check ($markers.Count -eq 0) ('cwd hijack: no look-alike ran' + $(if ($markers.Count) { ' (' + (($markers | ForEach-Object { $_.Name }) -join ',') + ')' } else { '' }))
    Check ((Test-Path -LiteralPath (& $received 'stop.sh')) -and $r1.Exit -eq 0 -and $r2.Exit -eq 0 -and $r3.Exit -eq 0 -and $r4.Exit -eq 0) 'cwd hijack: the real stub ran, all exit 0'
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:failures -gt 0) { Write-Output "$($script:failures) FAILED"; exit 1 }
Write-Output 'ALL PASS'
exit 0
