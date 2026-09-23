@echo off
rem hooks/run-hook.cmd - Windows launcher for this plugin's hooks under Codex (#313).
rem
rem Why: Codex runs a Windows hook through the session shell (measured with codex-cli
rem 0.155.1: powershell.exe -NoProfile -Command, or pwsh when installed; cmd.exe /C only
rem when a session has no shell), resolving a bare bash from the PATH of whatever launched
rem Codex. From PowerShell or cmd that is C:\Windows\System32\bash.exe, the WSL launcher,
rem which exits 1 before any script runs when no WSL distro provides /bin/bash. hooks.json's
rem commandWindows runs this file through cmd /d /c instead; it finds Git Bash itself and
rem runs the script that the POSIX command runs.
rem
rem Bytes: bash inherits Codex's stdin, stdout and stderr untouched, with no re-encoding and
rem no byte-order mark, because nothing here redirects them.
rem
rem TRUST: Codex hashes the commandWindows string for hook trust, not this file. Change this
rem file freely; changing that string makes every Windows user re-approve the hooks.
rem
rem Editing rules: keep every path expansion inside quotes (paths may contain ampersands and
rem parentheses), never wrap path expansions in parenthesized blocks, call external programs
rem by absolute path (cmd searches the working directory first), never echo, keep delayed
rem expansion off except on the run lines (which expand PATH and paths as data), and keep
rem internal names out of the plugin's UM_ configuration namespace. Fail open: every skip
rem logs one line to ~/.um/hook.log, writes nothing to stdout (Codex hands SessionStart
rem stdout to the model) and exits 0.
setlocal EnableExtensions DisableDelayedExpansion

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

rem --- 2. Find Git Bash. UM_GIT_BASH, when set, is the only candidate: an absolute path (drive
rem or UNC) to an existing file; anything else fails open as skip=no-git-bash.
set "RH_BASH="
if not defined UM_GIT_BASH goto find_on_path
set "RH_GB=%UM_GIT_BASH%"
if not "%RH_GB:~1,1%"==":" if not "%RH_GB:~0,2%"=="\\" goto check_bash
if exist "%RH_GB%\" goto check_bash
if exist "%RH_GB%" set "RH_BASH=%RH_GB%"
goto check_bash

:find_on_path
rem The PATH modifier searches PATH only, never the working directory. Two fixed ancestor
rem checks from git.exe cover Git\cmd, Git\bin and Git\mingw64\bin.
set "RH_GITEXE="
for %%I in (git.exe) do set "RH_GITEXE=%%~$PATH:I"
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
rem install, or when PATH is longer than cmd can expand (8191 characters). The rewrite uses
rem delayed expansion, which also keeps it clear of cmd's 8191-character line limit.
set "RH_SCRIPT=%RH_SCRIPT:\=/%"
set "RH_GITROOT="
for %%G in ("%RH_BASH%\..\..") do set "RH_GITROOT=%%~fG"
if not exist "%RH_GITROOT%\usr\bin\bash.exe" goto run_as_given
if not exist "%RH_GITROOT%\mingw64\bin\" goto run_as_given
set "RH_P0=%PATH:~0,1%"
if defined PATH if not defined RH_P0 goto run_as_given
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
rem path, where the capture is already lost, to get a locale-independent timestamp.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$h = 'run-hook'; if ($env:RH_SKIP -ne 'unknown-script') { $h = [IO.Path]::GetFileNameWithoutExtension($env:RH_S) }; $d = Join-Path $env:RH_HOME '.um'; [void][IO.Directory]::CreateDirectory($d); [IO.File]::AppendAllText((Join-Path $d 'hook.log'), ((Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') + ' ' + $h + ' skip=' + $env:RH_SKIP + [char]10), (New-Object Text.UTF8Encoding($false)))" <nul >nul 2>nul
exit /b 0
