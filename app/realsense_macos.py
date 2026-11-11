"""Ask macOS to elevate only one camera capture worker, for its connection lifetime."""
import json
import shlex
import socket
import subprocess
import tempfile
import time
from pathlib import Path

from .realsense_transport import receive_frame


class MacUSB:
    def __init__(self, stop=None):
        self.connection = None
        self.process = None
        self.runtime = None
        self.last_diagnostic = ""
        self.stop = stop
        self.directory = tempfile.TemporaryDirectory(prefix="vision-rs-", dir="/private/tmp")
        self.diagnostic = tempfile.TemporaryFile()
        listener = socket.socket(socket.AF_UNIX)
        try:
            address = str(Path(self.directory.name) / "frames.sock")
            listener.bind(address)
            listener.listen(1)
            listener.settimeout(.2)
            from .realsense_runtime import stage_runtime
            self.runtime=stage_runtime();runtime=Path(self.runtime.name)
            command = shlex.join([str(runtime/'capture'), "--socket", address])
            self.process = subprocess.Popen(["/usr/bin/osascript", "-e",
                "do shell script " + json.dumps(command) + " with administrator privileges"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=self.diagnostic)
            deadline = time.monotonic() + 120
            while self.connection is None:
                if stop is not None and stop.is_set():raise RuntimeError("RealSense 연결을 취소했습니다.")
                if self.process.poll() is not None:
                    detail = self.diagnostics()
                    reason="RealSense 관리자 인증이 취소됐습니다." if "(-128)" in detail else "RealSense USB 작업자를 시작하지 못했습니다."
                    raise RuntimeError(reason + " " + detail[-700:])
                if time.monotonic() > deadline:raise RuntimeError("RealSense 관리자 인증 대기 시간이 초과되었습니다.")
                try:self.connection, _ = listener.accept()
                except TimeoutError:pass
            self.first = receive_frame(self.connection, 15, stop)
        except BaseException as exc:
            self.close()
            if isinstance(exc,RuntimeError) and self.last_diagnostic:
                raise RuntimeError(str(exc) + " " + self.last_diagnostic[-1500:]) from exc
            raise
        finally:
            listener.close()

    def diagnostics(self):
        if self.diagnostic.closed:return self.last_diagnostic
        self.diagnostic.seek(0,2)
        self.diagnostic.seek(max(0,self.diagnostic.tell()-6000))
        return self.diagnostic.read().decode(errors="replace")

    def read(self):
        if self.first is not None:
            value, self.first = self.first, None
            return value
        try:return receive_frame(self.connection, 3, self.stop)
        except RuntimeError as exc:
            from .capture import CameraPermissionError
            raise CameraPermissionError(str(exc)) from exc

    def close(self):
        if self.connection is not None:
            with self.connection:
                try:self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:pass
            self.connection = None
        if self.process is not None:
            # EOF makes the root worker close the sensor; never leave it capturing.
            try:self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:self.process.wait(timeout=1)
                except subprocess.TimeoutExpired:self.process.kill();self.process.wait(timeout=1)
            self.process = None
        self.directory.cleanup()
        self.last_diagnostic=self.diagnostics()
        self.diagnostic.close()
        if self.runtime is not None:self.runtime.cleanup();self.runtime=None
