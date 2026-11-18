#!/bin/sh
# Native target-arch build: no prebuilt third-party binaries, no nonfree codecs.
set -eu
version=8.1.3
sha256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
cd /tmp
curl --fail --location --retry 2 --connect-timeout 15 --max-time 60 "https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz" -o ffmpeg.tar.xz
echo "$sha256  ffmpeg.tar.xz" | sha256sum --check -
tar -xJf ffmpeg.tar.xz
cd "ffmpeg-${version}"
# Native audio decoders plus still images for embedded/downloaded cover art.
# Keep HTTP(S)/HLS for yt-dlp, PCM pipes for analysis/stems/waveforms, loudnorm
# and volume for normalization, and scale + mjpeg/yuvj444p for CoverCache.
./configure \
    --prefix=/opt/ffmpeg --disable-debug --disable-doc --disable-ffplay \
    --disable-autodetect --disable-everything \
    --enable-indev=lavfi --enable-network --enable-gpl --enable-version3 \
    --enable-libmp3lame --enable-libopus --enable-libvorbis --enable-openssl --enable-zlib \
    --enable-protocol=file,pipe,http,https,tcp,udp,tls,crypto,data,httpproxy \
    --enable-demuxer=aac,ac3,aiff,ape,asf,concat,eac3,flac,hls,matroska,mov,mp3,mpegts,ogg,wav,wv,image2,image2pipe,mjpeg,png_pipe,webp_pipe,bmp_pipe,gif,tiff_pipe \
    --enable-muxer=adts,flac,mp3,mp4,ipod,mov,ogg,opus,matroska,webm,wav,aiff,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,image2,image2pipe,null \
    --enable-decoder=aac,aac_fixed,ac3,eac3,alac,ape,flac,mp3,mp3float,mp3adu,mp3adufloat,mp3on4,mp3on4float,opus,vorbis,wavpack,wmav1,wmav2,wmalossless,wmapro,pcm_s8,pcm_u8,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be,pcm_alaw,pcm_mulaw,mjpeg,png,webp,bmp,gif,tiff \
    --enable-encoder=aac,alac,flac,libmp3lame,libopus,libvorbis,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f64le,mjpeg,png \
    --enable-parser=aac,aac_latm,ac3,flac,mpegaudio,opus,vorbis,vp8,vp9,mjpeg,png,webp \
    --enable-filter=aresample,aformat,anull,atrim,asetpts,volume,loudnorm,pan,channelsplit,channelmap,amerge,amix,concat,sine,anullsrc,scale,format,null,trim,setpts,color,testsrc \
    --enable-bsf=aac_adtstoasc,extract_extradata,vp9_superframe,opus_metadata
make -j "$(nproc)"
# Copy executables only, not headers/static archives or the compiler toolchain.
install -Dm755 ffmpeg /opt/ffmpeg/bin/ffmpeg
install -Dm755 ffprobe /opt/ffmpeg/bin/ffprobe
mkdir -p /opt/ffmpeg/share/krobi-ffmpeg
cp COPYING.GPLv3 LICENSE.md ffbuild/config.mak /opt/ffmpeg/share/krobi-ffmpeg/
printf '%s\nsha256: %s\n' "https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz" "$sha256" \
    > /opt/ffmpeg/share/krobi-ffmpeg/SOURCE
# Match the desktop packager's nonfree refusal, for BOTH executables.
for binary in /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe; do
    "$binary" -version > /tmp/ffmpeg-license.txt 2>&1
    "$binary" -L >> /tmp/ffmpeg-license.txt 2>&1
    cat /tmp/ffmpeg-license.txt
    if grep -Eiq -- '--enable-nonfree|nonfree parts compiled in|not legally redistributable' /tmp/ffmpeg-license.txt; then
        echo 'Refusing nonfree FFmpeg build' >&2
        exit 1
    fi
done
