// wrapper.c
// Minimal libav* "smoke test" API for wasm builds (no ffmpeg CLI).
// Exports:
//   - int wav_to_pcm16le_fs(const char* in_path, const char* out_path)
//   - void* wasm_malloc(size_t)
//   - void  wasm_free(void*)
//
// Notes:
// - Returns 0 on success, otherwise returns a negative libav error code
//   (or positive errno in a couple of stdio cases).
// - Prints detailed errors to stderr (visible in browser console).

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <errno.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/mem.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>

__attribute__((used)) void* wasm_malloc(size_t n) { return malloc(n); }
__attribute__((used)) void  wasm_free(void* p)   { free(p); }

static void log_av_err(const char* where, int err) {
    char buf[256];
    buf[0] = '\0';
    av_strerror(err, buf, (int)sizeof(buf));
    fprintf(stderr, "[ffmpegwasm] %s failed: %d (%s)\n", where, err, buf[0] ? buf : "unknown");
}

static void log_errno(const char* where) {
    fprintf(stderr, "[ffmpegwasm] %s failed: errno=%d (%s)\n", where, errno, strerror(errno));
}

/**
 * Decode an input WAV file from the Emscripten FS into raw PCM16LE and write it
 * back to FS as out_path. This is designed for deterministic testing.
 *
 * Returns:
 *   0 on success
 *   negative AVERROR_* on libav failures
 *   positive errno on stdio failures
 */
__attribute__((used))
int wav_to_pcm16le_fs(const char* in_path, const char* out_path) {
    AVFormatContext* fmt = NULL;
    AVCodecContext* dec = NULL;
    SwrContext* swr = NULL;

    int ret = 0;
    int audio_stream = -1;

    // Open input
    ret = avformat_open_input(&fmt, in_path, NULL, NULL);
    if (ret < 0) { log_av_err("avformat_open_input", ret); goto fail; }

    ret = avformat_find_stream_info(fmt, NULL);
    if (ret < 0) { log_av_err("avformat_find_stream_info", ret); goto fail; }

    // Find best audio stream
    ret = av_find_best_stream(fmt, AVMEDIA_TYPE_AUDIO, -1, -1, NULL, 0);
    if (ret < 0) { log_av_err("av_find_best_stream", ret); goto fail; }
    audio_stream = ret;

    AVStream* st = fmt->streams[audio_stream];
    const AVCodec* codec = avcodec_find_decoder(st->codecpar->codec_id);
    if (!codec) {
        fprintf(stderr, "[ffmpegwasm] avcodec_find_decoder failed: codec_id=%d\n", st->codecpar->codec_id);
        ret = AVERROR_DECODER_NOT_FOUND;
        goto fail;
    }

    dec = avcodec_alloc_context3(codec);
    if (!dec) { ret = AVERROR(ENOMEM); fprintf(stderr, "[ffmpegwasm] avcodec_alloc_context3: ENOMEM\n"); goto fail; }

    ret = avcodec_parameters_to_context(dec, st->codecpar);
    if (ret < 0) { log_av_err("avcodec_parameters_to_context", ret); goto fail; }

    ret = avcodec_open2(dec, codec, NULL);
    if (ret < 0) { log_av_err("avcodec_open2", ret); goto fail; }

    // Setup resampler to S16
    AVChannelLayout out_ch_layout = dec->ch_layout;
    enum AVSampleFormat out_fmt = AV_SAMPLE_FMT_S16;
    int out_rate = dec->sample_rate;

    swr = swr_alloc();
    if (!swr) { ret = AVERROR(ENOMEM); fprintf(stderr, "[ffmpegwasm] swr_alloc: ENOMEM\n"); goto fail; }

    ret = av_opt_set_chlayout(swr, "in_chlayout", &dec->ch_layout, 0);
    if (ret < 0) { log_av_err("av_opt_set_chlayout(in)", ret); goto fail; }

    ret = av_opt_set_int(swr, "in_sample_rate", dec->sample_rate, 0);
    if (ret < 0) { log_av_err("av_opt_set_int(in_sample_rate)", ret); goto fail; }

    ret = av_opt_set_sample_fmt(swr, "in_sample_fmt", dec->sample_fmt, 0);
    if (ret < 0) { log_av_err("av_opt_set_sample_fmt(in)", ret); goto fail; }

    ret = av_opt_set_chlayout(swr, "out_chlayout", &out_ch_layout, 0);
    if (ret < 0) { log_av_err("av_opt_set_chlayout(out)", ret); goto fail; }

    ret = av_opt_set_int(swr, "out_sample_rate", out_rate, 0);
    if (ret < 0) { log_av_err("av_opt_set_int(out_sample_rate)", ret); goto fail; }

    ret = av_opt_set_sample_fmt(swr, "out_sample_fmt", out_fmt, 0);
    if (ret < 0) { log_av_err("av_opt_set_sample_fmt(out)", ret); goto fail; }

    ret = swr_init(swr);
    if (ret < 0) { log_av_err("swr_init", ret); goto fail; }

    // Output file (Emscripten FS supports stdio)
    FILE* out = fopen(out_path, "wb");
    if (!out) { log_errno("fopen(out_path)"); ret = errno ? errno : 1; goto fail; }

    AVPacket* pkt = av_packet_alloc();
    AVFrame* frame = av_frame_alloc();
    if (!pkt || !frame) {
        fprintf(stderr, "[ffmpegwasm] av_packet_alloc/av_frame_alloc: ENOMEM\n");
        ret = AVERROR(ENOMEM);
        goto fail_file;
    }

    // Decode loop
    while ((ret = av_read_frame(fmt, pkt)) >= 0) {
        if (pkt->stream_index != audio_stream) {
            av_packet_unref(pkt);
            continue;
        }

        ret = avcodec_send_packet(dec, pkt);
        av_packet_unref(pkt);
        if (ret < 0) { log_av_err("avcodec_send_packet", ret); goto fail_file; }

        while ((ret = avcodec_receive_frame(dec, frame)) >= 0) {
            int64_t delay = swr_get_delay(swr, dec->sample_rate);
            int out_nb = (int)av_rescale_rnd(delay + frame->nb_samples, out_rate, dec->sample_rate, AV_ROUND_UP);

            uint8_t* out_buf = NULL;
            int out_linesize = 0;
            int out_ch = out_ch_layout.nb_channels;

            ret = av_samples_alloc(&out_buf, &out_linesize, out_ch, out_nb, out_fmt, 0);
            if (ret < 0) { log_av_err("av_samples_alloc", ret); goto fail_file; }

            int converted = swr_convert(swr, &out_buf, out_nb,
                                        (const uint8_t**)frame->extended_data, frame->nb_samples);
            if (converted < 0) {
                log_av_err("swr_convert", converted);
                av_freep(&out_buf);
                ret = converted;
                goto fail_file;
            }

            int out_bytes = av_samples_get_buffer_size(NULL, out_ch, converted, out_fmt, 1);
            if (out_bytes < 0) {
                log_av_err("av_samples_get_buffer_size", out_bytes);
                av_freep(&out_buf);
                ret = out_bytes;
                goto fail_file;
            }

            if (fwrite(out_buf, 1, (size_t)out_bytes, out) != (size_t)out_bytes) {
                log_errno("fwrite");
                av_freep(&out_buf);
                ret = errno ? errno : 1;
                goto fail_file;
            }

            av_freep(&out_buf);
            av_frame_unref(frame);
        }

        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) ret = 0;
        if (ret < 0) { log_av_err("avcodec_receive_frame(loop)", ret); goto fail_file; }
    }

    if (ret != AVERROR_EOF && ret < 0) { log_av_err("av_read_frame", ret); goto fail_file; }
    ret = 0;

    // Flush decoder
    ret = avcodec_send_packet(dec, NULL);
    if (ret < 0) { log_av_err("avcodec_send_packet(flush)", ret); goto fail_file; }

    while ((ret = avcodec_receive_frame(dec, frame)) >= 0) {
        int64_t delay = swr_get_delay(swr, dec->sample_rate);
        int out_nb = (int)av_rescale_rnd(delay + frame->nb_samples, out_rate, dec->sample_rate, AV_ROUND_UP);

        uint8_t* out_buf = NULL;
        int out_linesize = 0;
        int out_ch = out_ch_layout.nb_channels;

        int r2 = av_samples_alloc(&out_buf, &out_linesize, out_ch, out_nb, out_fmt, 0);
        if (r2 < 0) { log_av_err("av_samples_alloc(flush)", r2); ret = r2; goto fail_file; }

        int converted = swr_convert(swr, &out_buf, out_nb,
                                    (const uint8_t**)frame->extended_data, frame->nb_samples);
        if (converted < 0) {
            log_av_err("swr_convert(flush)", converted);
            av_freep(&out_buf);
            ret = converted;
            goto fail_file;
        }

        int out_bytes = av_samples_get_buffer_size(NULL, out_ch, converted, out_fmt, 1);
        if (out_bytes < 0) {
            log_av_err("av_samples_get_buffer_size(flush)", out_bytes);
            av_freep(&out_buf);
            ret = out_bytes;
            goto fail_file;
        }

        if (fwrite(out_buf, 1, (size_t)out_bytes, out) != (size_t)out_bytes) {
            log_errno("fwrite(flush)");
            av_freep(&out_buf);
            ret = errno ? errno : 1;
            goto fail_file;
        }

        av_freep(&out_buf);
        av_frame_unref(frame);
    }

    if (ret == AVERROR_EOF) ret = 0;
    if (ret == AVERROR(EAGAIN)) ret = 0;
    if (ret < 0) { log_av_err("avcodec_receive_frame(flush)", ret); goto fail_file; }

    ret = 0; // success

fail_file:
    if (out) fclose(out);
    if (pkt) av_packet_free(&pkt);
    if (frame) av_frame_free(&frame);

fail:
    if (swr) swr_free(&swr);
    if (dec) avcodec_free_context(&dec);
    if (fmt) avformat_close_input(&fmt);

    return ret;
}