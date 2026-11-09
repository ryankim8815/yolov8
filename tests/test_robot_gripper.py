import shutil
import subprocess
from pathlib import Path

import pytest

from app.robot_gripper import CalibrationInput, Gripper
from app.store import DomainError


def test_serial_wire_format_and_readback(tmp_path):
    compiler = shutil.which("c++")
    if not compiler:
        pytest.skip("C++ compiler not installed")
    binary = tmp_path / "serial"
    subprocess.run([compiler,"-std=c++17",str(Path(__file__).with_name("rh_p12_serial.cpp")),"-o",binary],check=True)
    subprocess.run([binary],check=True,timeout=10)


def test_device_table_rounds_open_between_measured_points(tmp_path):
    hand = Gripper(tmp_path)
    points = [{"position":100,"width_mm":80}, {"position":200,"width_mm":49}, {"position":450,"width_mm":10}]
    hand.save(CalibrationInput(revision=None,points=points[::-1]))
    assert hand.position_for(50) == 196
    assert hand.width_at(196) >= 50 > hand.width_at(197)
    assert hand.position_for(49) == 200
    assert Gripper(tmp_path).table == hand.table
    with pytest.raises(DomainError,match="교시 범위"):
        hand.position_for(90)
    with pytest.raises(ValueError):
        CalibrationInput(revision=None,points=[points[0],points[0]])


def test_profile_contact_hold_and_empty_grip_serial(tmp_path):
    compiler=shutil.which("c++")
    if not compiler:pytest.skip("C++ compiler not installed")
    binary=tmp_path/'scenario-serial'
    subprocess.run([compiler,'-std=c++17',str(Path(__file__).with_name('rh_p12_scenario.cpp')),'-o',binary],check=True)
    subprocess.run([binary],check=True,timeout=10)


def test_async_worker_joint_only_stop_and_control_loss(tmp_path):
    compiler=shutil.which('c++')
    if not compiler:pytest.skip('C++ compiler not installed')
    binary=tmp_path/'scenario-worker'
    subprocess.run([compiler,'-std=c++17',str(Path(__file__).with_name('scenario_worker.cpp')),'-o',binary],check=True)
    subprocess.run([binary],check=True,timeout=10)
