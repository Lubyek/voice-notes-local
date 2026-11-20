#include <CoreAudio/CoreAudio.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static AudioObjectPropertyAddress address(AudioObjectPropertySelector selector) {
    return (AudioObjectPropertyAddress){selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
}

static OSStatus read_property(AudioObjectID object, AudioObjectPropertySelector selector, void *result, UInt32 size) {
    AudioObjectPropertyAddress property = address(selector);
    return AudioObjectGetPropertyData(object, &property, 0, NULL, &size, result);
}

static int own_process(pid_t pid, pid_t parent) {
    while (pid > 1) {
        if (pid == parent) return 1;
        struct proc_bsdinfo info = {0};
        if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) ||
            info.pbi_ppid == (unsigned)pid) break;
        pid = (pid_t)info.pbi_ppid;
    }
    return 0;
}

static int active_input(pid_t parent) {
    AudioObjectPropertyAddress list = address(kAudioHardwarePropertyProcessObjectList);
    AudioObjectID system = kAudioObjectSystemObject;
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(system, &list, 0, NULL, &size) != noErr) return -1;
    if (!size) return 0;
    AudioObjectID *processes = malloc(size);
    if (!processes) return -1;
    int active = -1;
    if (AudioObjectGetPropertyData(system, &list, 0, NULL, &size, processes) == noErr) {
        active = 0;
        for (UInt32 i = 0; i < size / sizeof(*processes); ++i) {
            UInt32 running = 0;
            pid_t pid = 0;
            if (read_property(processes[i], kAudioProcessPropertyIsRunningInput, &running, sizeof(running)) == noErr &&
                running && read_property(processes[i], kAudioProcessPropertyPID, &pid, sizeof(pid)) == noErr &&
                pid > 0 && !own_process(pid, parent)) {
                active = 1;
                break;
            }
        }
    }
    free(processes);
    return active;
}

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    const pid_t parent = (pid_t)strtol(argv[1], NULL, 10);
    if (parent <= 1) return 2;
    while (getppid() == parent) {
        printf("%d\n", active_input(parent));
        if (fflush(stdout) == EOF) break;
        usleep(750000);
    }
    return 0;
}
