// Query the configured DRCF endpoint without requesting authority, enabling the servo or moving.
#include "DRFLEx.h"
#include <atomic>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iostream>

static std::atomic<bool> disconnected{false};

int main(int argc, char **argv) {
    DRAFramework::CDRFLEx controller;
    if (argc == 2 && std::strcmp(argv[1], "--sdk-version") == 0) {
        std::cout << controller.get_library_version() << "\n";
        return 0;
    }
    if (argc != 1) return 1;
    std::cout << "DRFL SDK: " << controller.get_library_version() << std::endl;
    const char* host = std::getenv("ROBOT_IP");
    const char* port_text = std::getenv("ROBOT_PORT");
    if (!host || !*host || !port_text) {
        std::cerr << "Set ROBOT_IP and ROBOT_PORT.\n";
        return 1;
    }
    unsigned int port = 0;
    const char* end = port_text + std::strlen(port_text);
    const auto parsed = std::from_chars(port_text, end, port);
    if (parsed.ec != std::errc{} || parsed.ptr != end || port == 0 || port > 65535) {
        std::cerr << "Invalid ROBOT_PORT.\n";
        return 1;
    }
    controller.set_on_disconnected([] { disconnected = true; });
    const bool opened = controller.open_connection(host, port);
    if (disconnected) {
        std::cerr << "SDK disconnected while opening " << host << ":" << port << "\n";
        return 2;
    }
    if (!opened) {
        std::cerr << "DRFL open_connection failed for " << host << ":" << port << "\n";
        return 2;
    }
    SYSTEM_VERSION version{};
    if (!controller.get_system_version(&version) || !version._szController[0] || disconnected) {
        std::cerr << "DRCF version unavailable.\n";
        controller.close_connection();
        return 3;
    }
    std::cout << "DRCF version: " << version._szController << "\n";
    const auto pose = controller.get_current_posj();
    if (!pose || disconnected) {
        std::cerr << "Joint positions unavailable.\n";
        controller.close_connection();
        return 4;
    }
    for (const float angle : pose->_fPosition) {
        if (!std::isfinite(angle) || disconnected) {
            std::cerr << "Invalid joint sample or disconnected SDK session.\n";
            return 4;
        }
    }
    std::cout << "Joint positions (degrees):";
    for (const float angle : pose->_fPosition) std::cout << " " << angle;
    std::cout << "\n";
    controller.close_connection();
}
