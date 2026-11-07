"""One-shot E0509 SDK check on the Mac host. Does not require Docker at runtime."""
import argparse
import ipaddress
import os
import re
import socket
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache/e0509-host-sdk"


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--request-access", action="store_true", help="정지 상태에서 일반 제어권을 한 번 요청한 뒤 종료")
    mode.add_argument("--force-request-access", action="store_true",
                      help="정지 상태에서 제어권을 이 SDK 세션으로 강제 인계 요청하고 결과 확인 후 연결 종료")
    mode.add_argument("--sdk-version", action="store_true", help="로봇에 접속하지 않고 SDK 버전만 확인")
    args = parser.parse_args()
    if not (CACHE / "blink").is_file() or not (CACHE / "linux/usr/local/bin/check-e0509").is_file():
        sys.exit("먼저 bash rosbridge/host-sdk/prepare.sh 를 실행하세요.")
    keys = ("ROBOT_IP", "ROBOT_PORT", "ROBOT_LAN_INTERFACE")
    cfg = {}
    # Load only the three LAN settings. Do not source or forward the rest of .env.
    for f in (ROOT / ".env.example", ROOT / ".env"):
        if f.is_file():
            for line in f.read_text().splitlines():
                k, _, v = line.partition("=")
                if k in keys:
                    cfg[k] = v.strip().strip("\"'")
    cfg.update({k: os.environ[k] for k in keys if k in os.environ})
    opts = []
    if args.sdk_version:
        opts.append("--sdk-version")
    else:
        ip = str(ipaddress.IPv4Address(cfg["ROBOT_IP"]))
        port = int(cfg["ROBOT_PORT"])
        if not 1 <= port <= 65535:
            sys.exit("ROBOT_PORT 값이 유효하지 않습니다.")
        route = subprocess.run(["/sbin/route", "-n", "get", ip], capture_output=True, text=True, check=True)
        iface = re.search(r"^\s*interface:\s*(\S+)", route.stdout, re.MULTILINE)
        if not iface or iface[1] != cfg["ROBOT_LAN_INTERFACE"]:
            sys.exit(f"{ip} 경로가 ROBOT_LAN_INTERFACE={cfg['ROBOT_LAN_INTERFACE']} 와 다릅니다.")
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect((ip, port))  # Route lookup; does not send a datagram.
            print(f"Mac {iface[1]}: {sock.getsockname()[0]} → {ip}:{port}", flush=True)
        if args.request_access:
            opts.append("--request-access")
        elif args.force_request_access:
            opts.append("--force-request-access")
    env = dict(BLINK_OVERLAYS=str(CACHE / "linux"), LD_LIBRARY_PATH="/opt/doosan/lib:/lib/x86_64-linux-gnu",
               PATH="/usr/bin:/bin", LANG="C", **{k: cfg[k] for k in keys[:2]})
    try:
        return subprocess.run([str(CACHE / "blink"), "-m", "-L", "/dev/null",
                               "/usr/local/bin/check-e0509", *opts], env=env, timeout=25).returncode
    except subprocess.TimeoutExpired:
        sys.exit("SDK 진단 시간 초과. 검사기를 종료했습니다.")


if __name__ == "__main__":
    sys.exit(main())
