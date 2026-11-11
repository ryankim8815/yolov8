"""Build a camera-only worker against the maintained native macOS SDK."""
import os
import subprocess
import tempfile
from pathlib import Path


def stage_runtime():
    directory=tempfile.TemporaryDirectory(prefix="vision-rs-runtime-",dir="/private/tmp",ignore_cleanup_errors=True)
    try:
        prefix=Path(os.getenv('YOLO_REALSENSE_PREFIX','/opt/homebrew'))
        if not (prefix/'include/librealsense2/rs.hpp').is_file():
            raise RuntimeError('macOS RealSense SDK가 필요합니다: brew install librealsense')
        source=Path(__file__).resolve().parents[1]/'scripts/realsense-capture.cpp'
        result=subprocess.run(['/usr/bin/clang++','-std=c++17','-O2',str(source),'-I'+str(prefix/'include'),
                               '-L'+str(prefix/'lib'),'-lrealsense2','-Wl,-rpath,'+str(prefix/'lib'),
                               '-o',str(Path(directory.name)/'capture')],capture_output=True,text=True,timeout=60)
        if result.returncode:raise RuntimeError('RealSense 센서 작업자 빌드 실패: '+result.stderr[-1500:])
        return directory
    except BaseException:
        directory.cleanup();raise
