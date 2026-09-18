// Linux driver-only NVENC bridge. No CUDA toolkit or host pixel staging.
// ABI headers are pinned to nv-codec-headers n12.1.14.0 (licenses in headers).
#include "dynlink_cuda.h"
#include "nvEncodeAPI.h"
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define CUDA_FUNCTIONS(X) \
 X(cuInit) X(cuDeviceGetCount) X(cuDeviceGet) X(cuDeviceGetUuid) \
 X(cuCtxCreate_v2) X(cuCtxDestroy_v2) X(cuStreamCreate) X(cuStreamSynchronize) X(cuStreamDestroy_v2) \
 X(cuImportExternalMemory) X(cuExternalMemoryGetMappedBuffer) X(cuDestroyExternalMemory) X(cuMemFree_v2) \
 X(cuImportExternalSemaphore) X(cuDestroyExternalSemaphore) X(cuWaitExternalSemaphoresAsync) X(cuSignalExternalSemaphoresAsync)

typedef struct {
    CUexternalMemory memory;
    CUdeviceptr pointer;
    CUexternalSemaphore ready, release;
} Slot;
typedef struct {
    void *handle;
    NV_ENC_OUTPUT_PTR output;
    NV_ENC_INPUT_PTR mapped;
    NV_ENC_REGISTERED_PTR *registered;
} Camera;
typedef struct {
    void *cuda_lib, *nv_lib;
#define DECLARE(name) t##name *name;
    CUDA_FUNCTIONS(DECLARE)
#undef DECLARE
    NV_ENCODE_API_FUNCTION_LIST api;
    CUcontext context;
    CUstream stream;
    Slot *slots;
    Camera *cameras;
    unsigned slots_count, cameras_count, width, height, pitch;
    char error[512];
} Session;

static int fail(Session *s, const char *operation, int code) {
    snprintf(s->error, sizeof(s->error), "%s failed: %d", operation, code);
    return -1;
}
#define CU(call) do { CUresult rc = (call); if (rc != CUDA_SUCCESS) return fail(s, #call, rc); } while (0)
#define NV(call) do { NVENCSTATUS rc = (call); if (rc != NV_ENC_SUCCESS) return fail(s, #call, rc); } while (0)

static int initialize(Session *s, const unsigned char *uuid, int *fds, uint64_t allocation_bytes,
    uint64_t slot_bytes, const uint64_t *offsets, unsigned fps_num, unsigned fps_den, unsigned quality) {
    s->cuda_lib = dlopen("libcuda.so.1", RTLD_NOW | RTLD_LOCAL);
    s->nv_lib = dlopen("libnvidia-encode.so.1", RTLD_NOW | RTLD_LOCAL);
    if (!s->cuda_lib || !s->nv_lib) { snprintf(s->error, sizeof(s->error), "CUDA/NVENC driver libraries unavailable: %s", dlerror()); return -1; }
#define LOAD(name) s->name = (t##name *)dlsym(s->cuda_lib, #name); if (!s->name) return fail(s, #name " unavailable", -1);
    CUDA_FUNCTIONS(LOAD)
#undef LOAD
    typedef NVENCSTATUS (NVENCAPI *CreateInstance)(NV_ENCODE_API_FUNCTION_LIST *);
    CreateInstance create = (CreateInstance)dlsym(s->nv_lib, "NvEncodeAPICreateInstance");
    if (!create) return fail(s, "NvEncodeAPICreateInstance unavailable", -1);
    s->api.version = NV_ENCODE_API_FUNCTION_LIST_VER;
    NV(create(&s->api));
    CU(s->cuInit(0));
    int count = 0;
    CU(s->cuDeviceGetCount(&count));
    CUdevice device = -1;
    for (int i = 0; i < count; i++) {
        CUdevice candidate; CUuuid id;
        CU(s->cuDeviceGet(&candidate, i));
        CU(s->cuDeviceGetUuid(&id, candidate));
        if (memcmp(id.bytes, uuid, 16) == 0) { device = candidate; break; }
    }
    if (device < 0) return fail(s, "Vulkan/CUDA physical device UUID mismatch", -1);
    CU(s->cuCtxCreate_v2(&s->context, CU_CTX_SCHED_BLOCKING_SYNC, device));
    CU(s->cuStreamCreate(&s->stream, 0));
    for (unsigned i = 0; i < s->slots_count; i++) {
        CUDA_EXTERNAL_MEMORY_HANDLE_DESC memory = {0};
        memory.type = CU_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD;
        memory.handle.fd = fds[i*3]; memory.size = allocation_bytes; memory.flags = 1; // dedicated allocation
        CU(s->cuImportExternalMemory(&s->slots[i].memory, &memory));
        fds[i*3] = -1; // CUDA owns imported opaque-fd handles only after success.
        CUDA_EXTERNAL_MEMORY_BUFFER_DESC buffer = {0}; buffer.size = slot_bytes;
        CU(s->cuExternalMemoryGetMappedBuffer(&s->slots[i].pointer, s->slots[i].memory, &buffer));
        CUDA_EXTERNAL_SEMAPHORE_HANDLE_DESC semaphore = {0};
        semaphore.type = CU_EXTERNAL_SEMAPHORE_HANDLE_TYPE_TIMELINE_SEMAPHORE_FD;
        semaphore.handle.fd = fds[i*3+1];
        CU(s->cuImportExternalSemaphore(&s->slots[i].ready, &semaphore)); fds[i*3+1] = -1;
        semaphore.handle.fd = fds[i*3+2];
        CU(s->cuImportExternalSemaphore(&s->slots[i].release, &semaphore)); fds[i*3+2] = -1;
    }
    for (unsigned i = 0; i < s->cameras_count; i++) {
        Camera *c = &s->cameras[i];
        NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open = {0};
        open.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
        open.deviceType = NV_ENC_DEVICE_TYPE_CUDA; open.device = s->context; open.apiVersion = NVENCAPI_VERSION;
        NV(s->api.nvEncOpenEncodeSessionEx(&open, &c->handle));
        NV_ENC_PRESET_CONFIG preset = {0};
        preset.version = NV_ENC_PRESET_CONFIG_VER; preset.presetCfg.version = NV_ENC_CONFIG_VER;
        NV(s->api.nvEncGetEncodePresetConfigEx(c->handle, NV_ENC_CODEC_H264_GUID, NV_ENC_PRESET_P4_GUID, NV_ENC_TUNING_INFO_HIGH_QUALITY, &preset));
        NV_ENC_CONFIG config = preset.presetCfg;
        config.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
        config.gopLength = 50; config.frameIntervalP = 1; // no reorder: one output per input
        config.rcParams.rateControlMode = NV_ENC_PARAMS_RC_VBR;
        config.rcParams.averageBitRate = 0; config.rcParams.maxBitRate = 0;
        config.rcParams.targetQuality = quality; config.rcParams.targetQualityLSB = 0;
        config.rcParams.enableLookahead = 0; config.rcParams.lookaheadDepth = 0;
        config.encodeCodecConfig.h264Config.idrPeriod = 50;
        config.encodeCodecConfig.h264Config.repeatSPSPPS = 1;
        NV_ENC_INITIALIZE_PARAMS init = {0};
        init.version = NV_ENC_INITIALIZE_PARAMS_VER;
        init.encodeGUID = NV_ENC_CODEC_H264_GUID; init.presetGUID = NV_ENC_PRESET_P4_GUID;
        init.tuningInfo = NV_ENC_TUNING_INFO_HIGH_QUALITY;
        init.encodeWidth = s->width; init.encodeHeight = s->height;
        init.darWidth = s->width; init.darHeight = s->height;
        init.frameRateNum = fps_num; init.frameRateDen = fps_den;
        init.enablePTD = 1; init.encodeConfig = &config;
        NV(s->api.nvEncInitializeEncoder(c->handle, &init));
        NV_ENC_CREATE_BITSTREAM_BUFFER bitstream = {0}; bitstream.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
        NV(s->api.nvEncCreateBitstreamBuffer(c->handle, &bitstream)); c->output = bitstream.bitstreamBuffer;
        c->registered = calloc(s->slots_count, sizeof(*c->registered));
        if (!c->registered) return fail(s, "allocate registered resources", -1);
        for (unsigned j = 0; j < s->slots_count; j++) {
            NV_ENC_REGISTER_RESOURCE resource = {0}; resource.version = NV_ENC_REGISTER_RESOURCE_VER;
            resource.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_CUDADEVICEPTR;
            resource.resourceToRegister = (void *)(uintptr_t)(s->slots[j].pointer + offsets[i]);
            resource.width = s->width; resource.height = s->height; resource.pitch = s->pitch;
            // ABGR is the little-endian word layout of the renderer's R,G,B,A bytes.
            resource.bufferFormat = NV_ENC_BUFFER_FORMAT_ABGR;
            resource.bufferUsage = NV_ENC_INPUT_IMAGE;
            NV(s->api.nvEncRegisterResource(c->handle, &resource));
            c->registered[j] = resource.registeredResource;
        }
    }
    return 0;
}

void sensor_nvenc_destroy(Session *s) {
    if (!s) return;
    if (s->stream) s->cuStreamSynchronize(s->stream);
    if (s->cameras) for (unsigned i = 0; i < s->cameras_count; i++) {
        Camera *c = &s->cameras[i];
        if (c->handle) {
            if (c->mapped) s->api.nvEncUnmapInputResource(c->handle, c->mapped);
            if (c->registered) for (unsigned j = 0; j < s->slots_count; j++)
                if (c->registered[j]) s->api.nvEncUnregisterResource(c->handle, c->registered[j]);
            if (c->output) s->api.nvEncDestroyBitstreamBuffer(c->handle, c->output);
            s->api.nvEncDestroyEncoder(c->handle);
        }
        free(c->registered);
    }
    if (s->slots) for (unsigned i = 0; i < s->slots_count; i++) {
        Slot *slot = &s->slots[i];
        if (slot->pointer) s->cuMemFree_v2(slot->pointer);
        if (slot->memory) s->cuDestroyExternalMemory(slot->memory);
        if (slot->ready) s->cuDestroyExternalSemaphore(slot->ready);
        if (slot->release) s->cuDestroyExternalSemaphore(slot->release);
    }
    if (s->stream) s->cuStreamDestroy_v2(s->stream);
    if (s->context) s->cuCtxDestroy_v2(s->context);
    if (s->nv_lib) dlclose(s->nv_lib);
    if (s->cuda_lib) dlclose(s->cuda_lib);
    free(s->slots); free(s->cameras); free(s);
}

Session *sensor_nvenc_create(const unsigned char *uuid, unsigned slots, unsigned cameras,
    int *fds, uint64_t allocation_bytes, uint64_t slot_bytes, const uint64_t *offsets,
    unsigned width, unsigned height, unsigned pitch, unsigned fps_num, unsigned fps_den,
    unsigned quality, char *error, size_t error_size) {
    Session *s = calloc(1, sizeof(*s));
    if (!s) { snprintf(error,error_size,"allocate NVENC session failed"); for(unsigned i=0;i<slots*3;i++) close(fds[i]); return NULL; }
    s->slots_count=slots; s->cameras_count=cameras; s->width=width; s->height=height; s->pitch=pitch;
    s->slots=calloc(slots,sizeof(*s->slots)); s->cameras=calloc(cameras,sizeof(*s->cameras));
    int rc = (!s->slots || !s->cameras) ? fail(s,"allocate NVENC slots",-1)
        : initialize(s,uuid,fds,allocation_bytes,slot_bytes,offsets,fps_num,fps_den,quality);
    for(unsigned i=0;i<slots*3;i++) if(fds[i]>=0) { close(fds[i]); fds[i]=-1; }
    if (rc) { snprintf(error,error_size,"%s",s->error); sensor_nvenc_destroy(s); return NULL; }
    return s;
}

const char *sensor_nvenc_error(Session *s) { return s->error; }
int sensor_nvenc_begin(Session *s, unsigned slot, uint64_t generation) {
    if (slot >= s->slots_count) return fail(s,"invalid slot",-1);
    CUDA_EXTERNAL_SEMAPHORE_WAIT_PARAMS params = {0}; params.params.fence.value = generation;
    CU(s->cuWaitExternalSemaphoresAsync(&s->slots[slot].ready,&params,1,s->stream));
    CU(s->cuStreamSynchronize(s->stream));
    return 0;
}
int sensor_nvenc_encode(Session *s, unsigned camera, unsigned slot, uint64_t frame, const unsigned char **data, unsigned *bytes) {
    if (camera >= s->cameras_count || slot >= s->slots_count) return fail(s,"invalid frame resource",-1);
    Camera *c=&s->cameras[camera];
    NV_ENC_MAP_INPUT_RESOURCE map={0}; map.version=NV_ENC_MAP_INPUT_RESOURCE_VER; map.registeredResource=c->registered[slot];
    NV(s->api.nvEncMapInputResource(c->handle,&map)); c->mapped=map.mappedResource;
    NV_ENC_PIC_PARAMS pic={0}; pic.version=NV_ENC_PIC_PARAMS_VER;
    pic.inputWidth=s->width; pic.inputHeight=s->height; pic.inputPitch=s->pitch;
    pic.inputBuffer=c->mapped; pic.bufferFmt=NV_ENC_BUFFER_FORMAT_ABGR; pic.outputBitstream=c->output;
    pic.pictureStruct=NV_ENC_PIC_STRUCT_FRAME; pic.inputTimeStamp=frame; pic.inputDuration=1;
    NV(s->api.nvEncEncodePicture(c->handle,&pic));
    NV_ENC_LOCK_BITSTREAM lock={0}; lock.version=NV_ENC_LOCK_BITSTREAM_VER; lock.outputBitstream=c->output;
    NV(s->api.nvEncLockBitstream(c->handle,&lock));
    *data=lock.bitstreamBufferPtr; *bytes=lock.bitstreamSizeInBytes;
    return 0;
}
int sensor_nvenc_unlock(Session *s, unsigned camera) {
    Camera *c=&s->cameras[camera];
    NV(s->api.nvEncUnlockBitstream(c->handle,c->output));
    NV(s->api.nvEncUnmapInputResource(c->handle,c->mapped)); c->mapped=NULL;
    return 0;
}
int sensor_nvenc_release(Session *s, unsigned slot, uint64_t generation) {
    CUDA_EXTERNAL_SEMAPHORE_SIGNAL_PARAMS params={0}; params.params.fence.value=generation;
    CU(s->cuSignalExternalSemaphoresAsync(&s->slots[slot].release,&params,1,s->stream));
    CU(s->cuStreamSynchronize(s->stream));
    return 0;
}
int sensor_nvenc_finish(Session *s) {
    for(unsigned i=0;i<s->cameras_count;i++) {
        NV_ENC_PIC_PARAMS pic={0}; pic.version=NV_ENC_PIC_PARAMS_VER; pic.encodePicFlags=NV_ENC_PIC_FLAG_EOS;
        NV(s->api.nvEncEncodePicture(s->cameras[i].handle,&pic));
    }
    return 0;
}
