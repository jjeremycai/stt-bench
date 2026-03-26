#!/usr/bin/env python3

import argparse
import array
import json
import sys
import time
import wave
from pathlib import Path

from huggingface_hub import snapshot_download
import sherpa_onnx


MODEL_FILES = ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")


def ensure_model(repo_id: str, model_dir: Path) -> Path:
    model_dir.mkdir(parents=True, exist_ok=True)
    missing = [name for name in MODEL_FILES if not (model_dir / name).exists()]
    if missing:
        snapshot_download(
            repo_id=repo_id,
            local_dir=str(model_dir),
            allow_patterns=list(MODEL_FILES),
        )
    return model_dir


def read_wave(path: Path) -> tuple[int, list[float]]:
    with wave.open(str(path), "rb") as wav_file:
        sample_rate = wav_file.getframerate()
        frames = wav_file.getnframes()
        data = wav_file.readframes(frames)

    samples = array.array("h")
    samples.frombytes(data)
    if sys.byteorder != "little":
        samples.byteswap()
    return sample_rate, [sample / 32768.0 for sample in samples]


def run_benchmark(wav_path: Path, model_dir: Path, provider: str, num_threads: int) -> dict:
    sample_rate, samples = read_wave(wav_path)

    init_start = time.perf_counter()
    recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(model_dir / "encoder.int8.onnx"),
        decoder=str(model_dir / "decoder.int8.onnx"),
        joiner=str(model_dir / "joiner.int8.onnx"),
        tokens=str(model_dir / "tokens.txt"),
        provider=provider,
        num_threads=num_threads,
        debug=False,
        modeling_unit="bpe",
        model_type="nemo_transducer",
    )
    init_end = time.perf_counter()

    stream = recognizer.create_stream()
    stream.accept_waveform(sample_rate, samples)
    recognizer.decode_stream(stream)
    decode_end = time.perf_counter()
    result = stream.result

    return {
        "confidence": getattr(result, "confidence", None),
        "decode_s": round(decode_end - init_end, 3),
        "init_s": round(init_end - init_start, 3),
        "text": getattr(result, "text", ""),
        "total_s": round(decode_end - init_start, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--provider", default="coreml")
    parser.add_argument("--num-threads", type=int, default=4)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--repo-id", required=True)
    parser.add_argument("--wav")
    args = parser.parse_args()

    model_dir = ensure_model(args.repo_id, Path(args.model_dir))
    if args.prepare_only:
        print(json.dumps({"model_dir": str(model_dir)}))
        return 0

    if not args.wav:
        raise SystemExit("--wav is required unless --prepare-only is set")

    result = run_benchmark(
        wav_path=Path(args.wav),
        model_dir=model_dir,
        provider=args.provider,
        num_threads=args.num_threads,
    )
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
