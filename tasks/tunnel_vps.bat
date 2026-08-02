@echo off
title SmartEntry VPS Tunnel
REM ---------------------------------------------------------------------------
REM Serves the VPS dashboard on http://localhost:3002 so the browser treats it
REM as a secure origin.
REM
REM Why this exists: Chrome grants microphone access only to "potentially
REM trustworthy" origins - HTTPS, or anything on localhost. Opened directly at
REM http://169.58.74.133:3001 the JARVIS page has no navigator.mediaDevices at
REM all and SpeechRecognition.start() fails with 'not-allowed', so voice input is
REM impossible there no matter what the page does. Voice worked before the move
REM to the VPS because the dashboard was being served from localhost.
REM
REM Forwarding the VPS's port 3001 to a local port puts the exact same VPS server
REM back behind a localhost URL, which Chrome trusts. No HTTPS cert, no tunnel
REM service, no browser flags.
REM
REM Local port is 3002, not 3001, because the local machine runs its own
REM SmartEntry server on 3001. Any localhost port is trusted, so 3002 is fine.
REM
REM   VPS dashboard (voice works) -> http://localhost:3002
REM   Local dashboard             -> http://localhost:3001
REM ---------------------------------------------------------------------------

set KEY=C:\Users\User\.ssh\contabo_smartentry
set VPS=administrator@169.58.74.133
set LOCAL_PORT=3002
set REMOTE_PORT=3001

REM The arrow must be escaped: cmd reads a bare > as a redirect, so this line used
REM to create a 45-byte file literally named "VPS" in the project root on every
REM tunnel start instead of printing anything.
echo Forwarding localhost:%LOCAL_PORT%  -^>  VPS localhost:%REMOTE_PORT%
echo Open http://localhost:%LOCAL_PORT%/dashboard/jarvis.html
echo Leave this window open. Close it to stop the tunnel.
echo.

:loop
REM ExitOnForwardFailure makes ssh fail loudly if the local port is already taken
REM instead of connecting and silently forwarding nothing. ServerAlive* drops a
REM dead link within ~45s so the reconnect below actually fires on a network
REM blip rather than hanging on a half-open socket forever.
ssh -i "%KEY%" -N ^
    -o ExitOnForwardFailure=yes ^
    -o ServerAliveInterval=15 ^
    -o ServerAliveCountMax=3 ^
    -o ConnectTimeout=15 ^
    -L %LOCAL_PORT%:localhost:%REMOTE_PORT% %VPS%

echo [%date% %time%] Tunnel dropped - reconnecting in 10s...
timeout /t 10 /nobreak >nul
goto loop
