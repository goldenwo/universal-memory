@echo off
rem hooks/run-hook.cmd - Windows launcher for this plugin's hooks under Codex (#313).
rem
rem Why: on Windows Codex runs a hook through cmd.exe /C in the environment of the shell
rem that launched Codex, with the session directory as working directory (openai/codex
rem codex-rs/hooks/src/engine/command_runner.rs). A bare bash there resolves to
rem C:\Windows\System32\bash.exe, the WSL launcher, which exits 1 before any script runs
rem when no WSL distro provides /bin/bash. hooks.json's commandWindows calls this file by
rem its absolute path instead; it finds Git Bash itself and runs the script that the
rem POSIX command runs.
rem
rem Why a batch file: it runs inside the cmd.exe that Codex already started, so it adds no
rem interpreter start to SessionEnd's one-second budget (codex-rs/hooks/src/events/
rem session_end.rs), and bash inherits Codex's stdin, stdout and stderr untouched: no
rem re-encoding, no byte-order mark.
rem
rem TRUST: Codex hashes the commandWindows string for hook trust, not this file. Change
rem this file freely; changing that string makes every Windows user re-approve the hooks.
rem
rem Editing rules: keep every path expansion inside quotes (paths may contain ampersands
rem and parentheses), never wrap path expansions in parenthesized blocks, call external
rem programs by absolute path (cmd searches the working directory first), never echo, and
rem keep delayed expansion off. Fail open: every skip logs one line to ~/.um/hook.log,
rem writes nothing to stdout (Codex hands SessionStart stdout to the model) and exits 0.
setlocal EnableExtensions DisableDelayedExpansion

rem The home Git Bash would use, derived the way Git's own bin\bash.exe wrapper does: HOME,
rem else HOMEDRIVE plus HOMEPATH when that directory exists, else USERPROFILE.
set "UM_HOME=%HOME%"
if not defined UM_HOME if defined HOMEDRIVE if defined HOMEPATH if exist "%HOMEDRIVE%%HOMEPATH%\" set "UM_HOME=%HOMEDRIVE%%HOMEPATH%"
if not defined UM_HOME set "UM_HOME=%USERPROFILE%"

rem --- 1. The argument must be a bare *.sh name that exists next to this file.
set "UM_S=%~1"
if not defined UM_S goto skip_unknown
if /i not "%UM_S:~-3%"==".sh" goto skip_unknown
if not "%UM_S:\=%"=="%UM_S%" goto skip_unknown
if not "%UM_S:/=%"=="%UM_S%" goto skip_unknown
if not "%UM_S::=%"=="%UM_S%" goto skip_unknown
if not "%UM_S:..=%"=="%UM_S%" goto skip_unknown
set "UM_SCRIPT="
rem A wildcard name matches real files whose names differ from it, so it never passes.
for %%F in ("%~dp0%UM_S%") do if exist "%%~fF" if /i "%%~nxF"=="%UM_S%" set "UM_SCRIPT=%%~fF"
if not defined UM_SCRIPT goto skip_noscript

rem --- 2. Find Git Bash. UM_GIT_BASH, when set, is the only candidate.
set "UM_BASH="
if not defined UM_GIT_BASH goto find_on_path
if exist "%UM_GIT_BASH%" set "UM_BASH=%UM_GIT_BASH%"
goto check_bash

:find_on_path
rem The PATH modifier searches PATH only, never the working directory. Walk up from
rem git.exe (Git\cmd, Git\bin or Git\mingw64\bin) to the directory holding bin\bash.exe.
set "UM_GITEXE="
for %%I in (git.exe) do set "UM_GITEXE=%%~$PATH:I"
if not defined UM_GITEXE goto find_in_registry
for %%D in ("%UM_GITEXE%\..\..") do if exist "%%~fD\bin\bash.exe" set "UM_BASH=%%~fD\bin\bash.exe"
if defined UM_BASH goto check_bash
for %%D in ("%UM_GITEXE%\..\..\..") do if exist "%%~fD\bin\bash.exe" set "UM_BASH=%%~fD\bin\bash.exe"
if defined UM_BASH goto check_bash

:find_in_registry
for %%K in (HKLM HKCU) do if not defined UM_BASH for /f "tokens=2,*" %%A in ('%SystemRoot%\System32\reg.exe query "%%K\SOFTWARE\GitForWindows" /v InstallPath 2^>nul') do if exist "%%B\bin\bash.exe" set "UM_BASH=%%B\bin\bash.exe"
if defined UM_BASH goto check_bash
for %%R in ("%ProgramFiles%" "%ProgramFiles(x86)%" "%LOCALAPPDATA%\Programs") do if not defined UM_BASH if exist "%%~R\Git\bin\bash.exe" set "UM_BASH=%%~R\Git\bin\bash.exe"

:check_bash
if not defined UM_BASH goto skip_nobash

rem --- 3. Run the script. No redirection: bash reads and writes Codex's own handles.
rem Git's bin\bash.exe is a wrapper that sets PATH (mingw64\bin and usr\bin first), MSYSTEM
rem and HOME, then starts usr\bin\bash.exe as a second process. Doing the same setup here and
rem starting usr\bin\bash.exe directly keeps that extra process out of SessionEnd's budget.
rem Anything else (an UM_GIT_BASH that is not a Git for Windows bin\bash.exe) runs as given.
set "UM_SCRIPT=%UM_SCRIPT:\=/%"
set "UM_GITROOT="
for %%G in ("%UM_BASH%\..\..") do set "UM_GITROOT=%%~fG"
if not exist "%UM_GITROOT%\usr\bin\bash.exe" goto run_as_given
if not exist "%UM_GITROOT%\mingw64\bin\" goto run_as_given
set "PATH=%UM_GITROOT%\mingw64\bin;%UM_GITROOT%\usr\bin;%PATH%"
if not defined MSYSTEM set "MSYSTEM=MINGW64"
if not defined HOME set "HOME=%UM_HOME%"
"%UM_GITROOT%\usr\bin\bash.exe" "%UM_SCRIPT%"
exit /b %ERRORLEVEL%
:run_as_given
"%UM_BASH%" "%UM_SCRIPT%"
exit /b %ERRORLEVEL%

rem --- 4. Fail open.
:skip_unknown
set "UM_SKIP=unknown-script"
goto log_skip
:skip_noscript
set "UM_SKIP=no-script"
goto log_skip
:skip_nobash
set "UM_SKIP=no-git-bash"
:log_skip
rem Log under the home Git Bash would use (UM_HOME, above). PowerShell only starts on this
rem path, where the capture is already lost, to get a locale-independent timestamp.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$h = 'run-hook'; if ($env:UM_SKIP -ne 'unknown-script') { $h = [IO.Path]::GetFileNameWithoutExtension($env:UM_S) }; $d = Join-Path $env:UM_HOME '.um'; [void][IO.Directory]::CreateDirectory($d); [IO.File]::AppendAllText((Join-Path $d 'hook.log'), ((Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') + ' ' + $h + ' skip=' + $env:UM_SKIP + [char]10), (New-Object Text.UTF8Encoding($false)))" <nul >nul 2>nul
exit /b 0
