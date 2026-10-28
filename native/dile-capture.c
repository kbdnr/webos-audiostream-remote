/*
 * dile-capture: writes the TV's mixed audio output to stdout as raw PCM.
 *
 * LG TVs have no ALSA capture device for their own output; the audio is mixed
 * inside the SoC. LG's DILE "PCM upload" interface taps that mix: it's what
 * btaudiosrc uses to feed Bluetooth speakers. The prototypes below were
 * recovered from libdile_audio_pcm.so.1 / libhal_audio_pcm.so.2 on webOS 4.10
 * (lg115x); LG publishes no headers.
 *
 * usage: dile-capture [-i input] [-g gain] [-t seconds] [-v]
 *   -i  HAL upload input, 0-3 (default 0, the one btaudiosrc uses)
 *   -g  upload gain: main | fine << 8, e.g. 0x7f (default: leave unchanged)
 *   -t  stop after this many seconds (default: run until SIGTERM/SIGINT)
 *   -v  print once-a-second stats to stderr
 *
 * Built for the TV's 32-bit soft-float userland; see scripts/build-native.sh.
 */
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef int (*pcm_cb)(const void *pcm, int bytes);

static int (*StartUpload)(int input);
static int (*StopUpload)(int input);
static int (*RegSendPCMCallback)(int input, pcm_cb cb);
static int (*SetVolume)(unsigned int gain); /* always applies to input 0 */

static int out_fd = 1;
static volatile sig_atomic_t stopping;
static volatile unsigned long bytes_total, chunks, chunk_min, chunk_max;
static volatile int peak;
static volatile int write_error;

static void on_signal(int sig) { (void)sig; stopping = 1; }

/* Called on the HAL's thread with interleaved S16LE frames */
static int on_pcm(const void *pcm, int bytes)
{
    const short *s = pcm;
    const char *p = pcm;
    int i, left = bytes;

    if (stopping || bytes <= 0) return 0;
    for (i = 0; i < bytes / 2; i++) {
        int v = s[i] < 0 ? -s[i] : s[i];
        if (v > peak) peak = v;
    }
    chunks++;
    bytes_total += bytes;
    if (!chunk_min || (unsigned long)bytes < chunk_min) chunk_min = bytes;
    if ((unsigned long)bytes > chunk_max) chunk_max = bytes;

    while (left > 0) {
        ssize_t n = write(out_fd, p, left);
        if (n < 0) {
            if (errno == EINTR) continue;
            write_error = errno; /* reader went away */
            stopping = 1;
            return 0;
        }
        p += n;
        left -= n;
    }
    return 0;
}

static void *need(void *lib, const char *name)
{
    void *f = dlsym(lib, name);
    if (!f) { fprintf(stderr, "dile-capture: %s missing: %s\n", name, dlerror()); exit(1); }
    return f;
}

int main(int argc, char **argv)
{
    int input = 0, seconds = 0, verbose = 0, opt, rc, elapsed = 0;
    long gain = -1;
    unsigned long last_bytes = 0;
    struct sigaction sa;
    void *lib;

    while ((opt = getopt(argc, argv, "i:g:t:v")) != -1) {
        switch (opt) {
        case 'i': input = atoi(optarg); break;
        case 'g': gain = strtol(optarg, NULL, 0); break;
        case 't': seconds = atoi(optarg); break;
        case 'v': verbose = 1; break;
        default:
            fprintf(stderr, "usage: %s [-i input] [-g gain] [-t seconds] [-v]\n", argv[0]);
            return 1;
        }
    }
    if (input < 0 || input > 3) { fprintf(stderr, "dile-capture: input must be 0-3\n"); return 1; }

    /* LG's HAL logs with printf: keep the real stdout for audio and point fd 1 at stderr */
    out_fd = dup(1);
    if (out_fd < 0 || dup2(2, 1) < 0) { perror("dile-capture: dup"); return 1; }

    lib = dlopen("libdile_audio_pcm.so.1", RTLD_NOW);
    if (!lib) { fprintf(stderr, "dile-capture: %s\n", dlerror()); return 1; }
    StartUpload = need(lib, "DILE_AUDIO_PCM_StartUpload");
    StopUpload = need(lib, "DILE_AUDIO_PCM_StopUpload");
    RegSendPCMCallback = need(lib, "DILE_AUDIO_PCM_RegSendPCMCallback");
    SetVolume = need(lib, "DILE_AUDIO_PCM_SetVolume");

    /* Always reach the cleanup below: a capture left running may need a reboot to clear */
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_signal;
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    /* Same order as btaudiosrc: start, set gain, then register the callback */
    rc = StartUpload(input);
    if (rc) { fprintf(stderr, "dile-capture: StartUpload(%d) failed (%d)\n", input, rc); return 2; }
    if (gain >= 0) {
        rc = SetVolume((unsigned int)gain);
        if (verbose) fprintf(stderr, "dile-capture: SetVolume(0x%lx) = %d\n", gain, rc);
    }
    rc = RegSendPCMCallback(input, on_pcm);
    if (rc) {
        fprintf(stderr, "dile-capture: RegSendPCMCallback(%d) failed (%d)\n", input, rc);
        StopUpload(input);
        return 2;
    }
    if (verbose) fprintf(stderr, "dile-capture: capturing input %d\n", input);

    while (!stopping && (!seconds || elapsed < seconds)) {
        struct timespec ts = { 1, 0 };
        while (nanosleep(&ts, &ts) && !stopping) {}
        if (stopping) break;
        elapsed++;
        if (verbose) {
            unsigned long b = bytes_total;
            fprintf(stderr, "dile-capture: %lu B/s, %lu chunks, chunk %lu-%lu B, peak %d/32767\n",
                    b - last_bytes, chunks, chunk_min, chunk_max, peak);
            last_bytes = b;
            peak = 0;
        }
        if (elapsed == 3 && !bytes_total) fprintf(stderr, "dile-capture: no data after 3s\n");
    }

    RegSendPCMCallback(input, NULL);
    StopUpload(input);
    if (write_error && write_error != EPIPE) fprintf(stderr, "dile-capture: write: %s\n", strerror(write_error));
    if (verbose) fprintf(stderr, "dile-capture: stopped after %lu bytes\n", bytes_total);
    return bytes_total ? 0 : 3;
}
