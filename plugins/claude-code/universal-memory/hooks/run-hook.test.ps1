# hooks/run-hook.test.ps1 - tests for run-hook.cmd (Windows PowerShell 5.1).
# CI: the hook-tests-windows job in .github/workflows/smoke.yml.
#
# Codex runs a Windows hook through the SESSION shell: codex 0.155.1 exec/TUI was measured
# (2026-09-22, parent-process probe inside a real hook) running
#     powershell.exe -NoProfile -Command "<command>"      (pwsh.exe when installed)
# and Codex falls back to  %COMSPEC% /C "<command>"  when a session has no shell
# (codex-rs/hooks/src/engine/command_runner.rs). Every hooks.json commandWindows is run in all
# three shapes, with ${CLAUDE_PLUGIN_ROOT} replaced by a fixture root containing spaces and
# parentheses. A root containing '&' is case 12, spawned directly as Codex spawns (the outer cmd
# that feeds stdin everywhere else cannot carry an '&'); a root containing '^' fails closed
# (measured, not tested here). Stub hook scripts record the stdin bytes they receive, their $HOME, and whether a
# PATH tail marker survived, and print fixture stdout bytes, so byte transport, exit codes, the
# environment the script sees and the fail-open paths are observed from outside, as Codex sees them.
# Case 14 (#329) runs this checkout's REAL session-start.sh through the launcher against a local
# HTTP server, with PYTHONUTF8 and PYTHONIOENCODING removed: the hooks' own Python must read its
# UTF-8 input correctly whatever the launching shell set.
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
$taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
$script:failures = 0
$script:lastErr = ''

# chcp (case 1) changes the console this harness shares with its children and the terminal it
# runs in: note the code page now and restore it at the end.
$cp0 = ''
try { $cp0 = ((& $env:ComSpec /d /c chcp) -replace '[^0-9]', '') } catch { }

# Run with Git's tool directories REMOVED from PATH (Git\cmd stays, so git.exe is found): the
# environment of a Codex session launched from PowerShell. Then only the launcher's own PATH setup
# can make cat, sed and cygpath resolvable. Launched from git-bash they are already on PATH, which
# masked a PATH rewrite that silently did nothing (found by review round 4, 2026-09-23).
$env:PATH = (($env:PATH -split ';') | Where-Object { $_ -and ($_.TrimEnd('\') -notmatch '\\Git\\(usr\\bin|mingw64\\bin|bin)$') }) -join ';'

# A failing check also prints the stderr of the last hook run, so a red CI run explains itself.
function Check([bool]$Condition, [string]$Name) {
    if ($Condition) { Write-Output "PASS: $Name" } else {
        Write-Output "FAIL: $Name"; $script:failures++
        $e = ($script:lastErr -replace '\s+', ' ').Trim()
        if ($e) { Write-Output ('  stderr of the last hook run: ' + $e.Substring(0, [Math]::Min(400, $e.Length))) }
    }
    $script:lastErr = ''
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
        # Kill the whole tree: Process.Kill ends only the outer process and leaves its children.
        if (-not $p.WaitForExit(120000)) { try { & $taskkill /T /F /PID $p.Id *> $null } catch { }; throw "timed out: $Command" }
        $outCopy.Wait()
        $script:lastErr = $err.Result
        return @{ Exit = $p.ExitCode; Out = $out.ToArray(); Err = $err.Result }
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    }
}

# Spawn <command> exactly as Codex does (codex-rs command_runner.rs build_command): CreateProcess of
# the shell with the command as ONE argument - PowerShell: -NoProfile -Command "<command>" with inner
# quotes as \"; cmd: /C "<command>" raw - and no outer cmd, so a command containing '&' reaches the
# shell intact. stdin gets the payload through the pipe, then closes.
function Invoke-Direct([string]$Shape, [string]$Command, [string]$Cwd, [hashtable]$Vars) {
    $saved = @{}
    foreach ($k in $Vars.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
        [Environment]::SetEnvironmentVariable($k, $Vars[$k], 'Process')
    }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        if ($Shape -eq 'CMD') { $psi.FileName = $env:ComSpec; $psi.Arguments = '/C "' + $Command + '"' }
        else {
            $psi.FileName = if ($Shape -eq 'PS') { $psExe } else { $pwshExe }
            $psi.Arguments = '-NoProfile -Command "' + ($Command -replace '"', '\"') + '"'
        }
        $psi.UseShellExecute = $false
        $psi.WorkingDirectory = $Cwd
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $out = New-Object System.IO.MemoryStream
        $outCopy = $p.StandardOutput.BaseStream.CopyToAsync($out)
        $err = $p.StandardError.ReadToEndAsync()
        $p.StandardInput.BaseStream.Write($payload, 0, $payload.Length)
        $p.StandardInput.Close()
        # Kill the whole tree: Process.Kill ends only the outer process and leaves its children.
        if (-not $p.WaitForExit(120000)) { try { & $taskkill /T /F /PID $p.Id *> $null } catch { }; throw "timed out: $Command" }
        $outCopy.Wait()
        $script:lastErr = $err.Result
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
function CommandFor([string]$Event, [string]$Root = $tmp) {
    $h = $hooksJson.hooks.$Event[0].hooks[0]
    return $h.commandWindows.Replace('${CLAUDE_PLUGIN_ROOT}', $Root)
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
    # A user variable named ERRORLEVEL would shadow the dynamic value the launcher exits with.
    $r = Invoke-Hook 'CMD' (CommandFor 'Stop') $payloadFile $tmp (With @{ STUB_EXIT = '3'; ERRORLEVEL = '0' })
    Check ($r.Exit -eq 3) 'CMD exit code propagates exactly (3) with a user variable ERRORLEVEL=0'
    foreach ($shape in ($shapes | Where-Object { $_ -ne 'CMD' })) {
        $r = Invoke-Hook $shape (CommandFor 'Stop') $payloadFile $tmp (With @{ STUB_EXIT = '3' })
        Check ($r.Exit -ne 0) "$shape failing script reported as failure (exit $($r.Exit))"
    }

    # 3. Shape-check refusals (launcher invoked directly): exit 0, skip, nothing run, empty stdout.
    #    Each must be refused by the shape check itself (skip=unknown-script), not only by the later
    #    lookup that finds no such file (skip=no-script) - otherwise deleting a shape guard stays
    #    green (review of 2026-09-24).
    foreach ($bad in @('..\stop.sh', 'sub/stop.sh', 'x.txt', 'c:stop.sh')) {
        Reset 'stop.sh'
        $before = (Hook-LogText $fakeHome).Length
        $r = Invoke-Hook 'CMD' ($launcher + '"' + $bad + '"') $payloadFile $tmp $base
        $logged = (Hook-LogText $fakeHome).Substring($before) -match 'run-hook skip=unknown-script'
        Check (($r.Exit -eq 0) -and ($r.Out.Length -eq 0) -and -not (Test-Path -LiteralPath (Received 'stop.sh')) -and $logged) "refuse '$bad': exit 0, empty stdout, nothing run, skip=unknown-script"
    }

    # 4. Well-formed names that match no single script: fail open with skip=no-script.
    foreach ($missing in @('absent.sh', '*.sh')) {
        $r = Invoke-Hook 'CMD' ($launcher + '"' + $missing + '"') $payloadFile $tmp $base
        Check (($r.Exit -eq 0) -and ($r.Out.Length -eq 0)) "no script '$missing': exit 0, empty stdout"
    }
    Check ((Hook-LogText $fakeHome) -match 'absent skip=no-script') 'no script: skip=no-script logged'
    # The skip line is lib/um-api.sh's um_log grammar, '<yyyy-MM-ddTHH:mm:ss> <hook> skip=<reason>':
    # um_log itself writes a line under a scratch HOME, and both lines must match one pattern, so a
    # change to either writer's format fails here.
    $gitBash = Join-Path ${env:ProgramFiles} 'Git\bin\bash.exe'
    $umHome = Join-Path $tmp 'um_log home'
    New-Item -ItemType Directory -Path $umHome -Force | Out-Null
    $umApi = (Join-Path $here 'lib\um-api.sh') -replace '\\', '/'
    $savedHome = $env:HOME
    try { $env:HOME = $umHome; & $gitBash -c "source '$umApi' && UM_HOOK_NAME=absent um_log skip=no-script" *> $null } catch { } finally { $env:HOME = $savedHome }
    $umLog = Join-Path $umHome '.um\hook.log'
    $umLine = if (Test-Path -LiteralPath $umLog) { [System.IO.File]::ReadAllText($umLog) } else { '' }
    $grammar = '(?m)^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} absent skip=no-script$'
    Check (((Hook-LogText $fakeHome) -match $grammar) -and ($umLine -match $grammar)) "skip line: <yyyy-MM-ddTHH:mm:ss> <hook> skip=<reason>, the pattern um_log writes (um_log wrote '$($umLine.Trim())')"

    # 5. UM_GIT_BASH is exclusive and must be an absolute path to a file: a missing file, a
    #    directory, a relative path and a drive-relative path (each relative form run from the
    #    directory it would resolve against, so accepting it would run Git), and WSL's launcher
    #    System32\bash.exe (what `where bash` names from cmd; where WSL is absent the missing file is
    #    refused instead) all fail open with skip=no-git-bash. A real path runs, with or without
    #    surrounding quotes, with forward slashes, and as Git's inner usr\bin\bash.exe - which must
    #    still get Git's tool directories (the stub needs cat), not run bare (review of 2026-09-24).
    $realBash = Join-Path ${env:ProgramFiles} 'Git\bin\bash.exe'
    $innerBash = Join-Path (Split-Path -Parent (Split-Path -Parent $realBash)) 'usr\bin\bash.exe'
    $badValues = [ordered]@{ 'missing' = @((Join-Path $empty 'bash.exe'), $tmp); 'a directory' = @((Split-Path -Parent (Split-Path -Parent $realBash)), $tmp)
                             'relative' = @('Git\bin\bash.exe', ${env:ProgramFiles}); 'drive-relative' = @(($realBash.Substring(0, 2) + 'Git\bin\bash.exe'), ${env:ProgramFiles})
                             'WSL launcher' = @((Join-Path $env:SystemRoot 'System32\bash.exe'), $tmp) }
    foreach ($label in $badValues.Keys) {
        Reset 'session-end.sh'
        $before = (Hook-LogText $fakeHome).Length
        $r = Invoke-Hook 'PS' (CommandFor 'SessionEnd') $payloadFile $badValues[$label][1] (With @{ UM_GIT_BASH = $badValues[$label][0] })
        $logged = (Hook-LogText $fakeHome).Substring($before) -match 'session-end skip=no-git-bash'
        Check (($r.Exit -eq 0) -and ($r.Out.Length -eq 0) -and -not (Test-Path -LiteralPath (Received 'session-end.sh')) -and $logged) "UM_GIT_BASH $label`: exit 0, empty stdout, nothing run, skip=no-git-bash"
    }
    foreach ($value in @($realBash, ('"' + $realBash + '"'), ($realBash -replace '\\', '/'), $innerBash)) {
        Reset 'session-end.sh'
        $r = Invoke-Hook 'PS' (CommandFor 'SessionEnd') $payloadFile $tmp (With @{ UM_GIT_BASH = $value })
        Check ((Ran 'session-end.sh') -and ($r.Exit -eq 0)) "UM_GIT_BASH $value`: runs"
    }

    # 6. Walk-up precedence: a fake Git for Windows layout whose bin\bash.exe and usr\bin\bash.exe
    #    are a marker program (the walk-up only accepts a layout with both). The walk from git.exe
    #    must find it before the registry and ProgramFiles fallbacks, which would find the
    #    machine's real Git. A freshly compiled, unsigned executable cannot run where Device Guard
    #    / Smart App Control enforces (measured on a dev machine 2026-09-22), and that policy judges
    #    each file on its own: the probe runs usr\bin\bash.exe, the copy the fast path starts, and a
    #    run the policy blocks anyway is a SKIP here (on CI, where there is no such policy, a SKIP
    #    fails the job).
    $fakeGit = Join-Path $tmp 'G'
    foreach ($d in @('cmd', 'bin', 'mingw64\bin', 'usr\bin')) { New-Item -ItemType Directory -Path (Join-Path $fakeGit $d) -Force | Out-Null }
    New-MarkerExe (Join-Path $fakeGit 'usr\bin\bash.exe')
    Copy-Item -LiteralPath (Join-Path $fakeGit 'usr\bin\bash.exe') -Destination (Join-Path $fakeGit 'bin\bash.exe')
    foreach ($d in @('cmd', 'mingw64\bin')) { [System.IO.File]::WriteAllBytes((Join-Path $fakeGit "$d\git.exe"), [byte[]]@()) }
    $probe = Join-Path $tmp 'marker-probe.txt'
    $env:MARKER_FILE = $probe
    try { & (Join-Path $fakeGit 'usr\bin\bash.exe') 'probe' 2>$null | Out-Null } catch { }
    Remove-Item Env:\MARKER_FILE
    if (-not (Test-Path -LiteralPath $probe)) {
        Skip 'walk-up precedence (x2) - this machine blocks compiled test executables (Device Guard / Smart App Control)'
    } else {
        foreach ($d in @('cmd', 'mingw64\bin')) {
            $marker = Join-Path $tmp "walk-$($d -replace '\\','-').txt"
            $path = (Join-Path $fakeGit $d) + ';' + $env:SystemRoot + '\System32;' + $env:SystemRoot + '\System32\WindowsPowerShell\v1.0'
            $r = Invoke-Hook 'PS' (CommandFor 'Stop') $payloadFile $tmp (With @{ MARKER_FILE = $marker; PATH = $path })
            if (-not (Test-Path -LiteralPath $marker) -and ($r.Err -match 'Device Guard')) { Skip "walk-up from Git\$d - the policy blocked the marker program this time"; $script:lastErr = ''; continue }
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
    # Git's wrapper ignores a HOMEDRIVE+HOMEPATH naming System32 (a SYSTEM or service context) and
    # takes USERPROFILE, and needs no HOMEDRIVE (git-wrapper.c; review of 2026-09-24). USERPROFILE
    # points at a scratch directory here, so nothing is written to the real profile.
    $profileHome = Join-Path $tmp 'profile home'
    New-Item -ItemType Directory -Path $profileHome -Force | Out-Null
    $sys32 = [Environment]::SystemDirectory
    $sysVars = @{ HOME = $null; HOMEDRIVE = $sys32.Substring(0, 2); HOMEPATH = $sys32.Substring(2); USERPROFILE = $profileHome }
    $r = Invoke-Hook 'CMD' ($launcher + '"absent.sh"') $payloadFile $tmp (With $sysVars)
    Check ((Hook-LogText $profileHome) -match 'absent skip=no-script') 'HOMEDRIVE+HOMEPATH = System32: skip log under USERPROFILE'
    foreach ($case in @(@('HOMEDRIVE+HOMEPATH = System32', $sysVars, $profileHome), @('HOMEPATH without HOMEDRIVE', @{ HOME = $null; HOMEDRIVE = $null; HOMEPATH = $altHome }, $altHome))) {
        Reset 'stop.sh'
        $r = Invoke-Hook 'PS' (CommandFor 'Stop') $payloadFile $tmp (With $case[1])
        $seen = if (Test-Path -LiteralPath (Join-Path $tmp 'home-stop.sh.txt')) { [System.IO.File]::ReadAllText((Join-Path $tmp 'home-stop.sh.txt')).Trim() } else { '' }
        Check (($r.Exit -eq 0) -and ($seen.TrimEnd('\') -ieq $case[2].TrimEnd('\'))) "$($case[0]): the script's HOME is $($case[2]) (saw '$seen')"
    }

    # 8. Long PATH: cmd cannot rewrite a PATH near or past its 8191-character limit, so the launcher
    #    hands such PATHs to Git's own wrapper. The script must run with the full PATH (tail kept).
    #    8170: cmd can still expand it, but a rewrite would pass 8191 characters, where a
    #    %-expanded set fails with "The input line is too long" and a delayed-expansion set silently
    #    does nothing (measured) - the index-7000 guard (RH_P7) hands it to the wrapper, and that
    #    guard is what this case pins. 9000: cmd expands the PATH to nothing (RH_P0 is empty), and
    #    that guard hands it to the wrapper.
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

    # 11. An empty PATH entry (a leading ';' or ';;') or a '.' entry makes cmd's PATH lookup search
    #     the working directory too (measured). A git.exe planted in the session directory, with a
    #     whole fake Git for Windows layout in its parent where the walk-up would look (bin\bash.exe
    #     AND usr\bin\bash.exe, so the walk-up's layout check does not reject it on its own - a
    #     partial decoy let the working-directory drop be deleted unnoticed, caught by a mutation
    #     control on 2026-09-24), must not be taken for Git. The planted bash.exe files are
    #     DIRECTORIES: existence checks accept them and running one fails at once. (An empty file was
    #     held ~3 s by Smart App Control and once hung past the harness timeout - measured - so a
    #     wrong pick must not depend on file contents.)
    $trap = Join-Path $tmp 'trap'
    $sess = Join-Path $trap 'session'
    New-Item -ItemType Directory -Path $sess, (Join-Path $trap 'bin\bash.exe'), (Join-Path $trap 'usr\bin\bash.exe') -Force | Out-Null
    [System.IO.File]::WriteAllBytes((Join-Path $sess 'git.exe'), [byte[]]@())
    $entries = [ordered]@{}
    $entries['a leading ;'] = ';' + $env:PATH
    $entries['an empty ;;'] = $env:SystemRoot + '\System32;;' + $env:PATH
    $entries['a .'] = '.;' + $env:PATH
    foreach ($label in $entries.Keys) {
        foreach ($shape in $shapes) {
            Reset 'stop.sh'
            $r = Invoke-Hook $shape (CommandFor 'Stop') $payloadFile $sess (With @{ PATH = $entries[$label] })
            Check (($r.Exit -eq 0) -and (Ran 'stop.sh')) "PATH with $label entry ($shape): a git.exe in the session directory is not taken for Git"
        }
    }
    # A user variable named CD would shadow the working directory the launcher compares against.
    foreach ($shape in $shapes) {
        Reset 'stop.sh'
        $r = Invoke-Hook $shape (CommandFor 'Stop') $payloadFile $sess (With @{ PATH = $entries['a leading ;']; CD = $tmp })
        Check (($r.Exit -eq 0) -and (Ran 'stop.sh')) "PATH with a leading ; entry and a user variable CD ($shape): the session git.exe is still dropped"
    }

    # 12. A plugin root containing '&' - a Codex home under a profile like Tom&Jerry - spawned as
    #     Codex spawns a hook (codex-rs command_runner.rs build_command: CreateProcess of the shell
    #     with the command as one argument, no outer cmd). The old form cmd /d /c "<root>/..." split
    #     at the '&' and ran <session>\Jerry\.codex\plugins\cache\um\um\1.0.0.cmd (cmd cuts the rest
    #     at the first '/' and tries PATHEXT) in both shapes - measured. Decoys sit there; the real
    #     stub must run instead. Two roots: a space-free one, like a real profile - PowerShell passes
    #     a space-free path unquoted unless the command's own quotes hold a space - and one with
    #     spaces around the '&'. stdin is not compared here: .NET may put a BOM on this pipe.
    $ampBase = Join-Path ([System.IO.Path]::GetTempPath()) ('umamp-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $ampRoots = [ordered]@{}
    $ampRoots['space-free'] = Join-Path $ampBase 'Users\Tom&Jerry\.codex\plugins\cache\um\um\1.0.0'
    $ampRoots['spaced'] = Join-Path $tmp 'Users\Tom & Jerry\.codex\plugins\cache\um\um\1.0.0'
    $ampSess = Join-Path $tmp 'amp session'
    New-Item -ItemType Directory -Path (Join-Path $ampSess 'Jerry\.codex\plugins\cache\um\um') -Force | Out-Null
    foreach ($ext in @('cmd', 'bat')) {
        [System.IO.File]::WriteAllText((Join-Path $ampSess "Jerry\.codex\plugins\cache\um\um\1.0.0.$ext"), "@echo hijack> `"%~dp0decoy.marker`"`r`n")
    }
    try {
        foreach ($label in $ampRoots.Keys) {
            $ampRoot = $ampRoots[$label]
            if ($label -eq 'space-free' -and $ampRoot.Contains(' ')) { Skip "root containing & ($label) - the temp path has a space: $ampBase"; continue }
            New-Item -ItemType Directory -Path (Join-Path $ampRoot 'hooks') -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $fixHooks 'run-hook.cmd'), (Join-Path $fixHooks 'stop.sh') -Destination (Join-Path $ampRoot 'hooks')
            $ampCommand = $hooksJson.hooks.Stop[0].hooks[0].commandWindows.Replace('${CLAUDE_PLUGIN_ROOT}', $ampRoot)
            foreach ($shape in $shapes) {
                Reset 'stop.sh'
                $r = Invoke-Direct $shape $ampCommand $ampSess $base
                $decoys = @(Get-ChildItem -LiteralPath $ampSess -Recurse -Filter 'decoy.marker' -ErrorAction SilentlyContinue)
                Check (($r.Exit -eq 0) -and (Test-Path -LiteralPath (Received 'stop.sh')) -and (Same-Bytes $r.Out $stdoutFixture) -and ($decoys.Count -eq 0)) "$label root containing & ($shape, spawned as Codex does): the real hook runs, no session-directory file"
                $decoys | Remove-Item -Force -ErrorAction SilentlyContinue
            }
        }
    } finally {
        Remove-Item -LiteralPath $ampBase -Recurse -Force -ErrorAction SilentlyContinue
    }

    # 13. A folder named bin that holds git.exe and bash.exe side by side (MSYS2's usr\bin, Cygwin's
    #     bin) ahead of Git on PATH makes the walk-up resolve to that folder itself. It is not a Git
    #     for Windows layout, so it must be passed over and the registry / fixed roots find the real
    #     Git (review of 2026-09-24). The decoy bash.exe is a directory: taking it fails at once.
    $msys = Join-Path $tmp 'msys64'
    New-Item -ItemType Directory -Path (Join-Path $msys 'usr\bin\bash.exe') -Force | Out-Null
    [System.IO.File]::WriteAllBytes((Join-Path $msys 'usr\bin\git.exe'), [byte[]]@())
    foreach ($shape in $shapes) {
        Reset 'stop.sh'
        $r = Invoke-Hook $shape (CommandFor 'Stop') $payloadFile $tmp (With @{ PATH = ((Join-Path $msys 'usr\bin') + ';' + $env:PATH) })
        Check (($r.Exit -eq 0) -and (Ran 'stop.sh')) "git.exe and bash.exe side by side ahead on PATH ($shape): Git for Windows still runs the hook"
    }

    # 14. #329: the hooks' Python must read its stdin as UTF-8 whatever the launching environment
    #     set. Outside UTF-8 mode, Python on Windows decodes a piped stdin with the ANSI code page,
    #     so session-start's json.load(sys.stdin) turned the server's UTF-8 em dash into three
    #     cp1252 characters in every session launched from a plain PowerShell (measured 2026-09-24
    #     with Codex). This checkout's REAL session-start.sh runs through the launcher in the PS
    #     shape with PYTHONUTF8 and PYTHONIOENCODING REMOVED, against a local HTTP server that
    #     answers the probe and serves a state whose body holds an e-acute, an em dash, CJK and an
    #     emoji; the emitted additionalContext must carry that text unchanged. The desktop app's
    #     tool shells export both variables, which hid the bug through 40+ runs: never inherit them.
    $pluginRoot = Split-Path -Parent $here
    $proj = Join-Path $tmp 'proj329'
    $home329 = Join-Path $tmp 'home329'
    New-Item -ItemType Directory -Path (Join-Path $proj '.git'), $home329 -Force | Out-Null
    $serverPy = Join-Path $tmp 'state-server.py'
    $serverLog = Join-Path $tmp 'state-server.log'
    $portFile = Join-Path $tmp 'state-server.port'
    $serverSrc = @'
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

# The state body as UTF-8 bytes: "# State of play <em dash> proj329", a blank line, then
# "caf<e-acute> <CJK sun> <slightly smiling face>". The newlines are JSON escapes.
BODY = b"# State of play \xe2\x80\x94 proj329\\n\\ncaf\xc3\xa9 \xe6\x97\xa5 \xf0\x9f\x99\x82"
LOG, PORT_FILE = sys.argv[1], sys.argv[2]


def log(line):
    with open(LOG, "a", encoding="ascii", errors="replace") as f:
        f.write(line + "\n")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def reply(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        log("POST " + self.path)
        self.reply(400, b'{"error":{"code":"INPUT_INVALID","message":"probe"}}')

    def do_GET(self):
        log("GET " + self.path)
        if not self.path.startswith("/api/state/"):
            self.reply(404, b'{"ok":false}')
            return
        valid_from = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ").encode("ascii")
        self.reply(200, b'{"ok":true,"project":"proj329","state":{"body":"' + BODY
                   + b'","frontmatter":{"valid_from":"' + valid_from + b'"}}}')


server = HTTPServer(("127.0.0.1", 0), Handler)
with open(PORT_FILE, "w") as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
'@
    [System.IO.File]::WriteAllText($serverPy, ($serverSrc -replace "`r`n", "`n"), [System.Text.Encoding]::ASCII)
    $encProbe = Join-Path $tmp 'stdin-encoding.py'
    [System.IO.File]::WriteAllText($encProbe, "import sys`nprint(sys.stdin.encoding)`n", [System.Text.Encoding]::ASCII)
    $payload329 = Join-Path $tmp 'payload329.bin'
    [System.IO.File]::WriteAllBytes($payload329, [System.Text.Encoding]::ASCII.GetBytes('{"hook_event_name":"SessionStart","source":"startup","cwd":"' + ($proj -replace '\\', '\\') + '"}'))
    # The same probe order as um_find_python (a Windows Store python3 stub is on PATH but does not run).
    # -c pass, not -c '': Windows PowerShell 5.1 drops an empty-string argument to a native program.
    $pyCmd = $null
    foreach ($c in @('py', 'python3', 'python')) {
        $found = Get-Command $c -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $found) { continue }
        try { & $found.Source -c 'pass' *> $null; if ($LASTEXITCODE -eq 0) { $pyCmd = $found.Source; break } } catch { }
    }
    if (-not $pyCmd) { Skip '#329 UTF-8 stdin (x2) - no Python here to serve the fixture state' } else {
        $srvPsi = New-Object System.Diagnostics.ProcessStartInfo
        $srvPsi.FileName = $pyCmd
        $srvPsi.Arguments = '"' + $serverPy + '" "' + $serverLog + '" "' + $portFile + '"'
        $srvPsi.UseShellExecute = $false
        $srvPsi.CreateNoWindow = $true
        $srv = [System.Diagnostics.Process]::Start($srvPsi)
        try {
            $port = ''
            for ($i = 0; $i -lt 100 -and -not $port; $i++) {
                Start-Sleep -Milliseconds 100
                if (Test-Path -LiteralPath $portFile) { $port = [System.IO.File]::ReadAllText($portFile).Trim() }
            }
            if (-not $port) { throw 'the fixture state server did not start' }
            $vars329 = With @{ PYTHONUTF8 = $null; PYTHONIOENCODING = $null; HOME = $home329; UM_SERVER_URL = "http://127.0.0.1:$port"
                               CLAUDE_PLUGIN_ROOT = $pluginRoot; UM_PROBE_CACHE_MIN = '0'; UM_TOKEN_FILE = $null }
            # What this machine's Python does with a redirected stdin when both variables are absent.
            # The case discriminates only while that is not utf-8: Python's default outside UTF-8 mode
            # is the ANSI code page, and a Python whose default became UTF-8 mode would pass on its own.
            $enc = Invoke-Hook 'CMD' ('"' + $pyCmd + '" "' + $encProbe + '"') $payload329 $tmp $vars329
            Write-Output ('NOTE: with PYTHONUTF8 and PYTHONIOENCODING removed, ' + $pyCmd + ' reads a redirected stdin as ' + ([System.Text.Encoding]::ASCII.GetString($enc.Out).Trim()) + ' (the #329 case discriminates only while that is not utf-8)')
            $r = Invoke-Hook 'PS' (CommandFor 'SessionStart' $pluginRoot) $payload329 $proj $vars329
            $served = if (Test-Path -LiteralPath $serverLog) { ([System.IO.File]::ReadAllText($serverLog) -replace '\s+', ' ').Trim() } else { '' }
            Check (($r.Exit -eq 0) -and ($served -match 'POST /api/append-turn') -and ($served -match 'GET /api/state/proj329')) "#329 the real session-start.sh through the launcher: exit 0, probe and state fetch reached the fixture server (served: $served)"
            $ctx = ''
            try { $ctx = ([System.Text.Encoding]::UTF8.GetString($r.Out) | ConvertFrom-Json).hookSpecificOutput.additionalContext } catch { $ctx = '' }
            if ($null -eq $ctx) { $ctx = '' }
            $wantTitle = $utf8.GetString((Join-Bytes @('State of play ', [byte[]](0xE2, 0x80, 0x94), ' proj329')))
            $wantLine = $utf8.GetString((Join-Bytes @('caf', [byte[]](0xC3, 0xA9), ' ', [byte[]](0xE6, 0x97, 0xA5), ' ', [byte[]](0xF0, 0x9F, 0x99, 0x82))))
            $at = $ctx.IndexOf('State of play')
            $seen = if ($at -ge 0) { $ctx.Substring($at, [Math]::Min(26, $ctx.Length - $at)) } else { $ctx.Substring(0, [Math]::Min(26, $ctx.Length)) }
            $seenCps = ($seen.ToCharArray() | ForEach-Object { '{0:X4}' -f [int]$_ }) -join ' '
            Check ($ctx.Contains($wantTitle) -and $ctx.Contains($wantLine)) "#329 PYTHONUTF8 and PYTHONIOENCODING removed: additionalContext carries the state's UTF-8 text unchanged (saw code points: $seenCps)"
            # Independent of the Python version (the check above discriminates only while the runner's
            # Python defaults to the ANSI code page): sourcing the lib with both variables removed must
            # hand the interpreter um_find_python picks PYTHONUTF8=1, PYTHONIOENCODING=utf-8 and UTF-8 mode.
            $modeSh = Join-Path $tmp 'utf8-mode.sh'
            $modePy = Join-Path $tmp 'utf8-mode.py'
            [System.IO.File]::WriteAllText($modePy, "import os, sys`nprint(os.environ.get('PYTHONUTF8', '-'), os.environ.get('PYTHONIOENCODING', '-'), sys.flags.utf8_mode)`n", [System.Text.Encoding]::ASCII)
            [System.IO.File]::WriteAllText($modeSh, "source '$umApi' || exit 3`nPY=`$(um_find_python) || exit 4`n`"`$PY`" '$($modePy -replace '\\', '/')'`n", [System.Text.Encoding]::ASCII)
            $mode = Invoke-Hook 'CMD' ('"' + $gitBash + '" "' + $modeSh + '"') $payload329 $tmp $vars329
            $modeOut = [System.Text.Encoding]::ASCII.GetString($mode.Out).Trim()
            Check ($modeOut -eq '1 utf-8 1') "#329 sourcing lib/um-api.sh with both variables removed gives the interpreter PYTHONUTF8=1, PYTHONIOENCODING=utf-8 and UTF-8 mode (saw '$modeOut', exit $($mode.Exit))"
        } finally {
            try { $srv.Kill(); [void]$srv.WaitForExit(5000) } catch { }
        }
    }
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    if ($cp0) { try { & $env:ComSpec /d /c "chcp $cp0 >nul" } catch { } }
}

if ($script:failures -gt 0) { Write-Output "$($script:failures) FAILED"; exit 1 }
Write-Output 'ALL PASS'
exit 0
