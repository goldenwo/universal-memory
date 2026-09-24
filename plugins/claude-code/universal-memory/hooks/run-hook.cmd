@echo off
rem hooks/run-hook.cmd - Windows launcher for this plugin's hooks under Codex (#313).
rem
rem Why: Codex runs a Windows hook through the session shell (measured with codex-cli
rem 0.155.1: powershell.exe -NoProfile -Command, or pwsh when installed; cmd.exe /C only
rem when a session has no shell), resolving a bare bash from the PATH of whatever launched
rem Codex. From PowerShell or cmd that is C:\Windows\System32\bash.exe, the WSL launcher,
rem which exits 1 before any script runs when no WSL distro provides /bin/bash. hooks.json's
rem commandWindows runs this file instead, as cmd /d /c call "<root>/hooks/run-hook.cmd " x.sh:
rem the word before the quote stops cmd stripping the quotes, and the space inside them makes
rem PowerShell pass the path quoted, so a root containing & stays one path (measured: without
rem both, cmd split the string at the & and ran a same-named file from the session directory).
rem /d skips any cmd AutoRun the user configured, which could otherwise print into
rem SessionStart's stdout. This file finds Git Bash itself and runs the script that the
rem POSIX command runs.
rem
rem Bytes: bash inherits Codex's stdin, stdout and stderr untouched, with no re-encoding and
rem no byte-order mark, because nothing here redirects them.
rem
rem TRUST: Codex hashes the commandWindows string for hook trust, not this file. Change this
rem file freely; changing that string makes every Windows user re-approve the hooks. The
rem string assumes a PowerShell or cmd session shell (measured): Git Bash as the session
rem shell would rewrite its /d /c as paths, and cmd would then read the hook input as commands.
rem
rem Editing rules: keep every path expansion inside quotes (paths may contain ampersands and
rem parentheses), never wrap path expansions in parenthesized blocks, call external programs
rem by absolute path (cmd searches the working directory first), never echo, keep delayed
rem expansion off except on the run lines (which expand PATH and paths as data), and keep
rem internal names out of the plugin's UM_ configuration namespace. Fail open: every skip
rem logs one line to ~/.um/hook.log, writes nothing to stdout (Codex hands SessionStart
rem stdout to the model) and exits 0.
setlocal EnableExtensions DisableDelayedExpansion
rem A user variable named CD or ERRORLEVEL would stand in for cmd's dynamic values used below.
set "CD="
set "ERRORLEVEL="

rem The home Git Bash would use, derived the way Git's own bin\bash.exe wrapper does: HOME,
rem else HOMEDRIVE plus HOMEPATH when that directory exists, else USERPROFILE.
set "RH_HOME=%HOME%"
if not defined RH_HOME if defined HOMEDRIVE if defined HOMEPATH if exist "%HOMEDRIVE%%HOMEPATH%\" set "RH_HOME=%HOMEDRIVE%%HOMEPATH%"
if not defined RH_HOME set "RH_HOME=%USERPROFILE%"

rem --- 1. The argument must be a bare *.sh name that exists next to this file.
set "RH_S=%~1"
if not defined RH_S goto skip_unknown
if /i not "%RH_S:~-3%"==".sh" goto skip_unknown
if not "%RH_S:\=%"=="%RH_S%" goto skip_unknown
if not "%RH_S:/=%"=="%RH_S%" goto skip_unknown
if not "%RH_S::=%"=="%RH_S%" goto skip_unknown
if not "%RH_S:..=%"=="%RH_S%" goto skip_unknown
set "RH_SCRIPT="
rem A wildcard name matches real files whose names differ from it, so it never passes.
for %%F in ("%~dp0%RH_S%") do if exist "%%~fF" if /i "%%~nxF"=="%RH_S%" set "RH_SCRIPT=%%~fF"
if not defined RH_SCRIPT goto skip_noscript

rem --- 2. Find Git Bash. UM_GIT_BASH, when set, is the only candidate: an absolute path (X:\,
rem X:/ or UNC; surrounding quotes are dropped) to an existing file; anything else fails open
rem as skip=no-git-bash.
set "RH_BASH="
if not defined UM_GIT_BASH goto find_on_path
set "RH_GB=%UM_GIT_BASH:"=%"
if not defined RH_GB goto check_bash
if not "%RH_GB:~1,2%"==":\" if not "%RH_GB:~1,2%"==":/" if not "%RH_GB:~0,2%"=="\\" goto check_bash
if exist "%RH_GB%\" goto check_bash
if exist "%RH_GB%" set "RH_BASH=%RH_GB%"
goto check_bash

:find_on_path
rem The PATH modifier also searches the working directory when PATH has an empty entry (a
rem leading ";" or ";;") or a "." entry (measured), so a git.exe found there is dropped. Two
rem fixed ancestor checks from git.exe cover Git\cmd, Git\bin and Git\mingw64\bin.
set "RH_GITEXE="
for %%I in (git.exe) do set "RH_GITEXE=%%~$PATH:I"
if defined RH_GITEXE for %%F in ("%RH_GITEXE%\..") do if /i "%%~fF"=="%CD%" set "RH_GITEXE="
if not defined RH_GITEXE goto find_in_registry
for %%D in ("%RH_GITEXE%\..\..") do if exist "%%~fD\bin\bash.exe" set "RH_BASH=%%~fD\bin\bash.exe"
if defined RH_BASH goto check_bash
for %%D in ("%RH_GITEXE%\..\..\..") do if exist "%%~fD\bin\bash.exe" set "RH_BASH=%%~fD\bin\bash.exe"
if defined RH_BASH goto check_bash

:find_in_registry
for %%K in (HKLM HKCU) do if not defined RH_BASH for /f "tokens=2,*" %%A in ('%SystemRoot%\System32\reg.exe query "%%K\SOFTWARE\GitForWindows" /v InstallPath 2^>nul') do if exist "%%B\bin\bash.exe" set "RH_BASH=%%B\bin\bash.exe"
if defined RH_BASH goto check_bash
for %%R in ("%ProgramFiles%" "%ProgramFiles(x86)%" "%LOCALAPPDATA%\Programs") do if not defined RH_BASH if exist "%%~R\Git\bin\bash.exe" set "RH_BASH=%%~R\Git\bin\bash.exe"

:check_bash
if not defined RH_BASH goto skip_nobash

rem --- 3. Run the script. No redirection: bash reads and writes Codex's own handles.
rem Git's bin\bash.exe is a wrapper that puts mingw64\bin and usr\bin first on PATH, sets
rem MSYSTEM and HOME, then starts usr\bin\bash.exe as a second process. The fast path does
rem that setup here and starts usr\bin\bash.exe directly, keeping the extra process out of
rem SessionEnd's one-second budget. Deliberately not replicated, inert for these hooks:
rem PLINK_PROTOCOL, EXEPATH, the ~/bin PATH entry and git-bash.config MSYS= lines.
rem The wrapper itself runs instead (as given) when the layout is not a Git for Windows
rem install, or when PATH has a character at index 7000: cmd cannot expand a variable past
rem 8191 characters, and a set whose value would pass that limit silently does nothing
rem (measured), which would start bash without Git's tool directories.
set "RH_SCRIPT=%RH_SCRIPT:\=/%"
set "RH_GITROOT="
for %%G in ("%RH_BASH%\..\..") do set "RH_GITROOT=%%~fG"
if not exist "%RH_GITROOT%\usr\bin\bash.exe" goto run_as_given
if not exist "%RH_GITROOT%\mingw64\bin\" goto run_as_given
set "RH_P0=%PATH:~0,1%"
set "RH_P7=%PATH:~7000,1%"
if defined PATH if not defined RH_P0 goto run_as_given
if defined RH_P7 goto run_as_given
setlocal EnableDelayedExpansion
set "PATH=!RH_GITROOT!\mingw64\bin;!RH_GITROOT!\usr\bin;!PATH!"
set "MSYSTEM=MINGW64"
if not defined HOME set "HOME=!RH_HOME!"
"!RH_GITROOT!\usr\bin\bash.exe" "!RH_SCRIPT!"
exit /b !ERRORLEVEL!
:run_as_given
setlocal EnableDelayedExpansion
"!RH_BASH!" "!RH_SCRIPT!"
exit /b !ERRORLEVEL!

rem --- 4. Fail open.
:skip_unknown
set "RH_SKIP=unknown-script"
goto log_skip
:skip_noscript
set "RH_SKIP=no-script"
goto log_skip
:skip_nobash
set "RH_SKIP=no-git-bash"
:log_skip
rem Log under the home Git Bash would use (RH_HOME, above). PowerShell only starts on this
rem path, where the capture is already lost. The timestamp uses the invariant culture: in a
rem .NET format string ":" is the regional time separator ("." under fi-FI, measured).
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$h = 'run-hook'; if ($env:RH_SKIP -ne 'unknown-script') { $h = [IO.Path]::GetFileNameWithoutExtension($env:RH_S) }; $d = Join-Path $env:RH_HOME '.um'; [void][IO.Directory]::CreateDirectory($d); [IO.File]::AppendAllText((Join-Path $d 'hook.log'), ([DateTime]::Now.ToString('yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture) + ' ' + $h + ' skip=' + $env:RH_SKIP + [char]10), (New-Object Text.UTF8Encoding($false)))" <nul >nul 2>nul
exit /b 0
