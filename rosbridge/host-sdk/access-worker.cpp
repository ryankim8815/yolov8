// One SDK session owns access and operator-confirmed joint moves.
#include "DRFLEx.h"
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <mutex>
#include <poll.h>
#include <unistd.h>

using namespace std::chrono;
static std::atomic<bool> down{false}, initialized{false}, held{false};
static std::atomic<long long> last_frame{0};
static std::atomic<unsigned> grant_number{0};
static std::atomic<bool> in_move{false};
static std::atomic<long long> motion_pulse{0};
static std::mutex output;

static long long now_ms() {
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}
static void event(const char* key, const char* value) {
    std::lock_guard<std::mutex> lock(output);
    std::printf("E0509 %s %s\n", key, value);
    std::fflush(stdout);
}
static const char* state_name(ROBOT_STATE s) {
    switch (s) {
        case STATE_STANDBY: return "STANDBY";
        case STATE_SAFE_OFF: return "SAFE_OFF";
        case STATE_MOVING: return "MOVING";
        case STATE_SAFE_STOP: return "SAFE_STOP";
        case STATE_EMERGENCY_STOP: return "EMERGENCY_STOP";
        default: return "OTHER";
    }
}
static void servo_on(DRAFramework::CDRFLEx& sdk, const char* command) {
    unsigned grant;
    char token[33], extra;
    if (std::sscanf(command, "servo %u %32[0123456789abcdef] %c", &grant, token, &extra) != 2 ||
        std::strlen(token) != 32) return;
    const auto mode = sdk.get_robot_mode();
    const bool ready = (mode == ROBOT_MODE_MANUAL || mode == ROBOT_MODE_AUTONOMOUS) &&
                       sdk.get_robot_system() == ROBOT_SYSTEM_REAL && sdk.get_robot_state() == STATE_SAFE_OFF &&
                       initialized && !down && held && grant == grant_number.load() && !in_move &&
                       last_frame.load() && now_ms() - last_frame.load() <= 2000;
    const bool accepted = ready && sdk.set_robot_control(CONTROL_SERVO_ON);
    char result[48];
    std::snprintf(result, sizeof(result), "%s %s", token, accepted ? "accepted" : "refused");
    event("servo", result);
}

// A failed setter can leave the cached getter showing the requested mode.
static bool mode_verified = true;
static void set_operation_mode(DRAFramework::CDRFLEx& sdk, const char* command) {
    unsigned grant;
    char token[33], target[8], extra;
    if (std::sscanf(command, "mode %u %32[0123456789abcdef] %7s %c", &grant, token, target, &extra) != 3 ||
        std::strlen(token) != 32 || (std::strcmp(target,"AUTO") && std::strcmp(target,"MANUAL"))) return;
    const auto desired = !std::strcmp(target,"AUTO") ? ROBOT_MODE_AUTONOMOUS : ROBOT_MODE_MANUAL;
    const auto current = sdk.get_robot_mode();
    auto authorized = [&] { return initialized && !down && held && grant == grant_number.load() &&
                                  last_frame.load() && now_ms() - last_frame.load() <= 2000; };
    bool ready = (current == ROBOT_MODE_MANUAL || current == ROBOT_MODE_AUTONOMOUS) &&
                 sdk.get_robot_system() == ROBOT_SYSTEM_REAL && sdk.get_robot_state() == STATE_STANDBY &&
                 !in_move && authorized();
    mode_verified = ready && sdk.set_robot_mode(desired) && sdk.get_robot_mode() == desired && authorized();
    char result[48];
    std::snprintf(result, sizeof(result), "%s %s", token, mode_verified ? target : "failed");
    event("mode_result", result);
}

static void move_pose(DRAFramework::CDRFLEx& sdk, const char* command) {
    unsigned grant;
    float speed, acceleration, joints[6];
    char extra;
    if (std::sscanf(command, "move %u %f %f %f %f %f %f %f %f %c", &grant, &speed, &acceleration,
                    &joints[0], &joints[1], &joints[2], &joints[3], &joints[4], &joints[5], &extra) != 9 ||
        !(speed > 0 && speed <= 10 && acceleration > 0 && acceleration <= 10)) {
        event("pose", "refused"); return;
    }
    const float limits[] = {360, 360, 155, 360, 155, 360};
    for (int i = 0; i < 6; ++i) {
        if (!std::isfinite(joints[i]) || std::abs(joints[i]) > limits[i]) {
            event("pose", "refused"); return;
        }
    }
    if (!mode_verified || sdk.get_robot_state() != STATE_STANDBY || sdk.get_robot_mode() != ROBOT_MODE_AUTONOMOUS ||
        sdk.get_robot_system() != ROBOT_SYSTEM_REAL || down || !initialized || !held ||
        grant != grant_number.load() || now_ms() - last_frame.load() > 2000) {
        event("pose", "refused"); return;
    }
    in_move = true;
    const bool completed = sdk.movej(joints, speed, acceleration, 0, MOVE_MODE_ABSOLUTE, 0);
    in_move = false;
    event("pose", completed ? "completed" : "failed");
}

int main() {
    DRAFramework::CDRFLEx sdk;
    const char *version = sdk.get_library_version(), *ip = std::getenv("ROBOT_IP"), *port = std::getenv("ROBOT_PORT");
    event("sdk", version);
    if (std::strcmp(version, "GL010117") || !ip || !port) return 1;
    event("feature", "servo_on");
    event("feature", "operation_mode");
    sdk.set_on_disconnected([] { down = true; event("disconnect", "SDK disconnected"); });
    sdk.set_on_monitoring_data([](const LPMONITORING_DATA data) {
        if (!data) return;
        for (const auto angle : data->_tCtrl._tJoint._fActualPos) if (!std::isfinite(angle)) return;
        const auto now = now_ms();
        last_frame = now;
        // A synchronous movej can outlast the supervisor timeout. Only real monitoring
        // frames keep the session alive while the main thread waits for its result.
        if (in_move && now - motion_pulse.load() >= 500) {
            motion_pulse = now;
            event("motion_frame", "live");
        }
    });
    sdk.set_on_tp_initializing_completed([] { initialized = true; });
    sdk.set_on_monitoring_access_control([](const MONITORING_ACCESS_CONTROL access) {
        switch (access) {
            case MONITORING_ACCESS_CONTROL_GRANT:
                if (!held.exchange(true)) ++grant_number;
                event("callback", "GRANT"); break;
            case MONITORING_ACCESS_CONTROL_DENY: held = false; event("callback", "DENY"); break;
            case MONITORING_ACCESS_CONTROL_LOSS: held = false; event("callback", "LOSS"); break;
            case MONITORING_ACCESS_CONTROL_REQUEST: event("callback", "REQUEST"); break;
            default: break;
        }
    });
    if (!sdk.open_connection(ip, std::atoi(port)) || down) {
        event("disconnect", "open_connection failed"); return 2;
    }
    SYSTEM_VERSION system{};
    if (!sdk.get_system_version(&system) || !system._szController[0] || down) {
        event("disconnect", "DRCF version unavailable"); sdk.close_connection(); return 3;
    }
    event("connected", system._szController);
    const auto opened = now_ms();
    long long heartbeat = 0;
    while (!down) {
        auto now = now_ms(), frame = last_frame.load();
        if (now - (frame ? frame : opened) > 6000) {
            event("disconnect", "No fresh SDK monitoring data"); break;
        }
        if (now - heartbeat >= 500) {
            const auto mode = sdk.get_robot_mode();
            const char* mode_name = mode == ROBOT_MODE_AUTONOMOUS ? "AUTO" : mode == ROBOT_MODE_MANUAL ? "MANUAL" : "OTHER";
            char status[96];
            std::snprintf(status, sizeof(status), "%s %s %s", state_name(sdk.get_robot_state()), mode_name,
                          sdk.get_robot_system() == ROBOT_SYSTEM_REAL ? "REAL" : "OTHER");
            event(initialized && frame && now - frame <= 2000 ? "ready" : "initializing", status);
            heartbeat = now;
        }
        pollfd input{STDIN_FILENO, POLLIN, 0};
        if (poll(&input, 1, 100) <= 0) continue;
        char command[256];
        if (!std::fgets(command, sizeof(command), stdin)) break;
        if (!std::strncmp(command, "mode ", 5)) { set_operation_mode(sdk, command); continue; }
        if (!std::strncmp(command, "servo ", 6)) { servo_on(sdk, command); continue; }
        if (!std::strncmp(command, "move ", 5)) { move_pose(sdk, command); continue; }
        if (std::strcmp(command, "force\n")) continue;
        const auto state = sdk.get_robot_state();
        if (held) { event("already", "GRANT"); continue; }
        if (down || !initialized || !frame || now_ms() - frame > 2000 ||
            (state != STATE_STANDBY && state != STATE_SAFE_OFF)) {
            event("refused", "SDK not ready or robot not stopped"); continue;
        }
        if (!sdk.manage_access_control(MANAGE_ACCESS_CONTROL_FORCE_REQUEST))
            event("refused", "SDK did not send the request");
    }
    sdk.close_connection();
}
