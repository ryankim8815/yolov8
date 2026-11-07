import asyncio
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.packing import Packing
from app.store import Store
from app.voice import Voice
from app.voice_commands import INTENTS, normalized, packing_answer


class VoiceCommandsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(directory.name)
        self.addCleanup(self.store.close)
        self.packing = Packing(self.store)

    def test_queries_mutations_and_exact_phrases(self):
        self.assertIn("생수 4개", packing_answer(self.packing, "query-stock").text)
        self.assertIn("123번", packing_answer(self.packing, "query-order").text)
        for phrase, paused in [("멈춰!", True), ("피킹 재개해 줘.", False)]:
            packing_answer(self.packing, INTENTS[normalized(phrase)])
            self.assertEqual(self.packing.order(123)["paused"], paused)
        self.assertNotIn(normalized("피킹 재개하지 마"), INTENTS)
        self.assertEqual(INTENTS[normalized("응, 주문 내역 알려줘.")], "query-order")
        self.assertEqual(INTENTS[normalized("네, 재고 조회해 줘.")], "query-stock")
        self.assertNotIn(normalized("응, 주문 확정"), INTENTS)
        self.assertNotIn(normalized("최고 알려줘"), INTENTS)
        self.assertNotIn(normalized("이건 주문 확정 아니야"), INTENTS)
        self.assertTrue(packing_answer(self.packing, "cmd-order").confirm)
        self.assertIn("취소했습니다", packing_answer(self.packing, "discard-order", confirming=True).text)
        self.assertIn("없습니다", packing_answer(self.packing, "confirm-order").text)
        for _ in range(2):
            packing_answer(self.packing, "confirm-order", confirming=True)
        self.assertFalse(packing_answer(self.packing, "cmd-order").confirm)
        self.assertEqual(len([e for e in self.store.list("packing_event") if "#124" in e["message"]]), 1)


class HelperTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(directory.name)
        self.addCleanup(self.store.close)
        self.packing = Packing(self.store)
        self.script = Path(directory.name) / "helper.py"

    async def launch(self, body, *, barge_in=False):
        self.script.write_text(body)
        voice = Voice(self.packing, True, (sys.executable, "-u", str(self.script)), barge_in=barge_in)
        await voice.start()
        self.addAsyncCleanup(voice.stop)
        return voice

    async def test_full_protocol_duplicate_echo_late_confirmation_and_timeout(self):
        voice = await self.launch("""
import sys, json
session = ""
sessions = 0
for line in sys.stdin:
    c = json.loads(line)
    if c["session"] != session:
        old = session
        session = c["session"]
        sessions += 1
    def emit(event, text="", turn=c["turn"], sid=session):
        print(json.dumps(dict(event=event, text=text, turn=turn, session=sid)), flush=True)
    if c["action"] == "listen":
        emit("listening")
        if sessions == 2:
            emit("final", "주문 확정", sid=old)
        phrases = {1: ["예시 주문", ""], 2: ["주문 확정", "예시 주문", "주문 확정", "대화 종료"]}
        phrase = phrases[sessions][c["turn"] - 1]
        emit("final" if phrase else "timeout", phrase)
        emit("final", "멈춰")  # retransmitted final after the first one
    else:
        emit("final", "피킹 시작해줘")  # speaker output during TTS
        emit("spoken")
        emit("spoken")  # stale after next listen
""")
        async def wait_idle():
            async with asyncio.timeout(4):
                while voice.state != "idle":
                    await asyncio.sleep(.01)
        first, duplicate = await asyncio.gather(voice.wake(), voice.wake())
        self.assertEqual(first["state"], duplicate["state"])
        await wait_idle()
        self.assertFalse(voice.confirming)
        self.assertEqual(len(self.store.list("packing_order")), 1)
        await voice.wake()
        await wait_idle()
        self.assertEqual(voice.reply, "대화를 종료했습니다.")
        self.assertEqual(len(self.store.list("packing_order")), 2)
        self.assertFalse(self.packing.order(123)["paused"])
        self.assertEqual(len([e for e in self.store.list("packing_event") if "#124" in e["message"]]), 1)

    async def test_interrupt_owns_next_turn_and_rejects_old_playback_events(self):
        voice = await self.launch("""
import json, sys
def send(c, event, text="", offset=0):
    print(json.dumps(dict(session=c["session"], turn=c["turn"]+offset, event=event, text=text)))
first = json.loads(input())
send(first, "listening")
send(first, "final", "예시 주문")
reply = json.loads(input())
assert reply["action"] == "speak_listen"
send(reply, "interrupted")                 # microphone and playback are not ready
send(reply, "playback_started")
send(reply, "final", "주문 확정")          # still reading the confirmation prompt
send(reply, "interrupted")
send(reply, "spoken")                     # late playback callbacks
send(reply, "reply_finished")
send(reply, "final", "주문 확정")          # stale turn
send(reply, "final", "취소", 1)            # operator who interrupted
next_reply = json.loads(input())
assert next_reply["action"] == "speak_listen" and next_reply["turn"] == reply["turn"] + 1
send(next_reply, "playback_started")
send(next_reply, "reply_finished")
send(next_reply, "interrupted")           # same turn can hand off only once
send(next_reply, "timeout", offset=1)
for line in sys.stdin: raise AssertionError(line)  # no redundant listen command
""", barge_in=True)
        await voice.wake()
        async with asyncio.timeout(4):
            while voice.state != "idle":
                await asyncio.sleep(.01)
        self.assertTrue(voice.status()["barge_in"])
        self.assertEqual(voice.status()["last_playback"], "finished")
        self.assertEqual(voice.transcript, "취소")
        self.assertIn("취소했습니다", voice.reply)
        self.assertEqual(voice.turn, 3)
        self.assertEqual(len(self.store.list("packing_order")), 1)

    async def test_crash_during_pending_order_recovery_and_eof(self):
        voice = await self.launch("""
import json, sys
c = json.loads(input())
for event, text in [("listening",""), ("final","예시 주문")]:
    print(json.dumps(dict(event=event, text=text, session=c["session"], turn=c["turn"])))
input()
""")
        await voice.wake()
        await asyncio.wait_for(voice.reader, 3)
        self.assertEqual(voice.state, "error")
        self.assertFalse(voice.confirming)
        self.script.write_text('import sys\nfor line in sys.stdin: pass\n')
        await voice.wake()
        child = voice.process
        await voice.stop()
        self.assertIsNotNone(child.returncode)
        self.assertEqual(len(self.store.list("packing_order")), 1)

    async def test_stop_during_reply_discards_confirmation_and_late_events(self):
        for barge_in in (False, True):
            with self.subTest(barge_in=barge_in):
                voice = await self.launch("""
import json, sys
c = json.loads(input())
def emit(event, text="", offset=0):
    print(json.dumps(dict(session=c["session"], turn=c["turn"] + offset, event=event, text=text)))
emit("listening")
emit("final", "예시 주문")
c = json.loads(input())
if c["action"] == "speak_listen": emit("playback_started")
sys.stdin.read()  # stop closes the helper connection during playback
emit("interrupted" if c["action"] == "speak_listen" else "spoken")
emit("final", "주문 확정", 1)
""", barge_in=barge_in)
                await voice.wake()
                async with asyncio.timeout(3):
                    while voice.state != "speaking":
                        await asyncio.sleep(.01)
                self.assertTrue(voice.confirming)
                child = voice.process
                result = await voice.stop(session_only=True)
                await voice.reader
                self.assertEqual(child.returncode, 0)
                self.assertFalse(voice.confirming)
                self.assertEqual(result, voice.status())
                self.assertEqual(result["state"], "idle")
                self.assertFalse(result["can_stop"])
                self.assertEqual(len(self.store.list("packing_order")), 1)

    async def test_stop_while_processing_does_not_play_the_late_answer(self):
        voice = await self.launch("""
import json, sys
c = json.loads(input())
for event, text in [("listening", ""), ("final", "예시 주문")]:
    print(json.dumps(dict(session=c["session"], turn=c["turn"], event=event, text=text)))
assert sys.stdin.read() == ""
""")
        started, release = threading.Event(), threading.Event()
        def slow_answer(*args, **kwargs):
            started.set()
            if not release.wait(5):
                raise TimeoutError("packing operation was not released")
            return packing_answer(*args, **kwargs)
        with patch("app.voice.packing_answer", slow_answer):
            await voice.wake()
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 3))
                result = await asyncio.wait_for(voice.stop(session_only=True), 2)
                self.assertEqual(result["state"], "idle")
            finally:
                release.set()
            await voice.reader
        self.assertEqual(voice.status(), result)
        self.assertFalse(voice.confirming)
        self.assertEqual(voice.reply, "")


class VoiceAPITests(unittest.TestCase):
    def test_stop_releases_listening_helper_and_wake_starts_a_new_session(self):
        with tempfile.TemporaryDirectory() as state:
            helper = Path(state) / "listen.py"
            helper.write_text("""
import json, sys
c = json.loads(input())
def emit(event, text=""):
    print(json.dumps(dict(session=c["session"], turn=c["turn"], event=event, text=text)))
emit("listening")
sys.stdin.read()
emit("final", "멈춰")
""")
            def make_voice(packing, enabled, **options):
                return Voice(packing, enabled, (sys.executable, "-u", str(helper)), **options)
            settings = Settings(camera_autostart=False, voice_enabled=True)
            with patch("app.main.Voice", make_voice), TestClient(create_app(settings, state_root=state)) as client:
                voice = client.app.state.voice
                self.assertFalse(client.post("/api/voice/stop").json()["can_stop"])
                for _ in range(2):
                    self.assertTrue(client.post("/api/voice/wake").json()["can_stop"])
                    deadline = time.monotonic() + 3
                    while client.get("/api/voice/status").json()["state"] != "listening":
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(.01)
                    child = voice.process
                    self.assertEqual(client.post("/api/voice/stop", headers={"Sec-Fetch-Site": "cross-site"}).status_code, 403)
                    stopped = client.post("/api/voice/stop").json()
                    self.assertEqual(child.returncode, 0)
                    self.assertEqual(stopped["state"], "idle")
                    self.assertEqual(client.post("/api/voice/stop").json(), stopped)
                    self.assertFalse(voice.packing.order(123)["paused"])

    def test_barge_in_environment(self):
        with patch.dict("os.environ", {}, clear=True):
            self.assertFalse(Settings.from_env().voice_barge_in)
        for value, expected in [("1", True), ("0", False)]:
            with patch.dict("os.environ", YOLO_VOICE_BARGE_IN=value):
                self.assertEqual(Settings.from_env().voice_barge_in, expected)
        with patch.dict("os.environ", YOLO_VOICE_BARGE_IN="yes"):
            with self.assertRaisesRegex(ValueError, "YOLO_VOICE_BARGE_IN"):
                Settings.from_env()

    def test_default_and_missing_helper_do_not_stop_server(self):
        with tempfile.TemporaryDirectory() as state:
            settings = Settings(camera_autostart=False)
            with TestClient(create_app(settings, state_root=state)) as client:
                self.assertEqual(client.get("/api/voice/status").json()["state"], "disabled")
                self.assertEqual(client.post("/api/voice/stop").json()["state"], "disabled")
                self.assertEqual(client.post("/api/voice/wake").status_code, 503)
                self.assertEqual(client.post("/api/packing/command", json={"action": "query-stock"}).status_code, 200)
            missing = lambda packing, enabled, **options: Voice(packing, enabled, (str(Path(state)/"missing"),), **options)
            with patch("app.main.Voice", missing), TestClient(create_app(replace(settings, voice_enabled=True), state_root=state)) as client:
                self.assertIn("build_voice", client.get("/api/voice/status").json()["error"])
                self.assertEqual(client.post("/api/voice/wake").status_code, 503)
                self.assertEqual(client.get("/healthz").status_code, 200)
