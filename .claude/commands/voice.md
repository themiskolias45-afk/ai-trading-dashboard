Start or test the voice interface. Usage: /voice [start|stop|test]

$ARGUMENTS: start, stop, or test. If empty → test.

The voice module listens for spoken commands and reads signal output aloud.
Requires: microphone access, Windows TTS, and the server running on port 3001.

═══ /voice test ═══
  Run: python voice.py --test
  Confirms: microphone detected, TTS working, server reachable.
  Output: PASS or FAIL with specific component that failed.

═══ /voice start ═══
  Run: python voice.py --loop
  Starts the continuous voice loop — listens for wake word, reads signals aloud.
  Runs in the background (detached process).
  Confirm with: "Voice interface started. Listening for wake word."

═══ /voice stop ═══
  Find and stop the voice.py process.
  Run: taskkill /F /IM python.exe /FI "WINDOWTITLE eq voice*"
  Or: Get-Process python | Where-Object { $_.CommandLine -like '*voice.py*' } | Stop-Process

═══ TROUBLESHOOTING ═══
  - Microphone not detected → check Windows sound settings, default recording device
  - TTS not working → check Windows Speech settings
  - Server not reachable → run /health first, ensure server is on port 3001
  - Voice not responding → restart with /voice stop then /voice start
