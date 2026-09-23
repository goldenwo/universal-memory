# hooks/run-hook.test.ps1 - tests for run-hook.cmd (Windows PowerShell 5.1).
# CI: the hook-tests-windows job in .github/workflows/smoke.yml.
#
# Codex runs a Windows hook through the SESSION shell: codex 0.155.1 exec/TUI was measured
# (2026-09-22, parent-process probe inside a real hook) running
#     powershell.exe -NoProfile -Command "<command>"      (pwsh.exe when installed)
# and Codex falls back to  %COMSPEC% /C "<command>"  when a session has no shell
# (codex-rs/hooks/src/engine/command_runner.rs). Every hooks.json commandWindows is run in all
# three shapes, with ${CLAUDE_PLUGIN_ROOT} replaced by a fixture root containing spaces and
# parentheses. (A root containing '&' or '^' is a documented limitation of the cmd /d /c form -
# measured.) Stub hook scripts record the stdin bytes they receive, their $HOME, and whether a
# PATH tail marker survived, and print fixture stdout bytes, so byte transport, exit codes, the
# environment the script sees and the fail-open paths are observed from outside, as Codex sees them.
#
# Harness rules, both learned the hard way (2026-09-22):
#  - Variables are set on THIS process and inherited. Rebuilding a child's environment through
#    ProcessStartInfo.EnvironmentVariables made cmd and bash lookups fail intermittently.
#  - Payloads reach stdin through an outer cmd's "<" redirection from a file. A .NET stdin pipe
#    writer adds a UTF-8 BOM when the console runs code page 65001.
# A SKIP is a failure on CI (GITHUB_ACTIONS=true): the runner must execute every case.
# Non-ASCII test data is built from byte values: this file stays ASCII-only, because Windows
# PowerShell 5.1 decodes a BOM-less script with the ANSI code page.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8 = New-Object System.Text.UTF8Encoding($false)
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$pwshCmd = Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$pwshExe = if ($pwshCmd) { $pwshCmd.Source } else { $null }
$onCi = ($env:GITHUB_ACTIONS -eq 'true')
$script:failures = 0

# Run with Git's tool directories REMOVED from PATH (Git\cmd stays, so git.exe is found): the
# environment of a Codex session launched from PowerShell. Then only the launcher's own PATH setup
# can make cat, sed and cygpath resolvable. Launched from git-bash they are already on PATH, which
# masked a PATH rewrite that silently did nothing (found by review round 4, 2026-09-23).
$env:PATH = (($env:PATH -split ';') | Where-Object { $_ -and ($_.TrimEnd('\') -notmatch '\\Git\\(usr\\bin|mingw64\\bin|bin)$') }) -join ';'

function Check([bool]$Condition, [string]$Name) {
    if ($Condition) { Write-Output "PASS: $Name" } else { Write-Output "FAIL: $Name"; $script:failures++ }
}

function Skip([string]$Name) {
    if ($onCi) { Check $false "$Name (SKIP is a failure on CI)" } else { Write-Output "SKIP: $Name" }
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

# Run <command> in a Codex hook shape ('PS', 'PWSH' or 'CMD'), with the console at code page $Cp
# (or untouched), stdin from a file, in $Cwd, with $Vars applied to this process for the call
# (null removes a variable). Returns exit code + stdout bytes.
function Invoke-Hook([string]$Shape, [string]$Command, [string]$StdinFile, [string]$Cwd, [hashtable]$Vars, [string]$Cp = '') {
    if ($Shape -eq 'PS' -or $Shape -eq 'PWSH') {
        $exe = if ($Shape -eq 'PS') { $psExe } else { $pwshExe }
        # Codex passes the command as ONE argument (Rust quoting: inner quotes become \").
        $inner = '"' + $exe + '" -NoProfile -Command "' + ($Command -replace '"', '\"') + '"'
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
        if (-not $p.WaitForExit(120000)) { $p.Kill(); throw "timed out: $Command" }
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

$stub = @'
#!/usr/bin/env bash
cat > "$STUB_DIR/stdin-$(basename "$0").bin"
cat "$STUB_DIR/stdout.bin"
cygpath -w "$HOME" > "$STUB_DIR/home-$(basename "$0").txt" 2>/dev/null
case ":$PATH:" in *um-path-tail*) printf ok > "$STUB_DIR/tail-$(basename "$0").txt" ;; esac
exit "${STUB_EXIT:-0}"
'@
$stub = $stub -replace "`r`n", "`n"
if (-not $stub.EndsWith("`n")) { $stub += "`n" }
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
function Received([string]$s) { Join-Path $tmp "stdin-$s.bin" }
function Ran([string]$s) { $f = Received $s; (Test-Path -LiteralPath $f) -and (Same-Bytes ([System.IO.File]::ReadAllBytes($f)) $payload) }
function Reset([string]$s) { foreach ($k in 'stdin', 'home', 'tail') { Remove-Item -LiteralPath (Join-Path $tmp "$k-$s.$(if ($k -eq 'stdin') { 'bin' } else { 'txt' })") -ErrorAction SilentlyContinue } }
function CommandFor([string]$Event) {
    $h = $hooksJson.hooks.$Event[0].hooks[0]
    return $h.commandWindows.Replace('${CLAUDE_PLUGIN_ROOT}', $tmp)
}
$shapes = @('PS', 'CMD')
if ($pwshExe) { $shapes += 'PWSH' } else { Skip 'PWSH shape - pwsh is not installed here' }

try {
    # 1. Each hooks.json commandWindows in every Codex hook shape and under both console code pages:
    #    stdin reaches the script byte-exact (no BOM), stdout comes back byte-exact, exit 0.
    foreach ($shape in $shapes) {
        foreach ($cp in @('65001', '437')) {
            foreach ($event in $hooksJson.hooks.PSObject.Properties) {
                $handler = $event.Value[0].hooks[0]
                $s = ($scripts | Where-Object { $handler.command -like "*/hooks/$_*" } | Select-Object -First 1)
                Reset $s
                $r = Invoke-Hook $shape (CommandFor $event.Name) $payloadFile $tmp $base $cp
                Check (($r.Exit -eq 0) -and (Ran $s) -and (Same-Bytes $r.Out $stdoutFixture)) "$shape cp$cp $($event.Name): exit 0, stdin + stdout byte-exact"
            }
        }
    }

    # 2. A failing script is never reported as success. The CMD shape carries the exact code;
    #    PowerShell -Command reports any failing native command as a generic failure (measured with
    #    Windows PowerShell: exit 1, the same for today's bare-bash command).
    $r = Invoke-Hook 'CMD' (CommandFor 'Stop') $payloadFile $tmp (With @{ STUB_EXIT = '3' })
    Check ($r.Exit -eq 3) 'CMD exit code propagates exactly (3)'
    foreach ($shape in ($shapes | Where-Object { $_ -ne 'CMD' })) {
        $r = Invoke-Hook $shape (CommandFor 'Stop') $payloadFile $tmp (With @{ STUB_EXIT = '3' })
        Check ($r.Exit -ne 0) "$shape failing script reported as failure (exit $($r.Exit))"
    }

    # 3. Shape-check refusals (launcher invoked directly): exit 0, skip, nothing run, empty stdout.
    foreach ($bad in @('..\stop.sh', 'sub/stop.sh', 'x.txt', 'c:stop.sh')) {
        Reset 'stop.sh'
        $r = Invoke-Hook 'CMD' ($launcher + '"' + $bad + '"') $payloadFile $tmp $base
        Check (($r.Exit -eq 0) -and ($r.Out.Length -eq 0) -and -not (Test-Path -LiteralPath (Received 'stop.sh'))) "refuse '$bad': exit 0, empty stdout, nothing run"
    }
    Check ((Hook-LogText $fakeHome) -match 'run-hook skip=unknown-script') 'refusals: skip=unknown-script logged'

    # 4. Well-formed names that match no single script: fail open with skip=no-script.
    foreach ($missing in @('absent.sh', '*.sh')) {
        $r = Invoke-Hook 'CMD' ($launcher + '"' + $missing + '"') $payloadFile $tmp $base
        Check (($r.Exit -eq 0) -and ($r.Out.Length -eq 0)) "no script '$missing': exit 0, empty stdout"
    }
    Check ((Hook-LogText $fakeHome) -match 'absent skip=no-script') 'no script: skip=no-script logged'

    # 5. UM_GIT_BASH is exclusive and must be an absolute path to a file: a missing file, a
    #    directory and a relative path all fail open with skip=no-git-bash; a real path runs.
    $realBash = Join-Path ${env:ProgramFiles} 'Git\bin\bash.exe'
    $badValues = [ordered]@{ 'missing' = (Join-Path $empty 'bash.exe'); 'a directory' = (Split-Path -Parent (Split-Path -Parent $realBash)); 'relative' = 'Git\bin\bash.exe' }
    foreach ($label in $badValues.Keys) {
        Reset 'session-end.sh'
        $before = (Hook-LogText $fakeHome).Length
        $r = Invoke-Hook 'PS' (CommandFor 'SessionEnd') $payloadFile $tmp (With @{ UM_GIT_BASH = $badValues[$label] })
        $logged = (Hook-LogText $fakeHome).Substring($before) -match 'session-end skip=no-git-bash'
        Check (($r.Exit -eq 0) -and ($r.Out.Length -eq 0) -and -not (Test-Path -LiteralPath (Received 'session-end.sh')) -and $logged) "UM_GIT_BASH $label`: exit 0, empty stdout, nothing run, skip=no-git-bash"
    }
    Reset 'session-end.sh'
    $r = Invoke-Hook 'PS' (CommandFor 'SessionEnd') $payloadFile $tmp (With @{ UM_GIT_BASH = $realBash })
    Check ((Ran 'session-end.sh') -and ($r.Exit -eq 0)) 'UM_GIT_BASH real: runs'

    # 6. Walk-up precedence: a fake Git layout whose bin\bash.exe is a marker program. The walk
    #    from git.exe must find it before the registry and ProgramFiles fallbacks, which would
    #    find the machine's real Git. A freshly compiled, unsigned executable cannot run where
    #    Device Guard / Smart App Control enforces (measured on a dev machine 2026-09-22).
    $fakeGit = Join-Path $tmp 'G'
    foreach ($d in @('cmd', 'bin', 'mingw64\bin')) { New-Item -ItemType Directory -Path (Join-Path $fakeGit $d) -Force | Out-Null }
    New-MarkerExe (Join-Path $fakeGit 'bin\bash.exe')
    foreach ($d in @('cmd', 'mingw64\bin')) { [System.IO.File]::WriteAllBytes((Join-Path $fakeGit "$d\git.exe"), [byte[]]@()) }
    $probe = Join-Path $tmp 'marker-probe.txt'
    $env:MARKER_FILE = $probe
    try { & (Join-Path $fakeGit 'bin\bash.exe') 'probe' 2>$null | Out-Null } catch { }
    Remove-Item Env:\MARKER_FILE
    if (-not (Test-Path -LiteralPath $probe)) {
        Skip 'walk-up precedence (x2) - this machine blocks compiled test executables (Device Guard / Smart App Control)'
    } else {
        foreach ($d in @('cmd', 'mingw64\bin')) {
            $marker = Join-Path $tmp "walk-$($d -replace '\\','-').txt"
            $path = (Join-Path $fakeGit $d) + ';' + $env:SystemRoot + '\System32;' + $env:SystemRoot + '\System32\WindowsPowerShell\v1.0'
            $r = Invoke-Hook 'PS' (CommandFor 'Stop') $payloadFile $tmp (With @{ MARKER_FILE = $marker; PATH = $path })
            Check ((Test-Path -LiteralPath $marker) -and ([System.IO.File]::ReadAllText($marker) -like '*/hooks/stop.sh')) "walk-up from Git\$d wins"
        }
    }

    # 7. HOME: unset HOME resolves the way Git's wrapper does (HOMEDRIVE+HOMEPATH when that
    #    directory exists) - for the skip log AND for the script's own $HOME on the fast path.
    $altHome = Join-Path $tmp 'alt home'
    New-Item -ItemType Directory -Path $altHome -Force | Out-Null
    $homeVars = @{ HOME = $null; HOMEDRIVE = $altHome.Substring(0, 2); HOMEPATH = $altHome.Substring(2) }
    $r = Invoke-Hook 'CMD' ($launcher + '"absent.sh"') $payloadFile $tmp (With $homeVars)
    Check ((Hook-LogText $altHome) -match 'absent skip=no-script') 'HOME unset: skip log under HOMEDRIVE+HOMEPATH'
    Reset 'stop.sh'
    $r = Invoke-Hook 'PS' (CommandFor 'Stop') $payloadFile $tmp (With $homeVars)
    $seen = if (Test-Path -LiteralPath (Join-Path $tmp 'home-stop.sh.txt')) { [System.IO.File]::ReadAllText((Join-Path $tmp 'home-stop.sh.txt')).Trim() } else { '' }
    Check (($r.Exit -eq 0) -and ($seen.TrimEnd('\') -ieq $altHome.TrimEnd('\'))) "HOME unset: the script's HOME is HOMEDRIVE+HOMEPATH (saw '$seen')"

    # 8. Long PATH: cmd cannot rewrite a PATH near or past its 8191-character limit, so the launcher
    #    hands such PATHs to Git's own wrapper. The script must run with the full PATH (tail kept).
    #    8170: cmd can still expand it and the rewritten PATH passes 8191 characters - which a
    #    %-expanded rewrite would fail with "The input line is too long" and the delayed-expansion
    #    rewrite handles. 9000: past what cmd can expand at all - the guard hands it to the wrapper.
    $tail = 'C:\um-path-tail'
    foreach ($target in @(8170, 9000)) {
        $long = $env:PATH; $i = 0
        while ($long.Length -lt $target - $tail.Length - 60) { $i++; $long += ';C:\um-filler-' + $i.ToString('0000') + '-abcdefghijklmnopqrstuvwxyz' }
        $long += ';C:\um-pad-' + ('x' * ($target - $tail.Length - 1 - $long.Length - 11))
        $long += ';' + $tail
        Reset 'stop.sh'
        $r = Invoke-Hook 'PS' (CommandFor 'Stop') $payloadFile $tmp (With @{ PATH = $long })
        Check (($r.Exit -eq 0) -and (Ran 'stop.sh') -and (Test-Path -LiteralPath (Join-Path $tmp 'tail-stop.sh.txt'))) "PATH of $($long.Length) chars: runs with the PATH tail intact"
    }

    # 9. A quoted PATH entry containing '&' must not split the launcher's PATH rewrite (which would
    #    skip the hook and run a same-named file from the session directory).
    $amp = Join-Path $tmp 'amp cwd'
    New-Item -ItemType Directory -Path $amp -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $amp 'D.cmd'), "@echo hijack> `"%~dp0D.cmd.marker`"`r`n")
    Reset 'stop.sh'
    $r = Invoke-Hook 'PS' (CommandFor 'Stop') $payloadFile $amp (With @{ PATH = ('"C:\R&D Tools\bin";' + $env:PATH + ';' + $tail) })
    Check (($r.Exit -eq 0) -and (Ran 'stop.sh') -and (Test-Path -LiteralPath (Join-Path $tmp 'tail-stop.sh.txt')) -and -not (Test-Path -LiteralPath (Join-Path $amp 'D.cmd.marker'))) 'quoted PATH entry with &: runs, PATH intact, nothing from the cwd'

    # 10. cwd hijack: look-alikes planted in the session directory must never run. Batch files, not
    #     executables: cmd tries every PATHEXT extension in the working directory before PATH, and
    #     Device Guard does not block batch files - a planted .exe would be blocked on such a machine
    #     and the check would pass without testing anything (caught by a mutation control).
    #     Covers the launcher's bash run, registry fallback (PATH without git) and skip path, and the
    #     commandWindows 'cmd' token in every shape.
    $evil = Join-Path $tmp 'evil repo'
    New-Item -ItemType Directory -Path $evil -Force | Out-Null
    foreach ($n in @('bash', 'git', 'reg', 'powershell', 'where', 'findstr', 'cmd')) {
        [System.IO.File]::WriteAllText((Join-Path $evil "$n.cmd"), "@echo hijack> `"%~dp0$n.cmd.marker`"`r`n")
    }
    Reset 'stop.sh'
    $runs = @()
    $runs += Invoke-Hook 'CMD' ($launcher + 'stop.sh') $payloadFile $evil $base
    $runs += Invoke-Hook 'CMD' ($launcher + 'stop.sh') $payloadFile $evil (With @{ PATH = ($env:SystemRoot + '\System32') })
    $runs += Invoke-Hook 'CMD' ($launcher + '"absent.sh"') $payloadFile $evil $base
    foreach ($shape in $shapes) { $runs += Invoke-Hook $shape (CommandFor 'Stop') $payloadFile $evil $base }
    $markers = @(Get-ChildItem -LiteralPath $evil -Filter '*.marker' -ErrorAction SilentlyContinue)
    Check ($markers.Count -eq 0) ('cwd hijack: no look-alike ran' + $(if ($markers.Count) { ' (' + (($markers | ForEach-Object { $_.Name }) -join ',') + ')' } else { '' }))
    Check ((Ran 'stop.sh') -and -not ($runs | Where-Object { $_.Exit -ne 0 })) 'cwd hijack: the real stub ran, all exit 0'
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:failures -gt 0) { Write-Output "$($script:failures) FAILED"; exit 1 }
Write-Output 'ALL PASS'
exit 0
