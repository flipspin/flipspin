"""Expose helper probes, pipelines, and the outbound job agent.

Load models only for pipeline work so capability checks and an idle agent stay
lightweight. Stdout is reserved for JSON-line protocol events.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import platform
import signal
import sys
import traceback
from pathlib import Path
from .paths import data_root, state_path
from typing import Dict, List, Optional

from . import __version__
from . import protocol as P
from .kinds.lyrics.align import LOW_CONFIDENCE


def _stderr_only():
    """Route anything that prints (tqdm, HF, torch) to stderr while active."""
    return contextlib.redirect_stdout(sys.stderr)


# ------------------------------------------------------------------ check


def _module_ok(name: str) -> bool:
    """Installed, by metadata — never imported. Importing torch or MLX takes
    tens of seconds cold, and `check` has to answer a 20 s probe."""
    from .acceleration import module_ok

    return module_ok(name)


def _hf_model_present(repo: str) -> bool:
    home = Path(os.environ.get("HF_HOME") or (state_path("KROBI_MODELS_DIR", "models") / "hf"))
    snap = home / "hub" / ("models--" + repo.replace("/", "--")) / "snapshots"
    return snap.exists() and any(p.is_dir() for p in snap.iterdir())


def _torch_model_present() -> bool:
    home = torch_home()
    return (home / "hub" / "checkpoints" / "model.pt").exists()


def _demucs_present() -> bool:
    from .acceleration import detect

    if detect(lightweight=True)["accel"] != "mlx":
        return (torch_home() / "hub" / "checkpoints" / "955717e8-8726e21a.th").exists()
    return (Path.home() / ".cache" / "demucs-mlx" / f"{P.DEMUCS_MODEL}.safetensors").exists()


def cmd_check(_: argparse.Namespace) -> int:
    from .acceleration import capabilities, supported

    facts = capabilities(lightweight=True)
    mlx = facts["accel"] == "mlx"
    status = {
        **facts,
        "version": __version__,
        "python": platform.python_version(),
        "platform": f"{platform.system().lower()}-{platform.machine()}",
        "supported": supported(),
        "packages": {
            ("mlx_whisper" if mlx else "whisper"): _module_ok("mlx_whisper" if mlx else "whisper"),
            ("demucs_mlx" if mlx else "demucs"): _module_ok("demucs_mlx" if mlx else "demucs"),
            "torch": _module_ok("torch"),
            "torchaudio": _module_ok("torchaudio"),
        },
        "models": {
            "whisper": _hf_model_present(P.WHISPER_REPO) if mlx else (whisper_home() / "large-v3-turbo.pt").exists(),
            "aligner": _torch_model_present(),
            "demucs": _demucs_present(),
        },
    }
    from .addons import status as addon_status

    status["engineReady"] = bool(status["supported"] and all(
        status["packages"].get(name) for name in ("torch", "torchaudio", "demucs_mlx" if mlx else "demucs")))
    status["addons"] = addon_status()
    from .gpu_pack import status as gpu_status

    status["addons"]["gpu"] = gpu_status()
    for name in ("lyrics", "stems"):
        status["addons"][name]["ready"] &= status["engineReady"]
    status["addons"]["analysis"]["ready"] &= all(_module_ok(m) for m in ("onnxruntime", "krobi_keyfinder"))
    status["addons"]["stems"]["ready"] &= _module_ok("beat_this")
    status["ready"] = status["addons"]["lyrics"]["ready"]
    status["jobs"] = [job for job, addon in (("align", "lyrics"), ("stems", "stems"), ("analysis", "analysis")) if status["addons"][addon]["ready"]]
    # Stems readiness is reported apart and never gates `ready`: an engine
    # installed before stems existed must keep doing lyrics.
    status["stems"] = {"beat_this": _module_ok("beat_this"), "beats_model": _beats_present()}
    from .plugins import load_plugins

    for name, check in load_plugins().checks.items():
        try:
            status[name] = check()
        except Exception as exc:
            status[name] = {"error": str(exc)}
    print(json.dumps(status))
    return 0


# --------------------------------------------------------------- prefetch


def cmd_prefetch(args: argparse.Namespace) -> int:
    from .addons import REQUIRES, save_selections, selections

    addon = args.addon
    selected = selections()
    selected[addon] = True
    save_selections(selected)
    from .kinds.analysis.model import prefetch as prefetch_tempo

    functions = {"tempocnn": prefetch_tempo, "aligner": _prefetch_aligner, "demucs": _prefetch_demucs, "beats": _prefetch_beats}
    steps = REQUIRES[addon]
    os.environ.setdefault("TORCH_HOME", str(torch_home()))
    for index, name in enumerate(steps):
        P.emit("prefetch", addon=addon, model=name, percent=round(index / len(steps) * 100), state="downloading")
        try:
            with _stderr_only():
                functions[name]()
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            P.emit("failed", job="prefetch", model=name, error=f"{name}: {exc}")
            return 1
        P.emit("prefetch", addon=addon, model=name, percent=round((index + 1) / len(steps) * 100), state="ready")
    selected[addon] = True
    save_selections(selected)
    P.emit("done", job="prefetch", addon=addon)
    return 0


def cmd_gpu(args: argparse.Namespace) -> int:
    from .gpu_pack import change

    with _stderr_only():
        change(args.uv, remove=args.remove)
    P.emit("done", job="gpu")
    return 0


def cmd_remove(args: argparse.Namespace) -> int:
    from .addons import remove

    remove(args.addon)
    P.emit("done", job="remove", addon=args.addon)
    return 0


def _prefetch_whisper() -> None:
    from .acceleration import detect

    if detect()["accel"] == "mlx":
        from huggingface_hub import snapshot_download

        snapshot_download(P.WHISPER_REPO)
    else:
        import whisper

        whisper.load_model("large-v3-turbo", device="cpu", download_root=str(whisper_home()))


def _prefetch_hf(repo: str, revision: Optional[str] = None) -> None:
    from huggingface_hub import snapshot_download

    snapshot_download(repo, revision=revision)


def _prefetch_aligner() -> None:
    from .kinds.lyrics.align import ensure_aligner

    ensure_aligner()


def _prefetch_beats() -> None:
    from beat_this.inference import load_checkpoint

    load_checkpoint("final0")


def torch_home() -> Path:
    """Where torch hub puts checkpoints: ``TORCH_HOME`` when the app set it,
    else under KROBI's models dir — never ``~/.cache`` behind the app's back."""
    explicit = os.environ.get("TORCH_HOME")
    if explicit:
        return Path(explicit)
    models = state_path("KROBI_MODELS_DIR", "models")
    return models / "torch"


def whisper_home() -> Path:
    return torch_home().parent / "whisper"


def _beats_present() -> bool:
    return (torch_home() / "hub" / "checkpoints" / "beat_this-final0.ckpt").exists()


def _prefetch_demucs() -> None:
    from .addons import model_paths

    if model_paths()["demucs"].is_file():
        return
    from .acceleration import detect

    if detect()["accel"] == "mlx":
        from demucs_mlx import Separator

        Separator(model=P.DEMUCS_MODEL)
    else:
        from .separation import load_model

        load_model()


# -------------------------------------------------------------------- run


def cmd_run(args: argparse.Namespace) -> int:
    from .agent import exit_with_parent
    from .kinds.lyrics.pipeline import Job, PipelineError, run_job

    # Started by an agent (or the backend) that may be killed outright: never
    # outlive it holding gigabytes of models.
    exit_with_parent()

    jobs_file = Path(args.jobs)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    raw: List[Dict[str, object]] = json.loads(jobs_file.read_text(encoding="utf-8"))
    jobs = [Job.from_dict(item) for item in raw]

    stopping = {"now": False}

    def _stop(_signum, _frame):  # SIGTERM from the backend's cancel
        stopping["now"] = True

    signal.signal(signal.SIGTERM, _stop)

    for job in jobs:
        if stopping["now"]:
            P.emit("failed", job=job.id, error="cancelado")
            continue

        def report(phase: str, percent: Optional[float], _id=job.id) -> None:
            P.emit("phase", job=_id, phase=phase, percent=percent)

        try:
            with _stderr_only():
                from .execution import run

                result = run(lambda: run_job(job, out_dir, report), models=("htdemucs", "mms"))
            P.emit("done", job=job.id, **result)
        except PipelineError as e:
            P.emit("failed", job=job.id, error=str(e), final=True)
        except Exception as e:  # noqa: BLE001 — one bad song must not end the batch
            traceback.print_exc(file=sys.stderr)
            P.emit("failed", job=job.id, error=f"{type(e).__name__}: {e}", final=False)
    return 0


# ------------------------------------------------------------------ align


def _torch_device() -> str:
    from .acceleration import torch_device

    return torch_device()


def cmd_align(args: argparse.Namespace) -> int:
    """One file, words already known: no Whisper. With ``--json`` stdout is the
    protocol (phase lines, then one ``done``/``failed``); without it, a short
    human summary on stderr and nothing on stdout."""
    from .kinds.lyrics import align as aligner

    os.environ.setdefault("TORCH_HOME", str(torch_home()))
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    text = Path(args.text).read_text(encoding="utf-8")
    out = Path(args.out)
    job_id = out.stem

    def report(phase: str) -> None:
        if args.json:
            P.emit("phase", job=job_id, phase=phase, percent=None)

    result = None
    words = Path(args.words) if args.words else out.with_suffix(".words.json")
    if args.device:
        os.environ["KROBI_ACCEL"] = "mlx" if args.device == "mps" else args.device

    def process():
        nonlocal result, words
        source = Path(args.vocals) if args.vocals else Path(args.audio)
        if not args.vocals and args.isolate:
            from .kinds.lyrics.pipeline import decode, isolate_vocals

            work = out.parent / f".{out.stem}.work"
            work.mkdir(parents=True, exist_ok=True)
            report(P.PHASE_DECODING)
            _wav16, wav44 = decode(Path(args.audio), work)
            report(P.PHASE_SEPARATING)
            source = isolate_vocals(wav44, work)
        report(P.PHASE_ALIGNING)
        result = aligner.align_file(
            str(source), text, language=args.language, device=_torch_device(),
            wildcard=args.wildcard, threshold=args.threshold, lead_s=args.lead,
        )
        report(P.PHASE_WRITING)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(aligner.to_lrc(result.lines, word_tags=args.word_tags), encoding="utf-8")
        words = Path(args.words) if args.words else out.with_suffix(".words.json")
        words.write_text(json.dumps(result.to_dict(), ensure_ascii=False, indent=1), encoding="utf-8")
        return {}

    try:
        from .execution import run

        with _stderr_only():
            evidence = run(process, models=("htdemucs", "mms"))
    except aligner.AlignError as e:
        if args.json:
            P.emit("failed", job=job_id, error=str(e), final=True)
        else:
            print(f"krobi-helper align: {e}", file=sys.stderr)
        return 1
    finally:
        if not args.vocals and args.isolate:
            import shutil

            shutil.rmtree(out.parent / f".{out.stem}.work", ignore_errors=True)
    if args.json:
        P.emit("done", job=job_id, lrc=str(out), words=str(words), source=result.source, kind="synced",
               lines=len(result.lines), lineConfidence=[line.conf for line in result.lines],
               lowLines=result.low_lines, device=result.device, seconds=result.seconds,
               leadSeconds=result.lead_s, **evidence)
    else:
        print(
            f"{len(result.lines)} lines → {out}  ({result.device}, "
            + ", ".join(f"{k} {v:.1f}s" for k, v in result.seconds.items())
            + f"; {len(result.low_lines)} below {result.threshold:g})",
            file=sys.stderr,
        )
        for i in result.low_lines:
            line = result.lines[i]
            print(f"  ? {aligner.stamp(line.start)} {line.conf:.2f}  {line.text}", file=sys.stderr)
    return 0


# ------------------------------------------------------------------ stems


def cmd_stems(args: argparse.Namespace) -> int:
    """One song, one process (MLX memory is released when it exits). SIGTERM's
    default action is the cancel: nothing is half-published, the caller only
    ever reads a finished out dir."""
    from .agent import exit_with_parent
    from .kinds.stems.pipeline import StemsError, StemsJob, run_stems

    exit_with_parent()
    # beat_this's checkpoint goes to the torch hub cache: the same place
    # `check` looks (torch_home), even when started by hand.
    os.environ.setdefault("TORCH_HOME", str(torch_home()))
    job = StemsJob.from_dict(json.loads(Path(args.job).read_text(encoding="utf-8")))

    def report(phase: str, percent: Optional[float]) -> None:
        P.emit("phase", job=job.id, phase=phase, percent=percent)

    try:
        with _stderr_only():
            from .execution import run

            result = run(lambda: run_stems(job, Path(args.out_dir), report),
                         models=("htdemucs", "beat_this"), manifest=Path(args.out_dir) / "song.json")
        P.emit("done", job=job.id, **result)
    except StemsError as e:
        P.emit("failed", job=job.id, error=str(e), final=True)
    except Exception as e:  # noqa: BLE001 — reported as an accident, retried by the server
        traceback.print_exc(file=sys.stderr)
        P.emit("failed", job=job.id, error=f"{type(e).__name__}: {e}", final=False)
    return 0


def cmd_analysis(args: argparse.Namespace) -> int:
    from .agent import exit_with_parent
    from .addons import model_paths
    from .kinds.analysis.pipeline import run_batch
    from .kinds.analysis.tempo import TempoCNN

    exit_with_parent()
    items = json.loads(Path(args.jobs).read_text(encoding="utf-8"))
    if not 1 <= len(items) <= 25:
        raise ValueError("analysis batches contain 1 to 25 items")
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    with _stderr_only():
        tempo = TempoCNN(model_paths()["tempocnn"])
        results = run_batch(items, tempo, lambda phase, progress: P.emit("phase", phase=phase, percent=progress))
    (out / "analysis.json").write_text(json.dumps(results, allow_nan=False), encoding="utf-8")
    P.emit("done", items=results, accel="cpu")
    return 0


# ------------------------------------------------------------------ agent


def cmd_agent(args: argparse.Namespace) -> int:
    from .agent import main_from_args

    return main_from_args(args)


# ------------------------------------------------------------------- main


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="krobi-helper")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("check")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_check)
    p = sub.add_parser("prefetch")
    p.add_argument("--addon", choices=("lyrics", "stems", "analysis"), required=True)
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_prefetch)
    p = sub.add_parser("remove")
    p.add_argument("--addon", choices=("lyrics", "stems", "analysis"), required=True)
    p.set_defaults(fn=cmd_remove)
    p = sub.add_parser("gpu")
    p.add_argument("--uv", required=True)
    p.add_argument("--remove", action="store_true")
    p.set_defaults(fn=cmd_gpu)
    p = sub.add_parser("run")
    p.add_argument("--jobs", required=True)
    p.add_argument("--out-dir", required=True)
    p.set_defaults(fn=cmd_run)
    p = sub.add_parser("align", help="known lyrics → synced LRC (no transcription)")
    p.add_argument("--audio", required=True, help="the song (anything ffmpeg reads)")
    p.add_argument("--text", required=True, help="plain lyrics, one line per sung line (UTF-8)")
    p.add_argument("--out", required=True, help="where to write the .lrc")
    p.add_argument("--vocals", default=None, help="an already separated vocals stem of the same song")
    p.add_argument("--no-isolate", dest="isolate", action="store_false", help="align on the mix, skip demucs")
    p.add_argument("--words", default=None, help="per-line/word times and confidence (default: <out>.words.json)")
    p.add_argument("--word-tags", action="store_true", help="enhanced LRC with <mm:ss.xx> word stamps")
    p.add_argument("--language", default=None, help="es | en — only to spell out digits (guessed)")
    p.add_argument("--device", default=None, help="mps | cpu | cuda (default: best available)")
    p.add_argument("--wildcard", default="stanza", choices=("line", "stanza", "edges", "none"))
    p.add_argument("--threshold", type=float, default=LOW_CONFIDENCE, help="flag lines below this confidence")
    p.add_argument("--lead", type=float, default=0.0, help="show lines this many seconds early (default 0: where the voice is)")
    p.add_argument("--json", action="store_true", help="protocol JSON lines on stdout")
    p.set_defaults(fn=cmd_align)
    p = sub.add_parser("stems", help="split one song into stems + beats + chops (song.json)")
    p.add_argument("--job", required=True, help='JSON file: {"id", "audio", "album", "file", "model"}')
    p.add_argument("--out-dir", required=True)
    p.set_defaults(fn=cmd_stems)
    p = sub.add_parser("analysis", help="analyse a batch on CPU")
    p.add_argument("--jobs", required=True)
    p.add_argument("--out-dir", required=True)
    p.set_defaults(fn=cmd_analysis)
    p = sub.add_parser("agent", help="process lyrics, stems and plugin jobs for a server that cannot run the engine itself")
    p.add_argument("--server", required=True, help="backend origin, e.g. http://192.0.2.10:8000")
    p.add_argument("--token", default=None, help="device token (or KROBI_API_TOKEN)")
    p.add_argument("--name", default=None, help="how this Mac introduces itself")
    p.add_argument("--once", action="store_true", help="claim once, process, exit (for tests)")
    p.set_defaults(fn=cmd_agent)
    from .plugins import load_plugins

    for name, configure in load_plugins().commands.items():
        configure(sub.add_parser(name))
    parser.add_argument("--accel", choices=("mlx", "cuda", "cpu"), help=argparse.SUPPRESS)
    # Also accept after the verb, as in `stems --accel cpu`.
    for command_parser in sub.choices.values():
        command_parser.add_argument("--accel", choices=("mlx", "cuda", "cpu"),
                                    default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        data_root()
    except ValueError as error:
        parser.error(str(error))
    if getattr(args, "accel", None):
        os.environ["KROBI_ACCEL"] = args.accel
    return int(args.fn(args))


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
