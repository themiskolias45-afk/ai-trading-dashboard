"""
JARVIS Voice Interface
Speak to JARVIS, get spoken responses. Hands-free trading.

Requirements (one-time install):
  pip install openai-whisper sounddevice scipy pyttsx3

Usage:
  python voice.py             # listen once, respond, exit
  python voice.py --loop      # continuous listen mode
  python voice.py --tts "hello"  # just speak text (test TTS)

Hotword: say "JARVIS" to wake, then your command.
"""
import sys
import os
import subprocess
import json
import time
import tempfile
from pathlib import Path

try:
    import urllib.request
    import urllib.error
except ImportError:
    pass

JARVIS_API_URL = "http://localhost:3001/api/chat"
SAMPLE_RATE = 16000
RECORD_SECONDS = 5


def record_audio(seconds=5, sample_rate=16000):
    """Record audio from microphone. Returns path to temp WAV file."""
    try:
        import sounddevice as sd
    except ImportError:
        print("sounddevice not installed. Run: pip install sounddevice")
        return None

    try:
        from scipy.io.wavfile import write as wav_write
    except ImportError:
        print("scipy not installed. Run: pip install scipy")
        return None

    try:
        import numpy as np
    except ImportError:
        print("numpy not installed. Run: pip install numpy")
        return None

    print(f"Listening for {seconds}s...")

    try:
        audio_data = sd.rec(
            int(seconds * sample_rate),
            samplerate=sample_rate,
            channels=1,
            dtype="int16"
        )
        sd.wait()
    except Exception as exc:
        print(f"Recording failed: {exc}")
        return None

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp_path = tmp.name
    tmp.close()

    try:
        wav_write(tmp_path, sample_rate, audio_data)
    except Exception as exc:
        print(f"Failed to write WAV: {exc}")
        return None

    return tmp_path


def transcribe(audio_file):
    """Transcribe audio file using Whisper. Returns text string."""
    if audio_file is None:
        return ""

    try:
        import whisper
    except ImportError:
        print("whisper not installed. Run: pip install openai-whisper")
        return ""

    try:
        model = whisper.load_model("base")
        result = model.transcribe(audio_file)
        text = result.get("text", "").strip()
        return text
    except Exception as exc:
        print(f"Transcription failed: {exc}")
        return ""
    finally:
        try:
            os.unlink(audio_file)
        except OSError:
            pass


def speak(text):
    """Speak text via pyttsx3. Always prints text even if TTS fails."""
    print(f"JARVIS: {text}")

    try:
        import pyttsx3
    except ImportError:
        print("(TTS unavailable — install pyttsx3: pip install pyttsx3)")
        return

    try:
        engine = pyttsx3.init()
        voices = engine.getProperty("voices")
        # Prefer a clear voice if multiple are available
        if voices:
            engine.setProperty("voice", voices[0].id)
        engine.setProperty("rate", 175)
        engine.setProperty("volume", 1.0)
        engine.say(text)
        engine.runAndWait()
        engine.stop()
    except Exception as exc:
        print(f"(TTS error: {exc})")


def ask_jarvis(question):
    """POST question to JARVIS API. Returns response text string."""
    if not question or not question.strip():
        return "No command received."

    payload = json.dumps({"message": question}).encode("utf-8")
    req = urllib.request.Request(
        JARVIS_API_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            data = json.loads(raw)
            # Accept common response shapes
            if isinstance(data, dict):
                for key in ("response", "message", "reply", "text", "content"):
                    if key in data and data[key]:
                        return str(data[key])
                # Last resort: dump the whole dict
                return raw
            return str(data)
    except urllib.error.URLError as exc:
        if "Connection refused" in str(exc) or "timed out" in str(exc).lower():
            return "JARVIS server is offline. Start it with option S in tasks/menu.bat."
        return f"API error: {exc}"
    except json.JSONDecodeError:
        return "Invalid response from server."
    except Exception as exc:
        return f"Request failed: {exc}"


def listen_and_respond():
    """Record, transcribe, detect hotword, query JARVIS, speak response."""
    audio_path = record_audio(seconds=RECORD_SECONDS, sample_rate=SAMPLE_RATE)
    transcript = transcribe(audio_path)

    if not transcript:
        print("(No speech detected)")
        return

    print(f"Heard: {transcript}")

    lower = transcript.lower()
    if "jarvis" not in lower:
        print("(Hotword 'JARVIS' not detected — ignoring)")
        return

    # Extract everything after the first occurrence of "jarvis"
    jarvis_index = lower.find("jarvis")
    command = transcript[jarvis_index + len("jarvis"):].strip(" ,.")

    if not command:
        speak("Yes? Say your command after 'JARVIS'.")
        return

    print(f"Command: {command}")
    response = ask_jarvis(command)

    # Keep spoken response short — truncate at 50 words
    words = response.split()
    if len(words) > 50:
        response_spoken = " ".join(words[:50]) + "..."
    else:
        response_spoken = response

    speak(response_spoken)


def main():
    args = sys.argv[1:]

    if "--tts" in args:
        idx = args.index("--tts")
        if idx + 1 < len(args):
            speak(args[idx + 1])
        else:
            print("Usage: python voice.py --tts \"text to speak\"")
        return

    if "--loop" in args:
        print("JARVIS voice loop active. Say 'JARVIS <command>'. Ctrl+C to stop.")
        try:
            while True:
                listen_and_respond()
                time.sleep(0.5)
        except KeyboardInterrupt:
            print("\nVoice loop stopped.")
        return

    # Single-shot mode
    listen_and_respond()


if __name__ == "__main__":
    main()
