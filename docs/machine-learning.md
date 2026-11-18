# Machine learning

Heavy audio work runs on **helpers**: any computer that joins the server, on Apple Silicon (MLX), Nvidia (CUDA) or CPU. Helpers connect out to the server and claim jobs from a lease-based queue. Each job goes to the fastest helper that can run it, and a helper that disappears has its work requeued. A desktop computer hosting its own nest can also enroll as an ordinary helper,
with engines managed in Settings → Engines and work limits in Settings → Helpers.
The server can run some work through its separate capped CPU worker on Linux
when cgroups are available and you allow it. No audio leaves your machines.

| | Models | Output |
|---|---|---|
| **Lyrics** | MMS forced aligner, on the isolated vocals | line timings for known words, with a confidence per line |
| **Stems** | Demucs (htdemucs), beat_this | drums, bass, vocals and other, with beat-aligned chops |
| **Analysis** | KeyFinder, TempoCNN (ONNX, no PyTorch) | key, tempo and the energy measurements the server turns into a rough mood |

Accuracy on the public GiantSteps sets (604 tracks for key, 661 for tempo):

| | All songs | When Flipspin is confident |
|---|---|---|
| Key, exact | 60 % | 67 % |
| Tempo, within ±4 % | 88 % | 94 % |
| Tempo, allowing half or double | 97 % | 99.8 % |

Confidence cutoffs are calibrated on the same sets. Values below them are shown as estimates (≈), and a value you correct by hand is never overwritten. Each model's licence is listed in [third-party notices](third-party-notices.md).

Details: [lyrics alignment](lyrics-align.md) · [stems](stems.md) · [song analysis](analysis.md).
