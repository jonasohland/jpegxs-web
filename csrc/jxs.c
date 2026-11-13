/*
 * Thin C shim over the SVT-JPEG-XS decoder/encoder API for the JS wrapper.
 *
 * Only plain integers and pointers cross the boundary (no embind). Results
 * that describe an image are written into a caller-provided uint32_t array
 * laid out as described by the JXS_INFO_* indices below; the TypeScript side
 * mirrors these constants (src/abi.ts).
 *
 * Planes are always passed as one contiguous buffer: component 0 followed by
 * component 1, ... each tightly packed (stride == component width), 1 byte per
 * sample for bit depth <= 8, otherwise 2 bytes (little endian).
 *
 * All functions return an SvtJxsErrorType_t value (0 on success).
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten/emscripten.h>

#include "SvtJpegxsDec.h"
#include "SvtJpegxsEnc.h"

#define JXS_EXPORT EMSCRIPTEN_KEEPALIVE

/* Layout of the uint32_t info array. */
enum {
    JXS_INFO_WIDTH = 0,
    JXS_INFO_HEIGHT = 1,
    JXS_INFO_BIT_DEPTH = 2,
    JXS_INFO_FORMAT = 3,
    JXS_INFO_COMPONENTS = 4,
    /* Decoder: size of the first codestream frame in bytes.
     * Encoder: size of an encoded frame in bytes. */
    JXS_INFO_FRAME_SIZE = 5,
    /* Sum of the component byte sizes = size of the contiguous planes buffer. */
    JXS_INFO_PLANES_SIZE = 6,
    /* Per component i: width, height, byte_size at JXS_INFO_COMP + 3 * i. */
    JXS_INFO_COMP = 8,
    JXS_INFO_LEN = JXS_INFO_COMP + 3 * MAX_COMPONENTS_NUM
};

/* Indices of the int32_t encoder parameter array. A negative value keeps the
 * library default (only meaningful for optional parameters). */
enum {
    JXS_ENC_WIDTH = 0,
    JXS_ENC_HEIGHT,
    JXS_ENC_BIT_DEPTH,
    JXS_ENC_FORMAT,
    JXS_ENC_BPP_NUMERATOR,
    JXS_ENC_BPP_DENOMINATOR,
    JXS_ENC_DECOMP_V,
    JXS_ENC_DECOMP_H,
    JXS_ENC_QUANTIZATION,
    JXS_ENC_SLICE_HEIGHT,
    JXS_ENC_THREADS,
    JXS_ENC_CPU_PROFILE,
    JXS_ENC_CODING_SIGNS,
    JXS_ENC_CODING_SIGNIFICANCE,
    JXS_ENC_RATE_CONTROL,
    JXS_ENC_CODING_VPRED,
    JXS_ENC_VERBOSE,
    JXS_ENC_PARAMS_LEN
};

static void fill_info(const svt_jpeg_xs_image_config_t *cfg, uint32_t frame_size, uint32_t *info) {
    memset(info, 0, JXS_INFO_LEN * sizeof(uint32_t));
    info[JXS_INFO_WIDTH] = cfg->width;
    info[JXS_INFO_HEIGHT] = cfg->height;
    info[JXS_INFO_BIT_DEPTH] = cfg->bit_depth;
    info[JXS_INFO_FORMAT] = (uint32_t)cfg->format;
    info[JXS_INFO_COMPONENTS] = cfg->components_num;
    info[JXS_INFO_FRAME_SIZE] = frame_size;
    uint32_t total = 0;
    for (uint32_t c = 0; c < cfg->components_num && c < MAX_COMPONENTS_NUM; ++c) {
        info[JXS_INFO_COMP + 3 * c + 0] = cfg->components[c].width;
        info[JXS_INFO_COMP + 3 * c + 1] = cfg->components[c].height;
        info[JXS_INFO_COMP + 3 * c + 2] = cfg->components[c].byte_size;
        total += cfg->components[c].byte_size;
    }
    info[JXS_INFO_PLANES_SIZE] = total;
}

/* Point the image buffer's components into one contiguous buffer. */
static int32_t setup_planes(const svt_jpeg_xs_image_config_t *cfg, uint8_t *planes, uint32_t planes_size,
                            svt_jpeg_xs_image_buffer_t *img) {
    memset(img, 0, sizeof(*img));
    uint32_t offset = 0;
    for (uint32_t c = 0; c < cfg->components_num; ++c) {
        uint32_t size = cfg->components[c].byte_size;
        if (size > planes_size - offset) {
            return SvtJxsErrorBadParameter;
        }
        img->data_yuv[c] = planes + offset;
        img->stride[c] = cfg->components[c].width;
        img->alloc_size[c] = size;
        offset += size;
    }
    return SvtJxsErrorNone;
}

JXS_EXPORT uint32_t jxs_info_len(void) {
    return JXS_INFO_LEN;
}

JXS_EXPORT uint32_t jxs_enc_params_len(void) {
    return JXS_ENC_PARAMS_LEN;
}

JXS_EXPORT uint32_t jxs_api_version(void) {
    return (SVT_JPEGXS_API_VER_MAJOR << 16) | SVT_JPEGXS_API_VER_MINOR;
}

/* ---------------------------------------------------------------- decoder */

JXS_EXPORT int32_t jxs_probe(const uint8_t *buf, uint32_t len, int32_t proxy, uint32_t *info) {
    svt_jpeg_xs_image_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    uint32_t frame_size = 0;
    SvtJxsErrorType_t err = svt_jpeg_xs_decoder_get_single_frame_size_with_proxy(
        buf, len, &cfg, &frame_size, 1 /*fast_search*/, (proxy_mode_t)proxy);
    if (err != SvtJxsErrorNone) {
        return err;
    }
    fill_info(&cfg, frame_size, info);
    return SvtJxsErrorNone;
}

typedef struct jxs_decoder {
    svt_jpeg_xs_decoder_api_t api;
    svt_jpeg_xs_image_config_t cfg;
} jxs_decoder_t;

/* Create a decoder for codestreams shaped like the one in buf (the decoder is
 * bound to its resolution / format). Fills info like jxs_probe. */
JXS_EXPORT int32_t jxs_decoder_open(const uint8_t *buf, uint32_t len, int32_t proxy, int32_t threads, int32_t verbose,
                                    uint32_t *info, jxs_decoder_t **out) {
    *out = NULL;
    uint32_t frame_size = 0;
    SvtJxsErrorType_t err = svt_jpeg_xs_decoder_get_single_frame_size_with_proxy(
        buf, len, NULL, &frame_size, 1, (proxy_mode_t)proxy);
    if (err != SvtJxsErrorNone) {
        return err;
    }
    jxs_decoder_t *dec = calloc(1, sizeof(*dec));
    if (!dec) {
        return SvtJxsErrorInsufficientResources;
    }
    dec->api.verbose = verbose < 0 ? VERBOSE_NONE : (uint32_t)verbose;
    dec->api.threads_num = threads < 0 ? 0 : (uint32_t)threads;
    dec->api.use_cpu_flags = CPU_FLAGS_ALL;
    dec->api.packetization_mode = 0;
    dec->api.proxy_mode = (proxy_mode_t)proxy;
    err = svt_jpeg_xs_decoder_init(
        SVT_JPEGXS_API_VER_MAJOR, SVT_JPEGXS_API_VER_MINOR, &dec->api, buf, frame_size, &dec->cfg);
    if (err != SvtJxsErrorNone) {
        free(dec);
        return err;
    }
    fill_info(&dec->cfg, frame_size, info);
    *out = dec;
    return SvtJxsErrorNone;
}

/* Decode one frame (the first one in buf) into the contiguous planes buffer.
 * Returns SvtJxsErrorDecoderConfigChange if the frame does not match the
 * decoder's configuration; the caller should then reopen the decoder. */
JXS_EXPORT int32_t jxs_decoder_decode(jxs_decoder_t *dec, const uint8_t *buf, uint32_t len, uint8_t *planes,
                                      uint32_t planes_size) {
    if (!dec || !buf || !planes) {
        return SvtJxsErrorDecoderInvalidPointer;
    }
    uint32_t frame_size = 0;
    SvtJxsErrorType_t err = svt_jpeg_xs_decoder_get_single_frame_size_with_proxy(
        buf, len, NULL, &frame_size, 1, dec->api.proxy_mode);
    if (err != SvtJxsErrorNone) {
        return err;
    }
    if (frame_size > len) {
        return SvtJxsErrorDecoderBitstreamTooShort;
    }

    svt_jpeg_xs_frame_t in;
    memset(&in, 0, sizeof(in));
    err = setup_planes(&dec->cfg, planes, planes_size, &in.image);
    if (err != SvtJxsErrorNone) {
        return err;
    }
    /* Frame mode reads the bitstream in place and never writes to it. */
    in.bitstream.buffer = (uint8_t *)buf;
    in.bitstream.allocation_size = frame_size;
    in.bitstream.used_size = frame_size;

    err = svt_jpeg_xs_decoder_send_frame(&dec->api, &in, 1 /*blocking*/);
    if (err != SvtJxsErrorNone) {
        return err;
    }
    svt_jpeg_xs_frame_t out;
    memset(&out, 0, sizeof(out));
    return svt_jpeg_xs_decoder_get_frame(&dec->api, &out, 1 /*blocking*/);
}

JXS_EXPORT void jxs_decoder_close(jxs_decoder_t *dec) {
    if (!dec) {
        return;
    }
    svt_jpeg_xs_decoder_close(&dec->api);
    free(dec);
}

/* ---------------------------------------------------------------- encoder */

typedef struct jxs_encoder {
    svt_jpeg_xs_encoder_api_t api;
    svt_jpeg_xs_image_config_t cfg;
    uint32_t bytes_per_frame;
} jxs_encoder_t;

static int32_t encoder_configure(const int32_t *p, svt_jpeg_xs_encoder_api_t *api) {
    SvtJxsErrorType_t err = svt_jpeg_xs_encoder_load_default_parameters(
        SVT_JPEGXS_API_VER_MAJOR, SVT_JPEGXS_API_VER_MINOR, api);
    if (err != SvtJxsErrorNone) {
        return err;
    }
    if (p[JXS_ENC_WIDTH] <= 0 || p[JXS_ENC_HEIGHT] <= 0 || p[JXS_ENC_BIT_DEPTH] <= 0 || p[JXS_ENC_FORMAT] <= 0 ||
        p[JXS_ENC_BPP_NUMERATOR] <= 0) {
        return SvtJxsErrorBadParameter;
    }
    api->source_width = (uint32_t)p[JXS_ENC_WIDTH];
    api->source_height = (uint32_t)p[JXS_ENC_HEIGHT];
    api->input_bit_depth = (uint8_t)p[JXS_ENC_BIT_DEPTH];
    api->colour_format = (ColourFormat_t)p[JXS_ENC_FORMAT];
    api->bpp_numerator = (uint32_t)p[JXS_ENC_BPP_NUMERATOR];
#define OPT(idx, field, type) \
    if (p[idx] >= 0)          \
    api->field = (type)p[idx]
    OPT(JXS_ENC_BPP_DENOMINATOR, bpp_denominator, uint32_t);
    OPT(JXS_ENC_DECOMP_V, ndecomp_v, uint32_t);
    OPT(JXS_ENC_DECOMP_H, ndecomp_h, uint32_t);
    OPT(JXS_ENC_QUANTIZATION, quantization, uint32_t);
    OPT(JXS_ENC_SLICE_HEIGHT, slice_height, uint32_t);
    OPT(JXS_ENC_THREADS, threads_num, uint32_t);
    OPT(JXS_ENC_CPU_PROFILE, cpu_profile, uint8_t);
    OPT(JXS_ENC_CODING_SIGNS, coding_signs_handling, uint32_t);
    OPT(JXS_ENC_CODING_SIGNIFICANCE, coding_significance, uint32_t);
    OPT(JXS_ENC_RATE_CONTROL, rate_control_mode, uint32_t);
    OPT(JXS_ENC_CODING_VPRED, coding_vertical_prediction_mode, uint32_t);
    OPT(JXS_ENC_VERBOSE, verbose, uint32_t);
#undef OPT
    if (p[JXS_ENC_VERBOSE] < 0) {
        api->verbose = VERBOSE_NONE;
    }
    if (api->bpp_denominator == 0) {
        return SvtJxsErrorBadParameter;
    }
    return SvtJxsErrorNone;
}

/* Fill info with the input image layout and encoded frame size for the given
 * parameters, without creating an encoder. */
JXS_EXPORT int32_t jxs_encoder_config(const int32_t *params, uint32_t *info) {
    svt_jpeg_xs_encoder_api_t api;
    int32_t err = encoder_configure(params, &api);
    if (err != SvtJxsErrorNone) {
        return err;
    }
    svt_jpeg_xs_image_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    uint32_t bytes_per_frame = 0;
    err = svt_jpeg_xs_encoder_get_image_config(
        SVT_JPEGXS_API_VER_MAJOR, SVT_JPEGXS_API_VER_MINOR, &api, &cfg, &bytes_per_frame);
    if (err != SvtJxsErrorNone) {
        return err;
    }
    fill_info(&cfg, bytes_per_frame, info);
    return SvtJxsErrorNone;
}

JXS_EXPORT int32_t jxs_encoder_open(const int32_t *params, uint32_t *info, jxs_encoder_t **out) {
    *out = NULL;
    jxs_encoder_t *enc = calloc(1, sizeof(*enc));
    if (!enc) {
        return SvtJxsErrorInsufficientResources;
    }
    int32_t err = encoder_configure(params, &enc->api);
    if (err == SvtJxsErrorNone) {
        err = svt_jpeg_xs_encoder_get_image_config(
            SVT_JPEGXS_API_VER_MAJOR, SVT_JPEGXS_API_VER_MINOR, &enc->api, &enc->cfg, &enc->bytes_per_frame);
    }
    if (err == SvtJxsErrorNone) {
        err = svt_jpeg_xs_encoder_init(SVT_JPEGXS_API_VER_MAJOR, SVT_JPEGXS_API_VER_MINOR, &enc->api);
    }
    if (err != SvtJxsErrorNone) {
        free(enc);
        return err;
    }
    fill_info(&enc->cfg, enc->bytes_per_frame, info);
    *out = enc;
    return SvtJxsErrorNone;
}

/* Encode one frame from the contiguous planes buffer into out (capacity
 * out_cap, at least the encoder's frame size). *out_used receives the
 * codestream length. */
JXS_EXPORT int32_t jxs_encoder_encode(jxs_encoder_t *enc, const uint8_t *planes, uint32_t planes_size, uint8_t *out,
                                      uint32_t out_cap, uint32_t *out_used) {
    *out_used = 0;
    if (!enc || !planes || !out) {
        return SvtJxsErrorBadParameter;
    }
    if (out_cap < enc->bytes_per_frame) {
        return SvtJxsErrorBadParameter;
    }
    svt_jpeg_xs_frame_t in;
    memset(&in, 0, sizeof(in));
    /* The encoder only reads the input planes. */
    int32_t err = setup_planes(&enc->cfg, (uint8_t *)planes, planes_size, &in.image);
    if (err != SvtJxsErrorNone) {
        return err;
    }
    in.bitstream.buffer = out;
    in.bitstream.allocation_size = out_cap;
    in.bitstream.used_size = 0;

    err = svt_jpeg_xs_encoder_send_picture(&enc->api, &in, 1 /*blocking*/);
    if (err != SvtJxsErrorNone) {
        return err;
    }
    svt_jpeg_xs_frame_t res;
    memset(&res, 0, sizeof(res));
    err = svt_jpeg_xs_encoder_get_packet(&enc->api, &res, 1 /*blocking*/);
    if (err != SvtJxsErrorNone) {
        return err;
    }
    /* Codestream packetization mode: one packet holds the whole frame, in
     * the buffer we passed in. */
    if (res.bitstream.used_size > out_cap) {
        return SvtJxsErrorEncodeFrameError;
    }
    if (res.bitstream.buffer != out) {
        memmove(out, res.bitstream.buffer, res.bitstream.used_size);
    }
    *out_used = res.bitstream.used_size;
    return SvtJxsErrorNone;
}

JXS_EXPORT void jxs_encoder_close(jxs_encoder_t *enc) {
    if (!enc) {
        return;
    }
    svt_jpeg_xs_encoder_close(&enc->api);
    free(enc);
}
