# Third-party notices

KROBI is licensed under the GNU Affero General Public License, version 3 or later
(see `LICENSE`). Some parts of this repository, and some programs the packaged
app ships or downloads, come from other people. This file credits them and
carries the notices their licenses require.

It has three parts: code and styles in this repository that derive from
someone else's work; files in this repository that are someone else's work
(fonts); and third-party software the built app bundles or installs. A short
note at the end records what is original to this project.

---

## 1. Derived code and styles

### Icon drawings from Lucide

A few icons are drawn inline from Lucide's SVG sources instead of through the
`lucide-react` component (the file picker's X/Upload/File, the first-run and
remote-access icons, the song row's Play, the catalogue row's «+»); the globe in
`renderer/src/onboarding/Shell.tsx` is the older Feather drawing. Lucide is
under the ISC License, and the Feather parts under MIT:

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### Design references (no code copied)

- The candidate scoring in `backend/app/domains/metadata/matching.py` — a
  weighted distance, a winner that must beat the runner-up by a margin, and a
  duration grace band followed by a linear ramp — follows the approach of the
  *beets* autotagger (<https://beets.io>, MIT License). The weights and
  thresholds here were tuned independently.
- The key recipe in `backend/app/domains/metadata/normalization.py` follows
  MusicBrainz's published style guidelines on what does and does not change
  a recording's identity.

---

## 2. Fonts

Three fonts are bundled into the app from npm packages, all under the SIL Open
Font License, Version 1.1 (full text below), so the app never fetches fonts at
runtime. Per-font copyright and full licence files are shipped in
`renderer/public/fonts/OFL-*.txt`, which Vite copies into the web and desktop
frontend builds.

| Package | Font | Copyright |
|---|---|---|
| `@fontsource/inter` | Inter, by Rasmus Andersson | Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) |
| `@fontsource/geist` | Geist, by Vercel | Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font) |
| `@fontsource/geist-mono` | Geist Mono, by Vercel | Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font) |

```
-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

---

## 3. Software the built app bundles or installs

Not part of this repository's source, listed so that anyone redistributing a
build knows what it contains. Each keeps its own license; consult the
upstream project for the full text.

### Shipped inside the packaged app

| Component | How it gets in | License |
|---|---|---|
| uv 0.9.5 | Apple Silicon installer, bundled in `backend/bin/uv` from the official Astral release | MIT (selected from upstream’s MIT OR Apache-2.0); full notice in `backend/bin/uv-LICENSE-MIT.txt`, source: <https://github.com/astral-sh/uv/tree/0.9.5> |
| FFmpeg (desktop app) | the static binary from PyPI `imageio-ffmpeg` 0.6.0, staged by `scripts/build-backend.cjs` into `resources/backend/ffmpeg/` | GPL for this build (FFmpeg itself is LGPL-2.1-or-later; the static build enables GPL components). Redistributing a build carries the GPL's source-offer obligations for FFmpeg — <https://ffmpeg.org/legal.html> |
| FFmpeg 8.1.3 (server image) | built from the checksummed upstream release by `backend/ffmpeg-build.sh` with only the audio and cover pieces, `--enable-gpl --enable-version3`, no nonfree components | GPL-3.0-or-later; the image keeps FFmpeg's `COPYING.GPLv3`, `LICENSE.md` and build configuration in `/opt/ffmpeg/share/krobi-ffmpeg/`, see `docs/qa-install.md` |
| mutagen | backend dependency | GPL-2.0-or-later |
| yt-dlp | backend dependency | Unlicense (public domain) |
| libsoxr (via `soxr`) | backend dependency (librosa resampling) | LGPL-2.1-or-later |
| libsndfile (via `soundfile`) | backend dependency | LGPL-2.1-or-later |
| certifi | backend dependency | MPL-2.0 |
| requests, cryptography | backend dependencies | Apache-2.0 (cryptography: Apache-2.0 OR BSD-3-Clause) |
| FastAPI, Pydantic, Beautiful Soup, audioread | backend dependencies | MIT |
| Starlette, Uvicorn, NumPy, SciPy, scikit-learn, Numba, llvmlite, lxml, joblib, python-multipart, imageio-ffmpeg (the wrapper) | backend dependencies | BSD-style |
| librosa | backend dependency | ISC |
| Tauri, React and the renderer's npm dependencies | desktop shell and UI | MIT / Apache-2.0 (see each package) |

The desktop MP3 decoder includes:

- **mpg123-decoder** (JavaScript/WASM wrapper), MIT;
  source: <https://github.com/eshaz/wasm-audio-decoders/tree/main/src/mpg123-decoder>.
- **mpg123 / libmpg123**, embedded in that WASM build, LGPL-2.1;
  source and licence: <https://www.mpg123.de/download.shtml> and
  <https://www.mpg123.de/cgi-bin/scm/mpg123/trunk/COPYING?view=markup>.
  The wrapper's MIT licence does not replace the embedded decoder's LGPL.
  Distributors must preserve both notices, provide the corresponding decoder
  source (including build changes), and permit replacement/relinking of the
  LGPL component under its terms. The wrapper's build sources are in the
  repository linked above.

The additional desktop format decoders include:

| npm package | Wrapper licence | Bundled codec implementation |
|---|---|---|
| `@wasm-audio-decoders/flac` 0.2.11 | MIT | libFLAC, BSD-3-Clause, compiled to WASM |
| `ogg-opus-decoder` 1.7.5 | MIT | `opus-decoder` (MIT) with libopus, BSD-3-Clause, compiled to WASM; its optional `@wasm-audio-decoders/opus-ml` (MIT) contains the libopus speech enhancement build, BSD-3-Clause, and is not enabled by the player |
| `@wasm-audio-decoders/ogg-vorbis` 0.1.20 | MIT | libvorbis and libogg, BSD-3-Clause, compiled to WASM |

All three use `@wasm-audio-decoders/common` (MIT, including the puff inflater
under the zlib licence) and `codec-parser` (LGPL-3.0-or-later) for container/frame
parsing. The MIT wrappers do not replace the codec or parser licences. Preserve
their notices and supply the corresponding parser source and modifications,
allowing replacement under the LGPL's terms. Wrapper and WASM build sources:
<https://github.com/eshaz/wasm-audio-decoders>; parser sources and licence:
<https://github.com/eshaz/codec-parser>. Codec sources and licences:
<https://github.com/xiph/flac>, <https://github.com/xiph/opus>,
<https://github.com/xiph/vorbis>, <https://github.com/xiph/ogg>.
WAV parsing and the sinc resampler are original renderer code. M4A/AAC/ALAC uses
the operating system's Web Audio decoder; no additional codec is redistributed.

Each release must include or offer the exact FFmpeg source for the binaries it ships; the versions and upstream tarballs are listed in [docs/RELEASE.md](docs/RELEASE.md#distributing-a-build).

All of the above are compatible with distributing the whole under AGPL-3.0 (GPL-3.0 components combine with it under section 13 of both licences).

### Installed on demand by the helper engine

The helper package (`helper/`) ships as a wheel; its model libraries are
installed on demand. When a user asks for it, the backend installs it into `~/Krobi/tools/helper/venv` and downloads its
models into `~/Krobi/models`.

| Component | License |
|---|---|
| mlx-whisper | MIT |
| Whisper large-v3-turbo weights (`mlx-community/whisper-large-v3-turbo`), not installed in v0.1 (lyrics are sync only) | MIT |
| demucs-mlx, and the htdemucs weights | MIT |
| torchaudio | BSD-2-Clause |
| **MMS forced-alignment model** (`torchaudio.pipelines.MMS_FA`) | **CC-BY-NC-4.0** — non-commercial use only |

The MMS model is fetched by the user's own machine at
install time and is never redistributed by this project. The MMS model's
non-commercial license means the lyrics alignment step must not be used, or
offered, commercially.


---

## Analysis add-on

The optional `krobi-helper[analysis]` environment uses:

- **libKeyFinder**, GPL-3.0-or-later, pinned source revision
  `941e517ebf853c2153a8b9d6efcc0c729199aa0b` at
  <https://github.com/mixxxdj/libkeyfinder>. Its source license is embedded in
  each `krobi-keyfinder` wheel.
- **FFTW 3.3.10**, GPL-2.0-or-later, statically linked with KeyFinder in those
  wheels; <https://www.fftw.org/>. Its source license is embedded in each wheel.
- **TempoCNN deeptemp-k16-3 weights**, AGPL-3.0, converted to ONNX and downloaded
  only for this add-on. The download includes an AGPL notice, the license link,
  and the source graph link beside the model. Source graph:
  <https://essentia.upf.edu/models/tempo/tempocnn/deeptemp-k16-3.pb>;
  model source: <https://github.com/hendriks73/tempo-cnn>;
  license: <https://www.gnu.org/licenses/agpl-3.0.html>.
- **ONNX Runtime**, MIT, CPU execution provider;
  <https://github.com/microsoft/onnxruntime>.

Essentia and TensorFlow are not runtime dependencies. Front-end numerical
parameters and their immutable source reference are recorded in
`helper/krobi_helper/kinds/analysis/tempo.py`.

## Original work

The per-file inventory is recorded in [docs/ASSETS.md](docs/ASSETS.md).

These are original work by the project's author, made for KROBI, and are
distributed under the same license as the code (AGPL-3.0-or-later):

- **The KROBI penguin** — the app icon (`resources/icon/krobi-icon.svg`,
  `krobi-figure.svg` and everything rendered from them) and the sidebar mark
  (`renderer/src/assets/krobi-mark.png`).
- **The sidebar's Ising panel** — the tiled Ising-model simulation in
  `renderer/src/viz/IsingScreen.tsx` and `renderer/src/viz/isingLattice.ts`.
