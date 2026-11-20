#include <windows.h>
#include <tlhelp32.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <wrl/client.h>
#include <cstdio>
#include <cstdlib>
#include <unordered_map>

using Microsoft::WRL::ComPtr;

static std::unordered_map<DWORD, DWORD> process_parents() {
    std::unordered_map<DWORD, DWORD> parents;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return parents;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry)) {
        do {
            parents.emplace(entry.th32ProcessID, entry.th32ParentProcessID);
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return parents;
}

static bool own_process(DWORD pid, DWORD parent, const std::unordered_map<DWORD, DWORD>& parents) {
    for (unsigned depth = 0; pid && depth < 64; ++depth) {
        if (pid == parent) return true;
        auto next = parents.find(pid);
        if (next == parents.end() || next->second == pid) return false;
        pid = next->second;
    }
    return false;
}

static int active_input(IMMDeviceEnumerator* devices, DWORD parent) {
    ComPtr<IMMDeviceCollection> inputs;
    if (FAILED(devices->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &inputs))) return -1;
    UINT device_count = 0;
    if (FAILED(inputs->GetCount(&device_count))) return -1;
    if (!device_count) return 0;
    const auto parents = process_parents();
    if (parents.empty()) return -1;
    bool queried = false;
    for (UINT i = 0; i < device_count; ++i) {
        ComPtr<IMMDevice> input;
        ComPtr<IAudioSessionManager2> manager;
        ComPtr<IAudioSessionEnumerator> sessions;
        int count = 0;
        if (FAILED(inputs->Item(i, &input)) ||
            FAILED(input->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                                   reinterpret_cast<void**>(manager.GetAddressOf()))) ||
            FAILED(manager->GetSessionEnumerator(&sessions)) || FAILED(sessions->GetCount(&count))) continue;
        queried = true;
        for (int j = 0; j < count; ++j) {
            ComPtr<IAudioSessionControl> session;
            ComPtr<IAudioSessionControl2> identified;
            AudioSessionState state;
            DWORD pid = 0;
            if (SUCCEEDED(sessions->GetSession(j, &session)) &&
                SUCCEEDED(session->GetState(&state)) && state == AudioSessionStateActive &&
                SUCCEEDED(session.As(&identified)) && SUCCEEDED(identified->GetProcessId(&pid)) &&
                pid && !own_process(pid, parent, parents)) return 1;
        }
    }
    return queried ? 0 : -1;
}

int main(int argc, char** argv) {
    if (argc != 2) return 2;
    DWORD parent = std::strtoul(argv[1], nullptr, 10);
    HANDLE owner = OpenProcess(SYNCHRONIZE, FALSE, parent);
    if (!owner) return 2;
    if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {
        CloseHandle(owner);
        return 1;
    }
    int result = 1;
    {
        ComPtr<IMMDeviceEnumerator> devices;
        if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                       IID_PPV_ARGS(devices.GetAddressOf())))) {
            do {
                std::printf("%d\n", active_input(devices.Get(), parent));
                if (std::fflush(stdout) == EOF) break;
            } while (WaitForSingleObject(owner, 750) == WAIT_TIMEOUT);
            result = 0;
        }
    }
    CoUninitialize();
    CloseHandle(owner);
    return result;
}
