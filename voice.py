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
SAMPLE_RATE    = 16000
RECORD_SECONDS = 8     # wider window — gives more time to speak
WHISPER_MODEL  = "base"
MIN_AMPLITUDE  = 150   # int16 threshold; below = silence (mic not picking up)
BOOST_FACTOR   = 3.0   # amplify quiet audio by this factor when --boost is set


def list_devices():
    """Print available audio input devices and exit."""
    try:
        import sounddevice as sd
    except ImportError:
        print("sounddevice not installed. Run: pip install sounddevice")
        return
    devices = sd.query_devices()
    print("\nAvailable audio devices:")
    print("-" * 60)
    for i, d in enumerate(devices):
        marker = " <-- DEFAULT INPUT" if i == sd.default.device[0] else ""
        if d["max_input_channels"] > 0:
            print(f"  [{i}] {d['name']}{marker}")
    print("\nUse:  python voice.py --device N  to select a specific mic")
    print("      python voice.py --device N --loop  for continuous mode\n")


def record_audio(seconds=RECORD_SECONDS, sample_rate=SAMPLE_RATE,
                 device=None, boost=False):
    """Record from mic. Returns (path_to_wav, peak_amplitude)."""
    try:
        import sounddevice as sd
    except ImportError:
        print("sounddevice not installed. Run: pip install sounddevice")
        return None, 0

    try:
        from scipy.io.wavfile import write as wav_write
    except ImportError:
        print("scipy not installed. Run: pip install scipy")
        return None, 0

    try:
        import numpy as np
    except ImportError:
        print("numpy not installed. Run: pip install numpy")
        return None, 0

    # Show which device is in use
    dev_info = sd.query_devices(device, "input") if device is not None else sd.query_devices(sd.default.device[0], "input")
    print(f"Listening ({seconds}s) via [{dev_info['name']}] ...")

    try:
        audio_data = sd.rec(
            int(seconds * sample_rate),
            samplerate=sample_rate,
            channels=1,
            dtype="int16",
            device=device,
        )
        sd.wait()
    except Exception as exc:
        print(f"Recording failed: {exc}")
        print("  Try:  python voice.py --list-devices   then  --device N")
        return None, 0

    peak = int(np.abs(audio_data).max())
    print(f"  Peak level: {peak}  (min to transcribe: {MIN_AMPLITUDE})")

    if peak < MIN_AMPLITUDE:
        print("  ⚠ Audio too quiet — mic may be muted, wrong device, or volume too low.")
        print("  → Run: python voice.py --list-devices   then pick a device with --device N")
        print("  → Or use --boost to amplify weak input.")
        return None, peak

    if boost and peak > 0:
        scale = min(BOOST_FACTOR, 32767 / peak)
        audio_data = (audio_data.astype("float32") * scale).clip(-32768, 32767).astype("int16")
        print(f"  Boost applied ({scale:.1f}x)")

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp_path = tmp.name
    tmp.close()

    try:
        wav_write(tmp_path, sample_rate, audio_data)
    except Exception as exc:
        print(f"Failed to write WAV: {exc}")
        return None, peak

    return tmp_path, peak


def transcribe(audio_file, model_size=WHISPER_MODEL):
    """Transcribe audio file using Whisper. Returns text string."""
    if audio_file is None:
        return ""

    try:
        import whisper
    except ImportError:
        print("whisper not installed. Run: pip install openai-whisper")
        return ""

    try:
        model = whisper.load_model(model_size)
        result = model.transcribe(audio_file, language="en")
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


def listen_and_respond(device=None, boost=False, model_size=WHISPER_MODEL):
    """Record, transcribe, detect hotword, query JARVIS, speak response."""
    audio_path, peak = record_audio(seconds=RECORD_SECONDS, sample_rate=SAMPLE_RATE,
                                    device=device, boost=boost)
    if not audio_path:
        return  # record_audio already printed the diagnostic

    transcript = transcribe(audio_path, model_size=model_size)

    if not transcript:
        print("(No speech detected after transcription — try speaking louder or --boost)")
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

    # Flags
    boost       = "--boost" in args
    do_loop     = "--loop" in args

    device = None
    if "--device" in args:
        idx = args.index("--device")
        if idx + 1 < len(args):
            try:
                device = int(args[idx + 1])
            except ValueError:
                print("--device requires a number. Use --list-devices to see options.")
                return

    model_size = WHISPER_MODEL
    if "--model" in args:
        idx = args.index("--model")
        if idx + 1 < len(args):
            model_size = args[idx + 1]  # base | small | medium | large

    if "--list-devices" in args:
        list_devices()
        return

    if "--tts" in args:
        idx = args.index("--tts")
        if idx + 1 < len(args):
            speak(args[idx + 1])
        else:
            print("Usage: python voice.py --tts \"text to speak\"")
        return

    if do_loop:
        print("JARVIS voice loop active. Say 'JARVIS <command>'. Ctrl+C to stop.")
        print("Tips: --boost (amplify quiet mic) | --device N (select mic) | --model small (more accurate)")
        try:
            while True:
                listen_and_respond(device=device, boost=boost, model_size=model_size)
                time.sleep(0.5)
        except KeyboardInterrupt:
            print("\nVoice loop stopped.")
        return

    # Single-shot mode
    listen_and_respond(device=device, boost=boost, model_size=model_size)


if __name__ == "__main__":
    main()
